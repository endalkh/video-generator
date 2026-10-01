import { z } from "zod";

export const LanguageSchema = z.enum(["am", "en"]);
export type Language = z.infer<typeof LanguageSchema>;

export const AudioModeSchema = z.enum(["song", "narration"]);
export type AudioMode = z.infer<typeof AudioModeSchema>;

export const VideoModeSchema = z.enum(["still", "veo"]);
export type VideoMode = z.infer<typeof VideoModeSchema>;

/** auto = run straight through; manual = stop after each step for review/edit/approve. */
export const ReviewModeSchema = z.enum(["auto", "manual"]);
export type ReviewMode = z.infer<typeof ReviewModeSchema>;

export const AspectRatioSchema = z.enum(["16:9", "9:16"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/** What the user asks for (from the UI form, --input JSON, or CLI flags). */
const tidy = (v: string) => v.replace(/\s+/g, " ").trim();

export const ProjectInputSchema = z.object({
  topic: z.string().transform(tidy).pipe(z.string().min(3, "topic must be at least 3 characters")),
  language: LanguageSchema.default("en"),
  audioMode: AudioModeSchema.default("song"),
  videoMode: VideoModeSchema.default("still"),
  ageRange: z.string().default("3-6"),
  style: z.string().transform(tidy).default("colorful 3D animated kids' movie style, Pixar-like, soft cinematic lighting, expressive characters"),
  reviewMode: ReviewModeSchema.default("auto"),
  sceneCount: z.number().int().min(2).max(12).default(4),
  /** Song length in seconds (Song mode). Lyria 3 Clip models are always 30s. */
  songSeconds: z.number().int().min(10).max(180).default(30),
  aspectRatio: AspectRatioSchema.default("16:9"),
  characterHint: z.string().transform(tidy).optional(),
  voice: z.string().optional(),
});
export type ProjectInput = z.infer<typeof ProjectInputSchema>;

export const PoemSchema = z.object({
  title: z.string().min(1),
  stanzas: z.array(z.object({ lines: z.array(z.string().min(1)).min(1) })).min(1),
  moral: z.string().optional(),
});
export type Poem = z.infer<typeof PoemSchema>;

export const MotionSchema = z.enum(["zoom-in", "zoom-out", "pan-left", "pan-right", "static"]);
export type Motion = z.infer<typeof MotionSchema>;

export const SceneSchema = z.object({
  index: z.number().int().min(0),
  /** Text spoken or sung during this scene (in the project language). */
  text: z.string().min(1),
  /** English visual description for image/video models. */
  visualPrompt: z.string().min(1),
  /** Camera / motion hint, used for Ken Burns or Veo prompts. */
  motion: MotionSchema.default("zoom-in"),
});
export type Scene = z.infer<typeof SceneSchema>;

export const ScenePlanSchema = z.object({ scenes: z.array(SceneSchema).min(1) });
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

export const CharacterSchema = z.object({
  name: z.string().min(1),
  /** Detailed English appearance description reused in every scene prompt. */
  description: z.string().min(1),
});
export type Character = z.infer<typeof CharacterSchema>;

/** Song mode: where the continuous song file lives and when each scene is on screen. */
export const SongTimelineSchema = z.object({
  file: z.string(),
  duration: z.number().positive(),
  slots: z.array(z.object({ start: z.number(), end: z.number() })),
  lyrics: z.string().optional(),
});
export type SongTimeline = z.infer<typeof SongTimelineSchema>;

export const STEP_NAMES = ["poem", "scenes", "character", "audio", "clips", "final"] as const;
export const StepNameSchema = z.enum(STEP_NAMES);
export type StepName = z.infer<typeof StepNameSchema>;

/** Steps that pause for review in manual mode ("final" is the end of the run). */
export const REVIEW_STEPS = ["poem", "scenes", "character", "audio", "clips"] as const satisfies readonly StepName[];

export const PROJECT_STATUSES = ["new", "running", "review", "paused", "done", "failed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
