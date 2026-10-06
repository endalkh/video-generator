import type { AvailableModel } from "../../domain/ports/generator.port.js";
import { minResolution, type VideoResolution } from "../../domain/project/project.model.js";
import { log } from "../../util/log.js";
import { isTransientError, sleep, withRetry } from "../../util/retry.js";

/** Model ids for inference.sh apps are "inference.sh/<namespace>/<app>", e.g. "inference.sh/bytedance/seedance-2-5". */
export const INFERENCE_SH_PREFIX = "inference.sh/";

export const isInferenceShModel = (model: string) => model.startsWith(INFERENCE_SH_PREFIX);

/**
 * Video apps on inference.sh that this app knows how to drive. `id` is what the Models page shows (after the prefix).
 * - seedance: animates the scene picture (8 s clips, fitted to the scene like Veo); `maxResolution` caps the request.
 * - kling-v3: Kling V3 animates the scene picture (first frame) with its own sound, up to real 4K, 3-15 s, so
 *   each clip can be exactly as long as its scene. Billed per second.
 * - avatar: Kling Avatar animates the scene picture *to the scene's own audio* (lips follow the song/voice),
 *   so the clip is exactly as long as the scene. Standard $0.056/s, Pro $0.112/s (more body movement).
 * - wan / flux / minimax / minimax-max / grok: animate the scene picture (first frame), as long as the scene
 *   within each model's limits (longer scenes loop/stretch like a Veo clip).
 * - omni: Gemini Omni Flash animates the scene picture; it picks the clip length itself (no duration input).
 */
export const INFERENCE_SH_VIDEO_APPS = [
  { id: "bytedance/seedance-2-5", app: "bytedance/seedance-2-5", kind: "seedance", maxResolution: "1080p", displayName: "Seedance 2.5 (inference.sh)" },
  { id: "klingai/video-v3", app: "klingai/video-v3", kind: "kling-v3", displayName: "Kling V3 — animates the scene picture, real 4K, clip as long as the scene (inference.sh)" },
  { id: "klingai/avatar", app: "klingai/avatar", kind: "avatar", mode: "std", displayName: "Kling Avatar · standard — sings/speaks the scene's audio (inference.sh)" },
  { id: "klingai/avatar-pro", app: "klingai/avatar", kind: "avatar", mode: "pro", displayName: "Kling Avatar · pro — more natural movement (inference.sh)" },
  { id: "bytedance/seedance-2-0-fast", app: "bytedance/seedance-2-0-fast", kind: "seedance", maxResolution: "720p", displayName: "Seedance 2.0 Fast — cheaper and quicker, up to 720p (inference.sh)" },
  { id: "alibaba/wan-2-7-i2v", app: "alibaba/wan-2-7-i2v", kind: "wan", displayName: "Wan 2.7 — animates the scene picture, up to 1080p, 2-15 s (inference.sh)" },
  { id: "bfl/flux-3-video", app: "bfl/flux-3-video", kind: "flux", displayName: "FLUX 3 Video — animates the scene picture with sound, up to 1080p, 5-20 s (inference.sh)" },
  { id: "minimax/h3", app: "minimax/h3", kind: "minimax", displayName: "MiniMax H3 — animates the scene picture with sound, 768p or 2K, 5-10 s (inference.sh)" },
  { id: "falai/minimax-h3-max", app: "falai/minimax-h3-max", kind: "minimax-max", displayName: "MiniMax H3 Max — follows the prompt more closely, 768p, 5-15 s (inference.sh)" },
  { id: "google/gemini-omni-flash", app: "google/gemini-omni-flash", kind: "omni", displayName: "Gemini Omni Flash — animates the scene picture with sound (inference.sh)" },
  { id: "xai/grok-imagine-video-1-5", app: "xai/grok-imagine-video-1-5", kind: "grok", displayName: "Grok Imagine Video 1.5 — animates the scene picture with sound, up to 1080p, 1-15 s (inference.sh)" },
] as const;

/** Whole seconds covering the scene (8 s when unknown), within a model's limits. */
const sceneSeconds = (durationSec: number | undefined, min: number, max: number) => Math.min(max, Math.max(min, Math.ceil(durationSec ?? CLIP_SECONDS)));

/** Models that animate to the scene's audio (they need the audio step to be done). */
export const isAudioDrivenModel = (model: string) => INFERENCE_SH_VIDEO_APPS.some((a) => a.kind === "avatar" && INFERENCE_SH_PREFIX + a.id === model);

/** Clip length; the same 8 s as Veo, so the clips step fits/loops it to each scene like a Veo clip. */
const CLIP_SECONDS = 8;

