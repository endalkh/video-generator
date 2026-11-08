import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AvailableModel } from "../../domain/ports/generator.port.js";
import { log } from "../../util/log.js";
import { isTransientError, sleep, withRetry } from "../../util/retry.js";
import { probeDuration, runFfmpeg } from "../media/ffmpeg.js";

/**
 * Runway Dev API (https://docs.dev.runwayml.com): Alibaba Wan 3.0 for song videos. Model ids on the Models page are
 * "runway/<model>" (runway/wan3, runway/wan3_prime). Needs RUNWAYML_API_SECRET.
 *
 * With the scene's audio (its part of the song), the scene picture goes in as a reference image and the audio as a
 * reference audio: Wan makes the character sing that exact recording, mouth in sync (tested: the clip's sound was the
 * same recording). Reference audio is limited to 15 s per clip, so a longer scene is made as several clips, each
 * with its own slice of the audio, joined back together. Billed per second of output (wan3 720p: 10 credits = $0.10).
 */
export const RUNWAY_PREFIX = "runway/";
export const isRunwayModel = (model: string) => model.startsWith(RUNWAY_PREFIX);
export const RUNWAY_MODELS: readonly AvailableModel[] = [
  { id: "runway/wan3", displayName: "Wan 3.0 (Alibaba, via Runway) — sings your song: the scene's audio drives the mouth, ~$0.10/s at 720p" },
  { id: "runway/wan3_prime", displayName: "Wan 3.0 Prime (Alibaba, via Runway) — the same, faster, ~$0.14/s at 720p" },
];
/** Your Runway account makes one generation at a time (tier limit). */
export const RUNWAY_MAX_CONCURRENCY = 1;
/** Longest reference audio Wan 3.0 takes per clip. */
export const WAN_MAX_AUDIO_SEC = 15;

const API = "https://api.dev.runwayml.com";
const VERSION = "2024-11-06";
/** 720p output in the video's shape. */
const RATIOS: Record<string, string> = { "9:16": "720:1280", "16:9": "1280:720", "1:1": "960:960" };

export interface RunwayVideoOptions {
  model: string;
  /** The scene picture (reference image 1). */
  still?: Buffer;
  /** Character sheet, used when there's no scene picture. */
  character?: Buffer;
  /** The scene's audio (MP3): with `singAudio`, the character sings exactly this. */
  audio?: Buffer;
  singAudio?: boolean;
  durationSec?: number;
  aspectRatio: string;
  label: string;
  resumeTaskId?: string;
  onTaskStarted?: (taskId: string) => Promise<void> | void;
}

class RunwayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class RunwayVideo {
  constructor(
    private readonly apiKey = process.env.RUNWAYML_API_SECRET?.trim(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly opts: { pollMs?: number; timeoutMs?: number } = {},
  ) {
    if (!apiKey) throw new Error("RUNWAYML_API_SECRET is not set. Add it to .env to use Runway models (Wan 3.0).");
  }

  async video(prompt: string, opts: RunwayVideoOptions): Promise<Buffer> {
    const model = opts.model.slice(RUNWAY_PREFIX.length);
    const picture = opts.still ?? opts.character;
    if (!picture) throw new Error(`${opts.label}: Wan 3.0 needs the scene picture (or the character sheet)`);
    const image = await jpegDataUri(picture);
    if (opts.resumeTaskId) {
      const prev = await this.task(opts.resumeTaskId).catch(() => null);
      if (prev && prev.status !== "FAILED" && prev.status !== "CANCELLED") {
        log.info(`${opts.label}: picking up Runway task ${opts.resumeTaskId} instead of making a new video`);
        return this.finish(opts.resumeTaskId, opts.label);
      }
    }
    if (!opts.audio || !opts.singAudio) {
      // No audio: the scene picture is the first frame, as with the other picture-animating models.
      const duration = Math.min(30, Math.max(2, Math.ceil(opts.durationSec ?? 5)));
      return this.run({ model, promptImage: image, promptText: prompt.slice(0, 20_000), ratio: ratioFor(opts.aspectRatio, true), duration, audio: false }, opts);
    }
    // With audio: one clip per ≤15 s slice of it, joined back together.
    const work = await mkdtemp(path.join(os.tmpdir(), "wan3-"));
    try {
      const full = path.join(work, "audio.mp3");
      await writeFile(full, opts.audio);
      const total = await probeDuration(full);
      const parts = Math.max(1, Math.ceil(total / WAN_MAX_AUDIO_SEC - 1e-6));
      const len = total / parts;
      const clips: string[] = [];
      for (let k = 0; k < parts; k++) {
        const slice = path.join(work, `a${k}.mp3`);
        await runFfmpeg(["-ss", (k * len).toFixed(3), "-t", len.toFixed(3), "-i", full, "-c:a", "libmp3lame", "-b:a", "160k", slice]);
        const sec = await probeDuration(slice);
        const mp4 = await this.run({
          model,
          // Reference mode (the only one that takes audio): the picture keeps the look and the setting.
          promptImage: [{ uri: image }],
          promptText: singPrompt(prompt).slice(0, 20_000),
          ratio: ratioFor(opts.aspectRatio, false),
          duration: Math.min(WAN_MAX_AUDIO_SEC, Math.max(2, Math.ceil(sec))),
          audio: true,
          referenceAudio: [{ type: "audio", uri: `data:audio/mpeg;base64,${(await readFile(slice)).toString("base64")}` }],
        }, { label: parts > 1 ? `${opts.label} (part ${k + 1}/${parts})` : opts.label, onTaskStarted: k === 0 ? opts.onTaskStarted : undefined });
        const out = path.join(work, `v${k}.mp4`);
        await writeFile(out, mp4);
        clips.push(out);
      }
      if (clips.length === 1) return await readFile(clips[0]!);
      const list = path.join(work, "list.txt");
      await writeFile(list, clips.map((c) => `file '${c}'`).join("\n") + "\n");
      const joined = path.join(work, "joined.mp4");
      await runFfmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
      return await readFile(joined);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Start a task and wait for its video. Submits are never retried automatically (a retry could pay twice). */
  private async run(body: Record<string, unknown>, opts: { label: string; onTaskStarted?: (taskId: string) => Promise<void> | void }): Promise<Buffer> {
    const created = await this.api<{ id: string }>("POST", "/v1/image_to_video", body);
    log.info(`${opts.label}: Runway task ${created.id} (${String(body.model)})`);
    await opts.onTaskStarted?.(created.id);
    return this.finish(created.id, opts.label);
  }

  private async finish(id: string, label: string): Promise<Buffer> {
    const started = Date.now();
    const timeout = this.opts.timeoutMs ?? 30 * 60_000;
    for (;;) {
      const t = await withRetry(() => this.task(id), { label: `${label} status`, retries: 4, baseDelayMs: 2_000 });
      if (t.status === "SUCCEEDED") {
        const url = t.output?.[0];
        if (!url) throw new Error(`${label}: Runway returned no video (task ${id})`);
        return withRetry(async () => {
          const res = await this.fetchImpl(url);
          if (!res.ok) throw Object.assign(new Error(`${label}: couldn't download the video from Runway (HTTP ${res.status}, task ${id})`), { status: res.status });
          return Buffer.from(await res.arrayBuffer());
        }, { label: `${label} download`, retries: 4, baseDelayMs: 2_000, shouldRetry: (err) => isTransientError(err) || ((err as { status?: number }).status ?? 0) >= 500 });
      }
      if (t.status === "FAILED" || t.status === "CANCELLED") {
        throw new Error(`${label}: Runway task ${id} ${t.status.toLowerCase()}${t.failure ? `: ${t.failure}` : ""}${t.failureCode ? ` (${t.failureCode})` : ""}`);
      }
      if (Date.now() - started > timeout) throw new Error(`${label}: timed out after ${Math.round(timeout / 60_000)} minutes on Runway (task ${id})`);
      await sleep(this.opts.pollMs ?? 10_000);
    }
  }

  private task(id: string) {
    return this.api<{ status: string; output?: string[]; failure?: string; failureCode?: string }>("GET", `/v1/tasks/${id}`);
  }

  private async api<T>(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "X-Runway-Version": VERSION, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 400);
      try {
        const j = JSON.parse(text) as { error?: string; issues?: { path?: unknown[]; message?: string }[] };
        msg = [j.error, ...(j.issues ?? []).map((i) => `${(i.path ?? []).join(".")}: ${i.message}`)].filter(Boolean).join("; ") || msg;
      } catch { /* not JSON */ }
      throw new RunwayError(res.status, `Runway ${method} ${endpoint} failed (HTTP ${res.status}): ${msg}`);
    }
    return JSON.parse(text) as T;
  }
}

/** Reference-mode prompt: name the inputs the way Wan expects ("Image 1", "Audio 1") and ask for the exact song. */
export function singPrompt(prompt: string): string {
  return `Image 1 shows this shot: keep the character's look and outfit and the setting exactly as in Image 1. The character sings the song in Audio 1, mouth moving exactly in sync with every sung word and syllable, following its timing and melody, smiling and moving to the beat. Audio: exactly the song from Audio 1 (the same voice, words, melody and instruments), no other music, no speech. No text, no captions.\n\n${prompt}`;
}

/** Keyframe mode needs an auto_ ratio (the shape follows the picture); reference mode takes the pixel ratio. */
function ratioFor(aspect: string, keyframe: boolean): string {
  return keyframe ? "auto_720p" : RATIOS[aspect] ?? "720:1280";
}

/** The picture as a small JPEG data URI (data URIs are size-limited; a 720p JPEG is a few hundred KB). */
async function jpegDataUri(picture: Buffer): Promise<string> {
  const work = await mkdtemp(path.join(os.tmpdir(), "wan3-img-"));
  try {
    const src = path.join(work, "in");
    const out = path.join(work, "out.jpg");
    await writeFile(src, picture);
    await runFfmpeg(["-i", src, "-vf", "scale='min(1080,iw)':-2", "-q:v", "3", "-frames:v", "1", out]);
    return `data:image/jpeg;base64,${(await readFile(out)).toString("base64")}`;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
