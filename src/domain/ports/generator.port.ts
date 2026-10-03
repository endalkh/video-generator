import type { ChannelDetails } from "../channel/channel.model.js";
import type { PlanText } from "../plan/plan.model.js";
import type { Character, Poem, ProjectInput, PublishInfo, Scene, ScenePlan, Stanza } from "../project/project.model.js";

/** A time window within the song where a scene's lyrics are sung. */
export interface SongSlot {
  start: number;
  end: number;
}

export interface SongResult {
  audio: Buffer;
  ext: "mp3" | "wav";
  /** Lyrics / structure text returned by the model, if any. */
  lyrics?: string;
}

/** Structured text outputs, keyed by pipeline step. */
export interface TextOutputs {
  poem: Poem;
  scenes: ScenePlan;
  character: Character;
  /** Channel page: YouTube channel name, handle, description, keywords. */
  channel: ChannelDetails;
  /** Final video page: YouTube title, description, tags and thumbnail words. */
  publish: PublishInfo;
  /** Poem page: one stanza written again. */
  stanza: Stanza;
  /** Ideas & schedule page: a month of video ideas, one per posting slot. */
  plan: PlanText;
}
export type TextKind = keyof TextOutputs;

/** Context passed alongside prompts. Real providers only use the prompt; the mock uses this to fake plausible output. */
export interface GenContext {
  input: ProjectInput;
  poem?: Poem;
  scene?: Scene;
  /** Channel page: the channel name, if known. */
  channelName?: string;
  /** Poem page: which stanza (0-based) is being rewritten. */
  stanzaIndex?: number;
  /** Ideas & schedule page: the posting slots to fill. */
  planSlots?: { date: string; language: "en" | "am" }[];
}

/** A model the provider can use, as offered on the Settings page. */
export interface AvailableModel {
  id: string;
  displayName?: string;
}

/**
 * A generative backend. Prompts are rendered by the pipeline from the editable templates in Postgres,
 * so providers only execute them. All media is returned as bytes.
 */
export interface Provider {
  readonly name: string;
  /** Forces a song length (seconds) regardless of the project setting; used by the offline mock. */
  readonly songLengthSec?: number;
  /** Models the account can use (for the Settings page). */
  listModels(): Promise<AvailableModel[]>;
  /** JSON generation validated against the step's schema. `model` comes from the per-task settings. */
  text<K extends TextKind>(kind: K, prompt: string, opts: { model: string; ctx: GenContext; /** Pictures to look at (e.g. an uploaded character). */ images?: Buffer[] }): Promise<TextOutputs[K]>;
  /** Image (PNG/JPEG). `references` are attached images (e.g. the character sheet). */
  image(prompt: string, opts: { model: string; aspectRatio: string; references?: Buffer[]; label: string; ctx: GenContext }): Promise<Buffer>;
  /** Speech as WAV. */
  speech(prompt: string, opts: { model: string; voice: string; label: string; ctx: GenContext }): Promise<Buffer>;
  /** One continuous song (optional; without it song mode falls back to per-scene sung TTS). */
  song?(prompt: string, opts: { model: string; label: string; durationSec: number; ctx: GenContext }): Promise<SongResult>;
  /** Animated MP4 seeded by a still (optional; used when videoMode === "veo"). */
  video?(
    prompt: string,
    opts: { model: string; still: Buffer; aspectRatio: string; label: string; ctx: GenContext; /** Character sheet, so the character stays consistent. */ character?: Buffer },
  ): Promise<Buffer>;
}

export const LANGUAGE_NAMES = { am: "Amharic (Ge'ez script)", en: "English" } as const;

/**
 * Split a song of `total` seconds into one slot per scene, weighted by lyric length,
 * after a short instrumental intro (folded into scene 1 visually).
 */