export interface InferenceShVideoOptions {
  model: string;
  still: Buffer;
  aspectRatio: string;
  label: string;
  character?: Buffer;
  mime: (b: Buffer) => string;
  /** The scene's own audio (needed by Kling Avatar). */
  audio?: Buffer;
  /** How long the scene is on screen (seconds); Kling V3 makes the clip that long (3-15 s). */
  durationSec?: number;
  /** Wanted resolution; Seedance makes at most 1080p (the final render scales it up). */
  resolution?: VideoResolution;
  /** A task started earlier for this scene: finish/download it instead of paying for a new one. */
  resumeTaskId?: string;
  /** Called as soon as a new task exists, so the caller can remember it (survives a failed download or restart). */
  onTaskStarted?: (taskId: string) => Promise<void> | void;
}

/** Image input before upload: replaced by an inference.sh file URI in `video()`. */
export interface PendingFile {
  bytes: Buffer;
  contentType: string;
}

type Status = "done" | "failed" | "cancelled" | "running";

/** inference.sh task statuses arrive as numbers (10/11/12) or strings. */
function statusOf(s: unknown): Status {
  const v = typeof s === "string" ? s.toLowerCase() : s;
  if (v === 10 || v === "completed") return "done";
  if (v === 11 || v === "failed") return "failed";
  if (v === 12 || v === "cancelled") return "cancelled";
  return "running";
}

