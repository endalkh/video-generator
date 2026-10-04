import type { AvailableModel } from "../../domain/ports/generator.port.js";
import { minResolution, type VideoResolution } from "../../domain/project/project.model.js";
import { log } from "../../util/log.js";
import { isTransientError, sleep, withRetry } from "../../util/retry.js";

/** Model ids for inference.sh apps are "inference.sh/<namespace>/<app>", e.g. "inference.sh/bytedance/seedance-2-5". */
export const INFERENCE_SH_PREFIX = "inference.sh/";

export const isInferenceShModel = (model: string) => model.startsWith(INFERENCE_SH_PREFIX);

/** Video apps on inference.sh that this app knows how to drive. */
export const INFERENCE_SH_VIDEO_APPS = [{ app: "bytedance/seedance-2-5", displayName: "Seedance 2.5 (inference.sh)" }] as const;

/** Clip length; the same 8 s as Veo, so the clips step fits/loops it to each scene like a Veo clip. */
const CLIP_SECONDS = 8;

export interface InferenceShVideoOptions {
  model: string;
  still: Buffer;
  aspectRatio: string;
  label: string;
  character?: Buffer;
  mime: (b: Buffer) => string;
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
    return INFERENCE_SH_VIDEO_APPS.map((a) => ({ id: INFERENCE_SH_PREFIX + a.app, displayName: a.displayName }));
  }

  /**
   * Seedance input. With a character sheet: character + scene picture as reference images (named @Image1/@Image2
   * in the prompt) so the character stays the same across clips. Without one: the scene picture is the first frame.
   */
  static input(prompt: string, opts: InferenceShVideoOptions): { app: string; input: Record<string, unknown> } {
    const app = opts.model.slice(INFERENCE_SH_PREFIX.length);
    if (!INFERENCE_SH_VIDEO_APPS.some((a) => a.app === app)) {
      throw new Error(`Unknown inference.sh video app "${app}" (known: ${INFERENCE_SH_VIDEO_APPS.map((a) => a.app).join(", ")})`);
    }
    const file = (b: Buffer): PendingFile => ({ bytes: b, contentType: opts.mime(b) });
    const common = { resolution: minResolution(opts.resolution ?? "720p", "1080p"), duration: CLIP_SECONDS, generate_audio: true, watermark: false, output_format: "mp4" };
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
    if (!url) throw new Error(`${label}: inference.sh returned no video (task ${created.id})${task.error ? ` (${task.error})` : ""}`);
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
    const ext = f.contentType.split("/")[1] ?? "bin";
    const [file] = await this.api<{ uri: string; upload_url?: string }[]>("POST", "/files", {
      files: [{ uri: "", filename: `image.${ext}`, content_type: f.contentType, size: f.bytes.length }],
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