export function songTimeline(scenes: Pick<Scene, "text">[], total: number, intro = 2): SongSlot[] {
  const weights = scenes.map((s) => Math.max(1, [...s.text.replace(/\s+/g, "")].length));
  const sum = weights.reduce((a, b) => a + b, 0);
  const body = Math.max(0, total - intro);
  let t = 0;
  return weights.map((w, i) => {
    const start = t;
    t = i === weights.length - 1 ? total : t + (i === 0 ? intro : 0) + (body * w) / sum;
    return { start, end: t };
  });
}

/** Longest song one request can make (Lyria 3 Pro / 3.5 allow ~184 s). Longer songs are made in parts. */
export const MAX_SONG_PART_SEC = 180;

export interface SongPart {
  /** Indexes into the scene list (contiguous). */
  scenes: number[];
  seconds: number;
}

/**
 * Split a song of `total` seconds into parts the music model can make, cutting between scenes and
 * balancing the lyrics. Models with a fixed length (e.g. Lyria 3 Clip, 30 s) get parts of exactly that length.
 */
export function songParts(scenes: Pick<Scene, "text">[], total: number, opts: { maxPart?: number; fixedLength?: number } = {}): SongPart[] {
  const maxPart = opts.fixedLength ?? opts.maxPart ?? MAX_SONG_PART_SEC;
  const weights = scenes.map((s) => Math.max(1, [...s.text.replace(/\s+/g, "")].length));
  const sum = weights.reduce((a, b) => a + b, 0);
  for (let k = Math.max(1, Math.ceil(total / maxPart)); k <= scenes.length; k++) {
    // Greedy contiguous split at the k-1 points closest to equal lyric shares.
    const parts: number[][] = [];
    let acc = 0;
    let cur: number[] = [];
    weights.forEach((w, i) => {
      cur.push(i);
      acc += w;
      const left = scenes.length - i - 1;
      const partsLeft = k - parts.length - 1;
      if (partsLeft > 0 && (acc >= (sum * (parts.length + 1)) / k || left === partsLeft)) {
        parts.push(cur);
        cur = [];
      }
    });
    parts.push(cur);
    const seconds = parts.map((p) => (opts.fixedLength ? opts.fixedLength : (total * p.reduce((n, i) => n + weights[i]!, 0)) / sum));
    if (parts.every((p) => p.length) && seconds.every((s) => s <= maxPart + 0.5)) return parts.map((p, j) => ({ scenes: p, seconds: Math.round(seconds[j]!) }));
  }
  return scenes.map((_, i) => ({ scenes: [i], seconds: Math.min(maxPart, Math.round(total / scenes.length)) }));
}

/** Comfortable, clear singing pace for young children (syllables per second). */
export const KIDS_SYLLABLES_PER_SEC = 2.5;
/** Instrumental intro + happy ending around the verses (seconds). */
export const SONG_FRAME_SEC = 4;

/**
 * Rough syllable count. Ge'ez script is syllabic (one fidel ≈ one syllable; ~20% of them, mostly
 * 6th-order, are barely voiced, hence the 0.8). Latin words count their vowel groups.
 */
export function estimateSyllables(text: string): number {
  const fidel = [...text].filter((c) => /[\u1200-\u137F\u1380-\u139F\u2D80-\u2DDF\uAB00-\uAB2F]/.test(c)).length;
  const latin = (text.match(/[a-z]+/gi) ?? []).reduce((n, w) => n + Math.max(1, (w.toLowerCase().replace(/(?<![^aeiou]l)e$/, "").match(/[aeiouy]+/g) ?? []).length), 0);
  return Math.round(fidel * 0.8) + latin;
}

/** Seconds a song needs so every word can be sung clearly at a kids' pace. */
export function singableSeconds(texts: string[]): number {
  const syllables = texts.reduce((n, t) => n + estimateSyllables(t), 0);
  return Math.ceil(syllables / KIDS_SYLLABLES_PER_SEC + SONG_FRAME_SEC);
}

export function mmss(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

