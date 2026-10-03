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

/** Longest video the app makes, and the most scenes (pictures) in one video. */
export const MAX_VIDEO_SECONDS = 600;
export const MAX_SCENES = 40;
/** Auto scene count: about one picture every this many seconds. */
export const SECONDS_PER_SCENE = { song: 10, narration: 12 } as const;

export function autoSceneCount(lengthSeconds: number, audioMode: AudioMode): number {
  return Math.min(MAX_SCENES, Math.max(2, Math.round(lengthSeconds / SECONDS_PER_SCENE[audioMode])));
}

const ProjectInputObject = z.object({
  topic: z.string().transform(tidy).pipe(z.string().min(3, "topic must be at least 3 characters")),
  language: LanguageSchema.default("en"),
  audioMode: AudioModeSchema.default("song"),
  videoMode: VideoModeSchema.default("still"),
  ageRange: z.string().default("3-6"),
  style: z.string().transform(tidy).default("colorful 3D animated kids' movie style, Pixar-like, soft cinematic lighting, expressive characters"),
  reviewMode: ReviewModeSchema.default("manual"),
  /** Leave out to pick it from the video length. */
  sceneCount: z.number().int().min(2).max(MAX_SCENES).optional(),
  /** Song length in seconds (Song mode). Set from lengthSeconds when that is given. */
  songSeconds: z.number().int().min(10).max(MAX_VIDEO_SECONDS).default(30),
  /** Target length of the whole video in seconds (song or narration). Songs over ~3 minutes are made in parts. */
  lengthSeconds: z.number().int().min(10).max(MAX_VIDEO_SECONDS).optional(),
  aspectRatio: AspectRatioSchema.default("16:9"),
  /** Show the lyrics / narration as subtitles in the final video. Off unless asked for. */
  subtitles: z.boolean().default(false),
  characterHint: z.string().transform(tidy).optional(),
  voice: z.string().optional(),
});

export const ProjectInputSchema = ProjectInputObject.transform((v) => ({
  ...v,
  songSeconds: v.lengthSeconds ?? v.songSeconds,
  sceneCount: v.sceneCount ?? (v.lengthSeconds ? autoSceneCount(v.lengthSeconds, v.audioMode) : 4),
}));
export type ProjectInput = z.infer<typeof ProjectInputSchema>;

export const PoemSchema = z.object({
  title: z.string().min(1),
  stanzas: z.array(z.object({ lines: z.array(z.string().min(1)).min(1) })).min(1),
  moral: z.string().optional(),
});
export type Poem = z.infer<typeof PoemSchema>;

/** One rewritten stanza (Poem page: "Rewrite this stanza"). */
export const StanzaSchema = z.object({ lines: z.array(z.string().min(1)).min(1).max(8) });
export type Stanza = z.infer<typeof StanzaSchema>;

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
