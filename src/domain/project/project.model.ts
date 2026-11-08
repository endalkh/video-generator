import { z } from "zod";

export const LanguageSchema = z.enum(["am", "en"]);
export type Language = z.infer<typeof LanguageSchema>;

/**
 * song = sung by the music model; narration = read by the speech model; music_voice = the speech model chants the
 * rhyme over instrumental music from the music model (clear words in languages the music model can't sing, e.g. Amharic);
 * character = the main character says each scene's words in the Veo clip itself (lip-sync), over soft background music. Needs Veo.
 * dialogue = a spoken story where each line has its own speaker (the main character, a cast member, or a narrator),
 *   each voiced by the speech model in that speaker's assigned voice; the lines are stitched into each scene's audio.
 */
export const AudioModeSchema = z.enum(["song", "narration", "music_voice", "character", "dialogue"]);
export type AudioMode = z.infer<typeof AudioModeSchema>;

export const VideoModeSchema = z.enum(["still", "veo"]);
export type VideoMode = z.infer<typeof VideoModeSchema>;

/** auto = run straight through; manual = stop after each step for review/edit/approve. */
export const ReviewModeSchema = z.enum(["auto", "manual"]);
export type ReviewMode = z.infer<typeof ReviewModeSchema>;

export const AspectRatioSchema = z.enum(["16:9", "9:16"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/** Output resolution of the final video (short side in pixels). Chosen per video ("Quality"); VIDEO_RESOLUTION sets the default. */
export const VIDEO_RESOLUTIONS = { "720p": 720, "1080p": 1080, "4k": 2160 } as const;
export const VideoResolutionSchema = z.enum(["720p", "1080p", "4k"]);
export type VideoResolution = z.infer<typeof VideoResolutionSchema>;

export function videoResolution(env = process.env.VIDEO_RESOLUTION): VideoResolution {
  const v = env?.trim().toLowerCase();
  if (!v) return "1080p";
  if (v in VIDEO_RESOLUTIONS) return v as VideoResolution;
  throw new Error(`VIDEO_RESOLUTION must be one of ${Object.keys(VIDEO_RESOLUTIONS).join(", ")} (got "${env}")`);
}

/** The lower of two resolutions (e.g. what a model can make vs. what the video needs). */
export const minResolution = (a: VideoResolution, b: VideoResolution): VideoResolution => (VIDEO_RESOLUTIONS[a] <= VIDEO_RESOLUTIONS[b] ? a : b);

/** What the user asks for (from the UI form, --input JSON, or CLI flags). */
const tidy = (v: string) => v.replace(/\s+/g, " ").trim();

/** Longest video the app makes, and the most scenes (pictures) in one video. */
export const MAX_VIDEO_SECONDS = 600;
export const MAX_SCENES = 40;
/** Auto scene count: about one picture every this many seconds. */
export const SECONDS_PER_SCENE = { song: 10, narration: 12, music_voice: 12, character: 8, dialogue: 12 } as const;

/** Who sings or speaks. Songs describe the singer in the music prompt; speech also picks a matching voice. */
export const SingerSchema = z.enum(["auto", "woman", "man", "girl", "boy", "kids"]);
export type Singer = z.infer<typeof SingerSchema>;

/** Gemini TTS prebuilt voices (name → character), for the "exact voice" picker. */
export const TTS_VOICES = {
  Zephyr: "female, bright", Kore: "female, firm", Leda: "female, youthful", Aoede: "female, breezy", Callirrhoe: "female, easy-going",
  Autonoe: "female, bright", Despina: "female, smooth", Erinome: "female, clear", Laomedeia: "female, upbeat", Achernar: "female, soft",
  Gacrux: "female, mature", Pulcherrima: "female, forward", Vindemiatrix: "female, gentle", Sulafat: "female, warm",
  Puck: "male, upbeat", Charon: "male, informative", Fenrir: "male, excitable", Orus: "male, firm", Enceladus: "male, breathy",
  Iapetus: "male, clear", Umbriel: "male, easy-going", Algieba: "male, smooth", Algenib: "male, gravelly", Rasalgethi: "male, informative",
  Alnilam: "male, firm", Schedar: "male, even", Achird: "male, friendly", Zubenelgenubi: "male, casual", Sadachbia: "male, lively", Sadaltager: "male, knowledgeable",
} as const;
export type TtsVoice = keyof typeof TTS_VOICES;

/** Speech voice used when no exact voice is chosen. */
export function defaultVoice(singer: Singer, audioMode: AudioMode): TtsVoice {
  const bySinger: Record<Singer, TtsVoice> = { auto: audioMode === "narration" ? "Kore" : "Leda", woman: "Sulafat", man: "Achird", girl: "Leda", boy: "Puck", kids: "Laomedeia" };
  return bySinger[singer];
}

/** The narrator's voice in dialogue mode (a calm, clear storyteller). */
export const NARRATOR_VOICE: TtsVoice = "Charon";
/** A varied pool of distinct voices to give dialogue cast members, so each character sounds different. */
export const DIALOGUE_VOICE_POOL: readonly TtsVoice[] = ["Puck", "Fenrir", "Leda", "Aoede", "Laomedeia", "Enceladus", "Gacrux", "Sadachbia", "Umbriel", "Despina"];

/**
 * Give each cast member without a chosen voice a distinct one from the pool, avoiding the main character's and
 * the narrator's voices and any voice already taken. Returns a new cast list (does not mutate the input).
 */
export function assignCastVoices(cast: readonly CastMember[], mainVoice: TtsVoice): CastMember[] {
  const taken = new Set<TtsVoice>([mainVoice, NARRATOR_VOICE, ...cast.map((c) => c.voice).filter((v): v is TtsVoice => Boolean(v))]);
  const free = DIALOGUE_VOICE_POOL.filter((v) => !taken.has(v));
  let i = 0;
  return cast.map((c) => {
    if (c.voice) return { ...c };
    const voice = free[i++] ?? DIALOGUE_VOICE_POOL[(i - 1) % DIALOGUE_VOICE_POOL.length]!;
    return { ...c, voice };
  });
}

/**
 * Which TTS voice speaks a dialogue line, by speaker id: "main" = the project's chosen voice, "narrator" = the
 * narrator voice, otherwise the matching cast member's voice (or a fallback). Used by the audio step (Stage C).
 */
export function speakerVoice(speaker: string, cast: readonly CastMember[], mainVoice: TtsVoice): TtsVoice {
  if (speaker === SPEAKER_MAIN) return mainVoice;
  if (speaker === SPEAKER_NARRATOR) return NARRATOR_VOICE;
  const member = cast.find((c) => c.id === speaker);
  return member?.voice ?? NARRATOR_VOICE;
}

export function autoSceneCount(lengthSeconds: number, audioMode: AudioMode): number {
  return Math.min(MAX_SCENES, Math.max(2, Math.round(lengthSeconds / SECONDS_PER_SCENE[audioMode])));
}

/**
 * Where each scene's sound comes from. null = the audio models (song / voice AI), cut to the clips.
 * "speaks" / "sings" = the video model makes it inside each clip: the character says (or sings) the scene's words
 * herself, lips in sync, and no audio model is used ("The character speaks" mode always works like this; with
 * `videoAudio` a song is sung in the clips and the other modes are spoken in the clips).
 */
export function soundInVideo(input: { audioMode: AudioMode; videoAudio?: boolean }): "speaks" | "sings" | null {
  if (input.audioMode === "character") return "speaks";
  // Dialogue is always made by the speech model (multi-voice, stitched per scene), never inside the clips.
  if (input.audioMode === "dialogue") return null;
  if (!input.videoAudio) return null;
  return input.audioMode === "song" ? "sings" : "speaks";
}

/** Scene pacing: sound made inside the clips means one ~8-second clip per scene, like "The character speaks". */
export const pacingMode = (input: { audioMode: AudioMode; videoAudio?: boolean }): AudioMode => (soundInVideo(input) ? "character" : input.audioMode);

const ProjectInputObject = z.object({
  topic: z.string({ error: "write what the video is about" }).transform(tidy).pipe(z.string().min(3, "topic must be at least 3 characters")),
  language: LanguageSchema.default("en"),
  audioMode: AudioModeSchema.default("song"),
  /**
   * Skip the audio models: the video model makes the voice or song inside each clip (see soundInVideo). Off by
   * default; the new-video form turns it on for English (video models speak and sing English well, Amharic not).
   */
  videoAudio: z.boolean().default(false),
  /**
   * When the voice / song is made inside the clips: lay soft instrumental music from the music model under them
   * (video models often sing or speak with no backing music). Off = no audio model at all.
   */
  backgroundMusic: z.boolean().default(true),
  /**
   * Paint a picture for each scene (image model) and animate it. Off = no scene pictures: the video model makes
   * each scene from the character picture (reference) and the scene description. Needs moving video clips.
   */
  scenePictures: z.boolean().default(true),
  /** Moving video clips (Veo, Seedance, Kling…) by default; "still" = animated pictures (free, fast). */
  videoMode: VideoModeSchema.default("veo"),
  ageRange: z.string().default("all ages"),
  style: z.string().transform(tidy).default("colorful 3D animated kids' movie style, Pixar-like, bright even lighting, crisp detailed backgrounds, expressive characters"),
  reviewMode: ReviewModeSchema.default("manual"),
  /** Leave out to pick it from the video length. */
  sceneCount: z.number().int().min(2).max(MAX_SCENES).optional(),
  /** Song length in seconds (Song mode). Set from lengthSeconds when that is given. */
  songSeconds: z.number().int().min(10).max(MAX_VIDEO_SECONDS).default(30),
  /** Target length of the whole video in seconds (song or narration). Songs over ~3 minutes are made in parts. */
  lengthSeconds: z.number().int().min(10).max(MAX_VIDEO_SECONDS).optional(),
  aspectRatio: AspectRatioSchema.default("16:9"),
  /** Final video quality. Veo 3.1 makes 4K clips; Veo Lite and Seedance make 1080p, scaled up. */
  resolution: VideoResolutionSchema.default(() => videoResolution()),
  /** Scene videos made at the same time (1-10). Empty = auto: 4 on inference.sh, 2 on Google Veo (low per-minute limits). */
  videoConcurrency: z.number().int().min(1).max(10).optional(),
  /** Show the lyrics / narration as subtitles in the final video. Off unless asked for. */
  subtitles: z.boolean().default(false),
  characterHint: z.string().transform(tidy).optional(),
  /** Extra wishes for the audio, added to the song / music / voice prompts (Audio page, "What should be different?"). */
  audioRequest: z.string().transform(tidy).pipe(z.string().max(500)).optional().transform((v) => v || undefined),
  /** Who sings / speaks (all audio modes). */
  singer: SingerSchema.default("auto"),
  /** Exact speech voice (narration and voice over music); empty = picked from `singer`. */
  voice: z.enum(Object.keys(TTS_VOICES) as [TtsVoice, ...TtsVoice[]]).optional(),
});

export const ProjectInputSchema = ProjectInputObject.transform((v) => ({
  ...v,
  // The video model can only make the voice / song (or a scene without a picture) in moving video clips.
  videoMode: soundInVideo(v) || !v.scenePictures ? ("veo" as const) : v.videoMode,
  songSeconds: v.lengthSeconds ?? v.songSeconds,
  sceneCount: v.sceneCount ?? (v.lengthSeconds ? autoSceneCount(v.lengthSeconds, pacingMode(v)) : 4),
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

/**
 * One spoken line in a dialogue-story scene. `speaker` is "main" (the main character), "narrator", or a
 * secondary cast member's id (CastMember.id). Each is voiced in that speaker's assigned voice (Stage B).
 */
export const DialogueLineSchema = z.object({
  speaker: z.string().min(1).max(60),
  line: z.string().min(1),
});
export type DialogueLine = z.infer<typeof DialogueLineSchema>;
/** Reserved speaker ids (everything else is a cast member id). */
export const SPEAKER_MAIN = "main";
export const SPEAKER_NARRATOR = "narrator";

export const SceneSchema = z.object({
  index: z.number().int().min(0),
  /** Text spoken or sung during this scene (in the project language). */
  text: z.string().min(1),
  /** English visual description for image/video models. */
  visualPrompt: z.string().min(1),
  /** Camera / motion hint, used for Ken Burns or Veo prompts. */
  motion: MotionSchema.default("zoom-in"),
  /** ids of the secondary cast members (CastMember.id) that appear in this scene, besides the main character. */
  characters: z.array(z.string()).optional(),
  /** Dialogue mode: the scene's lines, each with its speaker ("main" / "narrator" / a cast id). `text` is these lines joined. */
  dialogue: z.array(DialogueLineSchema).optional(),
  /** Moving-video mode: false = no picture for this scene (the video AI makes it from the character); unset = the video's default. */
  picture: z.boolean().optional(),
  /** true = left out of the final video (e.g. its video isn't made); its clip is never made. Unset = in the video. */
  leftOut: z.boolean().optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

/** Does this scene get a picture? Animated pictures always need one; moving video follows the scene, else the video's default. */
export function scenePicture(input: { videoMode?: string; scenePictures?: boolean }, scene: Pick<Scene, "picture">): boolean {
  if (input.videoMode !== "veo") return true;
  return scene.picture ?? input.scenePictures !== false;
}

export const ScenePlanSchema = z.object({ scenes: z.array(SceneSchema).min(1) });
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

export const CharacterSchema = z.object({
  name: z.string().min(1),
  /** Detailed English appearance description reused in every scene prompt. */
  description: z.string().min(1),
  /** Character step skipped: no character sheet; each picture / video is made from its scene description. */
  skipped: z.boolean().optional(),
});
export type Character = z.infer<typeof CharacterSchema>;

/**
 * A secondary recurring character (e.g. a talking rabbit, a lion cub) that should stay on-model across the
 * scenes it appears in. Each gets its own reference image (cast/<id>.png), like the main character's sheet.
 */
export const CastMemberSchema = z.object({
  /** Stable slug used in Scene.characters and the reference-image filename (e.g. "rabbit", "lion-cub"). */
  id: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*$/, "cast id must be a lowercase slug"),
  name: z.string().min(1),
  /** Detailed English appearance description reused wherever this character appears. */
  description: z.string().min(1),
  /** Dialogue mode: the TTS voice this character speaks with. Empty = auto-assigned a distinct voice. */
  voice: z.enum(Object.keys(TTS_VOICES) as [TtsVoice, ...TtsVoice[]]).optional(),
});
export type CastMember = z.infer<typeof CastMemberSchema>;
export const CastSchema = z.array(CastMemberSchema).max(8);
export type Cast = z.infer<typeof CastSchema>;
/** JSON output shape of the `cast` text prompt. */
export const CastPlanSchema = z.object({ cast: CastSchema });
export type CastPlan = z.infer<typeof CastPlanSchema>;

/** Stand-in used in the prompts when the Character step is skipped. */
export const NO_CHARACTER: Character = {
  name: "the children",
  description: "No fixed main character: show the children, animals and people the scene describes, in the video's art style.",
  skipped: true,
};

/** Song mode: where the continuous song file lives and when each scene is on screen. */
export const SongTimelineSchema = z.object({
  file: z.string(),
  duration: z.number().positive(),
  slots: z.array(z.object({ start: z.number(), end: z.number() })),
  lyrics: z.string().optional(),
  /** ai = made by the music model (default), music_voice = voice over music, upload = your own recording. */
  source: z.enum(["ai", "music_voice", "upload"]).optional(),
});
export type SongTimeline = z.infer<typeof SongTimelineSchema>;

/** What to paste into YouTube when uploading the finished video (Final video page). */
export const PublishInfoSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()),
  /** The big words on the thumbnail. */
  thumbnailTitle: z.string(),
});
export type PublishInfo = z.infer<typeof PublishInfoSchema>;

/** YouTube limits: title 100, description 5000, tags 500 characters in total. */
export const PUBLISH_LIMITS = { title: 100, description: 5000, tags: 500, thumbnailTitle: 40 } as const;

export function normalizePublishInfo(p: PublishInfo): PublishInfo {
  const tidy = (v: string) => v.replace(/\s+/g, " ").trim();
  const tags: string[] = [];
  let total = 0;
  for (const t of p.tags.map((x) => tidy(x).replace(/^#/, "")).filter(Boolean)) {
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    if (total + t.length + 1 > PUBLISH_LIMITS.tags) break;
    tags.push(t);
    total += t.length + 1;
  }
  return {
    title: tidy(p.title).slice(0, PUBLISH_LIMITS.title),
    description: p.description.trim().slice(0, PUBLISH_LIMITS.description),
    tags,
    thumbnailTitle: tidy(p.thumbnailTitle).slice(0, PUBLISH_LIMITS.thumbnailTitle),
  };
}

export const STEP_NAMES = ["poem", "scenes", "character", "audio", "clips", "final"] as const;
export const StepNameSchema = z.enum(STEP_NAMES);
export type StepName = z.infer<typeof StepNameSchema>;

/** Steps that pause for review in manual mode ("final" is the end of the run). */
export const REVIEW_STEPS = ["poem", "scenes", "character", "audio", "clips"] as const satisfies readonly StepName[];

export const PROJECT_STATUSES = ["new", "running", "review", "paused", "done", "failed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
