import type { GenContext, SongResult } from "../../domain/ports/generator.port.js";
import { log } from "../../util/log.js";
import { isTransientError, sleep, withRetry } from "../../util/retry.js";

/**
 * Treblo (formerly Sonauto) music API: https://sonauto.ai/developers/docs
 * Model ids on the Models page are "treblo/<version>"; only v3 is wired up (2-4:45 songs, lyrics + style prompt).
 * Needs TREBLO_API_KEY. One song = 100 credits (~$0.06 pay-as-you-go).
 */
export const TREBLO_PREFIX = "treblo/";
export const isTrebloModel = (model: string) => model.startsWith(TREBLO_PREFIX);
export const TREBLO_MODELS = [{ id: "treblo/v3", displayName: "Treblo (Sonauto) v3 — full songs with vocals, up to 4:45 in one go, ~$0.06/song" }] as const;
/** Longest song one v3 request makes (4:45); the app asks for at most 4:30 so length_range stays valid. */
export const TREBLO_MAX_SONG_SEC = 270;

const LANGUAGE_NAMES: Record<string, string> = { am: "Amharic", en: "English" };
/** How each singer is described to Treblo. Kids' voices are spelled out: music models drift to adult singers otherwise. */
const SINGERS: Record<string, string> = {
  woman: "a warm, gentle female singer",
  man: "a friendly male singer",
  girl: "a little girl about 4 years old: a tiny, high, sweet child's voice, singing simply and a little imperfectly like a real preschooler (not an adult woman, no vibrato, no pop-star style)",
  boy: "a little boy about 4 years old: a small, high, cheerful child's voice, singing simply like a real preschooler (not an adult man, no vibrato)",
  kids: "a small group of preschool children singing together, high and cheerful, like a nursery class (not adults)",
};

/** Style tags from Treblo's tag list (https://sonauto.ai/tag-explorer) that steer the singer; others are avoided. */
export function trebloTags(singer: string | undefined): { tags: string[]; negative_tags: string[] } {
  const kid = singer === "girl" || singer === "boy" || singer === "kids";
  const tags = ["children", "playful", "happy", ...(singer === "girl" || singer === "woman" ? ["female vocalist"] : singer === "man" ? ["male vocalist"] : [])];
  const negative_tags = ["opera", "aggressive", "heavy", ...(singer === "girl" ? ["male vocalist"] : []), ...(singer === "boy" || singer === "man" ? ["female vocalist"] : []), ...(kid ? ["soul", "r&b"] : [])];
  return { tags, negative_tags };
}

export interface TrebloSongOptions {
  model: string;
  label: string;
  durationSec: number;
  ctx: GenContext;
  /** Plain lyrics to sing (one stanza per scene). Omitted for instrumentals. */
  lyrics?: string;
  instrumental?: boolean;
}

/** `length_range` must be multiples of 30 (min 0-270, max 30-300): a window around the wanted length. */
export function lengthRange(seconds: number): [number, number] {
  const min = Math.max(0, Math.min(270, Math.floor((seconds - 15) / 30) * 30));
  const max = Math.max(min + 30, Math.min(300, Math.ceil((seconds + 15) / 30) * 30));
  return [min, max];
}

/** Style prompt for a sung song (the lyrics go separately). */
export function songStylePrompt(ctx: GenContext): string {
  const i = ctx.input;
  const language = LANGUAGE_NAMES[i.language] ?? i.language;
  const singer = SINGERS[i.singer ?? ""] ?? "a warm, clear singer";
  return [
    `A happy, catchy children's nursery song sung in ${language} by ${singer}, for kids aged ${i.ageRange}.`,
    ctx.poem?.title ? `Title: "${ctx.poem.title}".` : "",
    `About: ${i.topic}.`,
    "Simple sing-along melody, slow enough that every word is clear, bright playful instruments, a short instrumental intro and a happy ending.",
    i.audioRequest ? `Also: ${i.audioRequest}` : "",
  ].filter(Boolean).join(" ").slice(0, 1500);
}

export class TrebloError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class TrebloMusic {
  private readonly apiKey: string;