export class InferenceShError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Runs video apps (Seedance) on inference.sh (https://inference.sh) with an INFERENCE_API_KEY, over its REST API
 * (the @inferencesh/sdk ESM build doesn't load in plain Node).
 */
export class InferenceShVideo {
  private readonly apiKey: string;

  constructor(
    apiKey = process.env.INFERENCE_API_KEY,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly opts: { baseUrl?: string; pollMs?: number; timeoutMs?: number; downloadRetries?: number; retryDelayMs?: number } = {},
  ) {
    if (!apiKey) throw new Error("INFERENCE_API_KEY is not set. Add it to .env to use inference.sh video models.");
    this.apiKey = apiKey;
  }

  listModels(): AvailableModel[] {
    return INFERENCE_SH_VIDEO_APPS.map((a) => ({ id: INFERENCE_SH_PREFIX + a.id, displayName: a.displayName }));
  }

  /**
   * Seedance input. With a character sheet: character + scene picture as reference images (named @Image1/@Image2
   * in the prompt) so the character stays the same across clips. Without one: the scene picture is the first frame.
   */
  static input(prompt: string, opts: InferenceShVideoOptions): { app: string; input: Record<string, unknown> } {
    const id = opts.model.slice(INFERENCE_SH_PREFIX.length);
    const def = INFERENCE_SH_VIDEO_APPS.find((a) => a.id === id);
    if (!def) throw new Error(`Unknown inference.sh video app "${id}" (known: ${INFERENCE_SH_VIDEO_APPS.map((a) => a.id).join(", ")})`);
    const app = def.app;
    const file = (b: Buffer): PendingFile => ({ bytes: b, contentType: opts.mime(b) });
    if (def.kind === "kling-v3") {
      return {
        app,
        input: {
          // The scene picture (drawn from the character sheet) is the first frame, so the character stays the same.
          image: file(opts.still),
          prompt: prompt.slice(0, 3000),
          sound: true,
          multi_shot: false, // one continuous shot per scene
          resolution: opts.resolution ?? "720p",
          aspect_ratio: opts.aspectRatio,
          // Billed per second: as long as the scene (rounded up), within Kling's 3-15 s; longer scenes loop/stretch.
          duration: Math.min(15, Math.max(3, Math.ceil(opts.durationSec ?? CLIP_SECONDS))),
        },
      };
    }
    if (def.kind === "avatar") {
      if (!opts.audio) throw new Error(`${def.displayName} animates to each scene's audio, but this scene has none (make the audio first; "the character speaks" mode has no separate audio)`);
      return {
        app,
        input: {
          // The scene picture is the face/character; the clip follows this scene's piece of the song or voice.
          image: file(opts.still),
          audio: { bytes: opts.audio, contentType: "audio/mpeg" } satisfies PendingFile,
          prompt: `Lively, cheerful children's animation: the character sings or speaks along to the audio with big friendly expressions and gentle movement, staying in this scene. ${prompt}`.slice(0, 2500),
          mode: def.mode,
          aspect_ratio: opts.aspectRatio,
        },
      };
    }
    const wanted = opts.resolution ?? "720p";
    const prompt3k = prompt.slice(0, 3000);
    // Picture-animating models: the scene picture (drawn from the character sheet) is the first frame, so the
    // character stays the same; the clip keeps the picture's aspect ratio (already the project's).
    switch (def.kind) {
      case "wan":
        return { app, input: { prompt: prompt3k, first_frame: file(opts.still), resolution: wanted === "720p" ? "720P" : "1080P", duration: sceneSeconds(opts.durationSec, 2, 15), watermark: false } };
      case "flux":
        return { app, input: { prompt: prompt3k, image: file(opts.still), resolution: wanted === "720p" ? "hd" : "fhd", duration: sceneSeconds(opts.durationSec, 5, 20), aspect_ratio: "auto", generate_audio: true } };
      case "minimax":
        return { app, input: { prompt: prompt3k, image: file(opts.still), resolution: wanted === "720p" ? "768P" : "2K", duration: sceneSeconds(opts.durationSec, 5, 10), ratio: "adaptive" } };
      case "minimax-max":
        return { app, input: { prompt: prompt3k, image: file(opts.still), resolution: "768P", duration: sceneSeconds(opts.durationSec, 5, 15), aspect_ratio: "adaptive" } };
      case "omni":
        return { app, input: { prompt: prompt3k, image: file(opts.still), aspect_ratio: opts.aspectRatio } };
      case "grok":
        return { app, input: { prompt: prompt3k, image: file(opts.still), resolution: minResolution(wanted, "1080p"), duration: sceneSeconds(opts.durationSec, 1, 15), generate_audio: true } };
    }
    const common = {
      resolution: minResolution(wanted, def.maxResolution),
      duration: CLIP_SECONDS,
      generate_audio: true,
      watermark: false,
      // Only Seedance 2.5 has an output format choice.
      ...(def.id === "bytedance/seedance-2-5" ? { output_format: "mp4" } : {}),
    };
    if (opts.character) {
      return {
        app,
        input: {
          ...common,
          prompt: `@Image1 is the main character's reference sheet: keep the character looking exactly the same. @Image2 is this scene's picture: animate this scene.\n\n${prompt}`,
          reference_images: [file(opts.character), file(opts.still)],
          ratio: opts.aspectRatio,
          // No task_type: any value but "auto" makes the inference.sh app crash
          // ("Tasks.create() got an unexpected keyword argument 'omni_reference_task_type'").
        },
      };
    }
    // First-frame mode needs ratio "adaptive" (taken from the picture, which already has the project's ratio).
    return { app, input: { ...common, prompt, image: file(opts.still), ratio: "adaptive" } };
  }

  async video(prompt: string, opts: InferenceShVideoOptions): Promise<Buffer> {
    const { label } = opts;
    const { app, input } = InferenceShVideo.input(prompt, opts);
    if (opts.resumeTaskId) {
      const prev = await this.api<{ status?: unknown }>("GET", `/tasks/${opts.resumeTaskId}/status`).catch((err: unknown) => {
        if ((err as InferenceShError).status === 404) return null; // gone: start a new one
        throw err;
      });
      const st = prev ? statusOf(prev.status) : "cancelled";
      if (st === "done" || st === "running") {
        log.info(`${label}: picking up inference.sh task ${opts.resumeTaskId} (${st === "done" ? "already made, downloading" : "still running"}) instead of making a new video`);
        return this.finish(opts.resumeTaskId, st, label);
      }
      log.info(`${label}: earlier inference.sh task ${opts.resumeTaskId} ${prev ? st : "not found"}; starting a new one`);
    }
    const upload = async (v: unknown): Promise<unknown> => {
      if (Array.isArray(v)) return Promise.all(v.map(upload));
      const f = v as PendingFile;
      return f && typeof f === "object" && Buffer.isBuffer(f.bytes) ? this.upload(f) : v;
    };
    const uploaded = Object.fromEntries(await Promise.all(Object.entries(input).map(async ([k, v]) => [k, await upload(v)] as const)));

    log.debug(`${label}: running ${app} on inference.sh`);
    const created = await this.api<{ id: string; status?: unknown }>("POST", "/apps/run", { app, input: uploaded });
    log.info(`${label}: inference.sh task ${created.id} (${app})`);
    await opts.onTaskStarted?.(created.id);
    return this.finish(created.id, statusOf(created.status), label);
  }

  /** Wait for a task, then download its video (downloads are retried; the task is never re-run here). */
  private async finish(taskId: string, initial: Status, label: string): Promise<Buffer> {
    const created = { id: taskId };
    const started = Date.now();
    const timeoutMs = this.opts.timeoutMs ?? 15 * 60_000;
    let status = initial;
    while (status === "running") {
      if (Date.now() - started > timeoutMs) throw new Error(`${label}: timed out after ${Math.round(timeoutMs / 60_000)} minutes on inference.sh (task ${created.id})`);
      await sleep(this.opts.pollMs ?? 5_000);
      status = statusOf((await this.get<{ status?: unknown }>(`/tasks/${created.id}/status`, label)).status);
    }
    const task = await this.get<{ output?: unknown; error?: string }>(`/tasks/${created.id}`, label);
    if (status !== "done") throw new Error(`${label}: inference.sh task ${created.id} ${status}${task.error ? `: ${task.error}` : ""}`);
    const url = fileUrl(task.output);
    // Grok returns no video (and a notice) when xAI's moderation withholds it.
    const notice = (task.output as { notice?: string } | undefined)?.notice;
    if (!url) throw new Error(`${label}: inference.sh returned no video (task ${created.id})${notice ? ` — ${notice}` : ""}${task.error ? ` (${task.error})` : ""}`);
    // Result files live on inference.sh; send the key only to its own hosts.
    const own = /(^|\.)inference\.sh$/.test(new URL(url).hostname);
    return withRetry(
      async () => {
        const res = await this.fetchImpl(url, own ? { headers: { Authorization: `Bearer ${this.apiKey}` } } : undefined);
        if (!res.ok) throw Object.assign(new Error(`${label}: couldn't download the video from inference.sh (HTTP ${res.status}, task ${created.id}). It's saved on inference.sh: click "Make the clips" again to download it without paying again, or upload the file on the Clips page`), { status: res.status });
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length < 1000) throw Object.assign(new Error(`${label}: the video downloaded from inference.sh is empty (task ${created.id})`), { status: 502 });
        return bytes;
      },
      { label: `${label} download`, retries: this.opts.downloadRetries ?? 4, baseDelayMs: this.opts.retryDelayMs ?? 2_000, shouldRetry: (err) => isTransientError(err) || ((err as { status?: number }).status ?? 0) >= 500 },
    );
  }

  /** GET with retries for dropped connections and 5xx (safe: reading a task never re-runs it). */
  private get<T>(endpoint: string, label: string): Promise<T> {
    return withRetry(() => this.api<T>("GET", endpoint), { label: `${label} status`, retries: this.opts.downloadRetries ?? 4, baseDelayMs: this.opts.retryDelayMs ?? 2_000 });
  }

  /** Create a file record, PUT the bytes to its presigned URL, and return the file URI for app input. */
  private async upload(f: PendingFile): Promise<string> {
    const ext = ({ "audio/mpeg": "mp3" } as Record<string, string>)[f.contentType] ?? f.contentType.split("/")[1] ?? "bin";
    const [file] = await this.api<{ uri: string; upload_url?: string }[]>("POST", "/files", {
      files: [{ uri: "", filename: `${f.contentType.startsWith("audio/") ? "audio" : "image"}.${ext}`, content_type: f.contentType, size: f.bytes.length }],
    });
    if (!file?.upload_url) throw new Error("inference.sh didn't return an upload URL");
    const put = await this.fetchImpl(file.upload_url, { method: "PUT", body: new Uint8Array(f.bytes), headers: { "Content-Type": f.contentType } });
    if (!put.ok) throw new Error(`inference.sh file upload failed (HTTP ${put.status})`);
    return file.uri;
  }

  /** JSON request; unwraps the `{ data }` envelope and turns error bodies into InferenceShError (keeps the HTTP status, e.g. 429). */
  private async api<T>(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.baseUrl ?? "https://api.inference.sh"}${endpoint}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const d = json as { detail?: string; title?: string; message?: string; error?: string } | undefined;
      throw new InferenceShError(res.status, `inference.sh ${method} ${endpoint} failed (HTTP ${res.status}): ${d?.detail ?? d?.message ?? d?.title ?? d?.error ?? text.slice(0, 300)}`);
    }
    const env = json as { data?: T } | undefined;
    return (env && typeof env === "object" && !Array.isArray(env) && "data" in env ? env.data : json) as T;
  }
}

/** Seedance returns `output.video`; a file is either a URL string or an object with `uri`/`url`. */
function fileUrl(output: unknown): string | undefined {
  const o = output as { video?: unknown; videos?: unknown[] } | undefined;
  const f = o?.video ?? o?.videos?.[0];
  if (typeof f === "string") return f;
  const obj = f as { uri?: string; url?: string } | undefined;
  return obj?.uri ?? obj?.url;
}
