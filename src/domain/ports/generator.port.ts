import type { Character, Poem, ProjectInput, Scene, ScenePlan } from "../project/project.model.js";

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
}
export type TextKind = keyof TextOutputs;

/** Context passed alongside prompts. Real providers only use the prompt; the mock uses this to fake plausible output. */
export interface GenContext {
  input: ProjectInput;
  poem?: Poem;
  scene?: Scene;
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

export function mmss(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