  constructor(
    apiKey = process.env.TREBLO_API_KEY?.trim(),
    private readonly opts: { baseUrl?: string; fetchImpl?: typeof fetch; pollMs?: number; timeoutMs?: number; retryDelayMs?: number } = {},
  ) {
    if (!apiKey) throw new Error("TREBLO_API_KEY is not set. Add it to .env (https://sonauto.ai/developers → Account), or pick a Lyria model for the Song on the Models page");
    this.apiKey = apiKey;
  }

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  /** The request body for POST /generations/v3. */
  static body(prompt: string, opts: TrebloSongOptions): Record<string, unknown> {
    const common = { output_format: "mp3", output_bit_rate: 192, length_range: lengthRange(opts.durationSec) };
    if (opts.instrumental || !opts.lyrics?.trim()) return { ...common, prompt: prompt.slice(0, 1500), instrumental: true };
    // Treblo rejects tags + lyrics + prompt together (HTTP 422). The prompt carries the singer's voice in detail, so
    // positive tags are left out; tags to avoid are a separate field and still steer away from adult styles.
    return { ...common, prompt: songStylePrompt(opts.ctx), lyrics: opts.lyrics.trim(), negative_tags: trebloTags(opts.ctx.input.singer).negative_tags };
  }

  async song(prompt: string, opts: TrebloSongOptions): Promise<SongResult> {
    const { label } = opts;
    const version = opts.model.slice(TREBLO_PREFIX.length);
    if (version !== "v3") throw new Error(`${label}: "${opts.model}" isn't supported; use treblo/v3`);
    // Starting a song is not retried on network errors (it could be billed twice); 429/5xx answers are safe to retry.
    const { task_id: taskId } = await withRetry(() => this.api<{ task_id: string }>("POST", "/generations/v3", TrebloMusic.body(prompt, opts)), {
      label,
      shouldRetry: (err) => err instanceof TrebloError && (err.status === 429 || err.status >= 500),
    });
    log.info(`${label}: Treblo task ${taskId}`);

    const started = Date.now();
    const timeoutMs = this.opts.timeoutMs ?? 10 * 60_000;
    for (;;) {
      const status = await this.get<string | { status?: string }>(`/generations/status/${taskId}`, label);
      const s = typeof status === "string" ? status : status?.status;
      if (s === "SUCCESS") break;
      if (s === "FAILURE") {
        const g = await this.get<{ error_message?: string | null }>(`/generations/${taskId}`, label).catch(() => undefined);
        throw new Error(`${label}: Treblo couldn't make the song (task ${taskId})${g?.error_message ? `: ${g.error_message}` : ""}. No credits were used; try again`);
      }
      if (Date.now() - started > timeoutMs) throw new Error(`${label}: timed out after ${Math.round(timeoutMs / 60_000)} minutes on Treblo (task ${taskId})`);
      log.debug(`${label}: Treblo ${s ?? "waiting"}…`);
      await sleep(this.opts.pollMs ?? 5_000);
    }

    const gen = await this.get<{ song_paths?: string[]; lyrics?: string }>(`/generations/${taskId}`, label);
    const url = gen.song_paths?.[0];
    if (!url) throw new Error(`${label}: Treblo returned no song (task ${taskId})`);
    // Song files are public CDN links: the API key is never sent with the download.
    const audio = await withRetry(
      async () => {
        const res = await this.fetchImpl(url);
        if (!res.ok) throw Object.assign(new Error(`${label}: couldn't download the song from Treblo (HTTP ${res.status}, task ${taskId})`), { status: res.status });
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length < 1000) throw Object.assign(new Error(`${label}: the song downloaded from Treblo is empty (task ${taskId})`), { status: 502 });
        return bytes;
      },
      { label: `${label} download`, retries: 4, baseDelayMs: this.opts.retryDelayMs ?? 2_000, shouldRetry: (err) => isTransientError(err) },
    );
    return { audio, ext: "mp3", lyrics: gen.lyrics || undefined };
  }

  /** GET with retries (reading a task never re-runs it). */
  private get<T>(endpoint: string, label: string): Promise<T> {
    return withRetry(() => this.api<T>("GET", endpoint), { label: `${label} status`, retries: 4, baseDelayMs: this.opts.retryDelayMs ?? 2_000 });
  }

  private async api<T>(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.baseUrl ?? "https://api.treblo.com/v1"}${endpoint}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const d = json as { detail?: unknown; message?: string; error?: string } | undefined;
      const detail = typeof d?.detail === "string" ? d.detail : d?.message ?? d?.error ?? text.slice(0, 300);
      throw new TrebloError(res.status, `Treblo ${method} ${endpoint} failed (HTTP ${res.status}): ${detail}`);
    }
    return json as T;
  }
}
