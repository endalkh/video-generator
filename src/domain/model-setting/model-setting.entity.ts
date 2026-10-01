import { NotFoundError, ValidationError } from "../errors.js";

/** Kind of model a task needs; used to filter the model list offered in the UI. */
export type ModelCapability = "text" | "image" | "tts" | "music" | "video";

export interface ModelTaskDefinition {
  task: string;
  title: string;
  description: string;
  capability: ModelCapability;
  /** Built-in default; can be overridden per environment with the env var. */
  defaultModel: string;
  envVar: string;
}

export const MODEL_TASK_IDS = ["poem", "scenes", "character", "character_image", "scene_image", "song", "narration", "scene_video"] as const;
export type ModelTask = (typeof MODEL_TASK_IDS)[number];

/** Every task in the pipeline that calls an AI model, in pipeline order. */
export const MODEL_TASKS: readonly (ModelTaskDefinition & { task: ModelTask })[] = [
  { task: "poem", title: "Poem / lyrics", description: "Writes the poem or song lyrics.", capability: "text", defaultModel: "gemini-3.8-flash", envVar: "GEMINI_POEM_MODEL" },
  { task: "scenes", title: "Scene plan", description: "Splits the poem into scenes with visual descriptions.", capability: "text", defaultModel: "gemini-3.8-flash", envVar: "GEMINI_SCENES_MODEL" },
  { task: "character", title: "Character design", description: "Invents the main character's name and look.", capability: "text", defaultModel: "gemini-3.8-flash", envVar: "GEMINI_CHARACTER_MODEL" },
  { task: "character_image", title: "Character image", description: "Draws the character reference sheet.", capability: "image", defaultModel: "gemini-3.1-flash-image", envVar: "GEMINI_CHARACTER_IMAGE_MODEL" },
  { task: "scene_image", title: "Scene illustrations", description: "Paints each scene, using the character sheet as reference.", capability: "image", defaultModel: "gemini-3.1-flash-image", envVar: "GEMINI_SCENE_IMAGE_MODEL" },
  { task: "song", title: "Song", description: "Composes and sings the whole song (Song mode).", capability: "music", defaultModel: "lyria-3-clip-preview", envVar: "GEMINI_MUSIC_MODEL" },
  { task: "narration", title: "Narration / TTS", description: "Reads each scene aloud (Narration mode).", capability: "tts", defaultModel: "gemini-3.8-flash-tts", envVar: "GEMINI_TTS_MODEL" },
  { task: "scene_video", title: "Scene animation", description: "Animates each scene (Visuals = Veo).", capability: "video", defaultModel: "veo-3.1-fast-generate-preview", envVar: "GEMINI_VIDEO_MODEL" },
];


export function modelTaskDefinition(task: string): ModelTaskDefinition {
  const def = MODEL_TASKS.find((t) => t.task === task);
  if (!def) throw new NotFoundError(`Unknown model task "${task}". Known: ${MODEL_TASKS.map((t) => t.task).join(", ")}`);
  return def;
}

/** Default for a task: env override (useful in Docker) or the built-in value. */
export function defaultModelFor(task: string): string {
  const def = modelTaskDefinition(task);
  return process.env[def.envVar]?.trim() || def.defaultModel;
}

/** Guess what a model can do from its id (the Gemini API doesn't expose output modalities). */
export function capabilityOf(modelId: string): ModelCapability | undefined {
  const id = modelId.toLowerCase();
  if (/embedding|aqa|live|native-audio|realtime|robotics|computer-use|deep-research|customtools/.test(id)) return undefined;
  if (id.startsWith("veo")) return "video";
  if (id.startsWith("lyria")) return "music";
  if (/tts/.test(id)) return "tts";
  if (/image|imagen|banana/.test(id)) return "image";
  if (/^(gemini|gemma)/.test(id)) return "text";
  return undefined;
}

export interface ModelSettingProps {
  task: string;
  model: string;
  updatedAt: Date;
}

/** The model chosen for one pipeline task. */
export class ModelSetting {
  private constructor(private props: ModelSettingProps) {}

  static default(task: string, now = new Date()): ModelSetting {
    return new ModelSetting({ task, model: defaultModelFor(task), updatedAt: now });
  }

  static restore(props: ModelSettingProps): ModelSetting {
    modelTaskDefinition(props.task);
    return new ModelSetting({ ...props });
  }

  get task() { return this.props.task; }
  get model() { return this.props.model; }
  get updatedAt() { return this.props.updatedAt; }
  get definition() { return modelTaskDefinition(this.props.task); }
  get isDefault() { return this.props.model === defaultModelFor(this.props.task); }

  change(model: string): void {
    const id = model.trim().replace(/^models\//, "");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,120}$/.test(id)) throw new ValidationError(`"${model}" is not a valid model id`);
    const cap = capabilityOf(id);
    if (cap && cap !== this.definition.capability) {
      throw new ValidationError(`"${id}" looks like a ${cap} model, but "${this.definition.title}" needs a ${this.definition.capability} model`);
    }
    this.props.model = id;
    this.props.updatedAt = new Date();
  }

  toProps(): ModelSettingProps {
    return { ...this.props };
  }
}

/** Models chosen for one run (snapshot, so changing settings mid-run doesn't mix models). */
export type ModelSelection = Readonly<Record<ModelTask, string>>;
