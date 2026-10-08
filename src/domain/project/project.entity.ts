import { ConflictError, ValidationError } from "../errors.js";
import {
  ProjectInputSchema,
  STEP_NAMES,
  type Character,
  type Poem,
  type ProjectInput,
  type ProjectStatus,
  type ScenePlan,
  type SongTimeline,
  type PublishInfo,
  normalizePublishInfo,
  type StepName,
  type VideoMode,
  VideoModeSchema,
  REVIEW_STEPS,
  ReviewModeSchema,
  type ReviewMode,
  soundInVideo,
  NO_CHARACTER,
} from "./project.model.js";

/** Plain data shape of a Project, used by mappers and repositories. */
export interface ProjectProps {
  id: string;
  /** The channel this video belongs to (null only for videos from before channels existed). */
  channelId: string | null;
  input: ProjectInput;
  provider: string;
  status: ProjectStatus;
  error: string | null;
  completed: StepName[];
  /** Manual mode: steps the user has approved. */
  approved: StepName[];
  poem: Poem | null;
  scenes: ScenePlan | null;
  character: Character | null;
  song: SongTimeline | null;
  /** YouTube title / description / tags / thumbnail text (made when the video is finished). */
  publish: PublishInfo | null;
  createdAt: Date;
  updatedAt: Date;
}

const stepIndex = (s: StepName) => STEP_NAMES.indexOf(s);

/** Settings that can be changed after a video was started (Video settings panel). */
/** Steps that can be made again while keeping everything the later steps made. */
export const KEEP_LATER_STEPS = ["scenes", "character", "audio"] as const;

export const SETTING_KEYS = ["topic", "language", "audioMode", "videoAudio", "backgroundMusic", "lengthSeconds", "songSeconds", "sceneCount", "ageRange", "style", "characterHint", "voice", "singer", "aspectRatio", "resolution", "videoMode", "scenePictures", "videoConcurrency"] as const;

/**
 * Aggregate root for a video project. Owns the pipeline progress rules:
 * steps complete in order, and redoing a step invalidates everything after it.
 */
export class Project {
  private constructor(private props: ProjectProps) {}

  static create(args: { id: string; input: ProjectInput; provider: string; channelId?: string | null; now?: Date }): Project {
    const parsed = ProjectInputSchema.safeParse(args.input);
    if (!parsed.success) throw new ValidationError("Invalid project input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(args.id)) throw new ValidationError(`Invalid project id "${args.id}"`);
    const now = args.now ?? new Date();
    return new Project({
      id: args.id,
      channelId: args.channelId ?? null,
      input: parsed.data,
      provider: args.provider,
      status: "new",
      error: null,
      completed: [],
      approved: [],
      poem: null,
      scenes: null,
      character: null,
      song: null,
      publish: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Rehydrate from persistence (mappers only). */
  static restore(props: ProjectProps): Project {
    return new Project({ ...props, channelId: props.channelId ?? null, publish: props.publish ?? null, completed: [...props.completed], approved: [...(props.approved ?? [])] });
  }

  get id() { return this.props.id; }
  get channelId() { return this.props.channelId; }
  get topic() { return this.props.input.topic; }
  get input(): Readonly<ProjectInput> { return this.props.input; }
  get provider() { return this.props.provider; }
  get status() { return this.props.status; }
  get error() { return this.props.error; }
  get completed(): readonly StepName[] { return this.props.completed; }
  get poem() { return this.props.poem; }
  get scenes() { return this.props.scenes; }
  get character() { return this.props.character; }
  get song() { return this.props.song; }
  get publish() { return this.props.publish; }
  get createdAt() { return this.props.createdAt; }
  get updatedAt() { return this.props.updatedAt; }
  get isRunning() { return this.props.status === "running"; }
  get approved(): readonly StepName[] { return this.props.approved; }
  get isManual() { return this.props.input.reviewMode === "manual"; }

  /** Manual mode: the finished step waiting for the user's review, if any. */
  get awaitingReview(): StepName | null {
    if (this.props.status !== "review") return null;
    return REVIEW_STEPS.find((s) => this.props.completed.includes(s) && !this.props.approved.includes(s)) ?? null;
  }

  /** True when a run must stop here so the user can review `step`. */
  needsReview(step: StepName): boolean {
    return this.isManual && (REVIEW_STEPS as readonly StepName[]).includes(step) && this.isStepDone(step) && !this.props.approved.includes(step);
  }

  awaitReview(): void {
    this.props.status = "review";
    this.props.error = null;
    this.touch();
  }

  /** Approved as part of the run itself (e.g. the user approved their uploaded videos before it started). */
  approveInRun(step: StepName): void {
    if (!this.isStepDone(step)) throw new ConflictError(`"${step}" hasn't been generated yet`);
    if (!this.props.approved.includes(step)) this.props.approved.push(step);
    this.touch();
  }

  approve(step: StepName): void {
    this.assertEditable();
    if (!this.isStepDone(step)) throw new ConflictError(`"${step}" hasn't been generated yet`);
    if (!this.props.approved.includes(step)) this.props.approved.push(step);
    // Nothing else waits for review: the video waits until you make the next step.
    if (this.props.status === "review" && this.awaitingReview === null) this.props.status = "paused";
    this.touch();
  }

  /**
   * Skip the Scenes step: no AI scene plan. Each stanza becomes a scene, and its picture / video description is
   * simply the topic plus the stanza's words (edit them on the Scenes page if you like).
   */
  skipScenes(): void {
    this.assertEditable();
    const poem = this.props.poem;
    if (!poem || !this.isStepDone("poem")) throw new ConflictError("Write the poem first");
    const motions = ["zoom-in", "pan-right", "zoom-out", "pan-left"] as const;
    this.setScenes({
      scenes: poem.stanzas.map((st, i) => {
        const text = st.lines.join("\n");
        return { index: i, text, visualPrompt: `A cheerful children's cartoon scene about ${this.props.input.topic}. It shows what these words say: ${text.replace(/\n/g, " ")}`, motion: motions[i % motions.length]! };
      }),
    });
    this.props.approved = this.props.approved.filter((s) => stepIndex(s) < stepIndex("scenes"));
    this.redoFrom("scenes");
    this.completeStep("scenes");
    this.props.approved.push("scenes");
    if (this.props.status === "done" || this.props.status === "review") this.props.status = "paused";
    this.touch();
  }

  /** Skip the Character step: no character sheet. Pictures and videos already made are thrown away (they used it). */
  skipCharacter(): void {
    this.assertEditable();
    if (!this.isStepDone("scenes")) throw new ConflictError("Make the scenes first");
    this.props.character = { ...NO_CHARACTER };
    this.props.approved = this.props.approved.filter((s) => stepIndex(s) < stepIndex("character"));
    if (this.isStepDone("character")) this.redoFrom("clips");
    else this.completeStep("character");
    this.props.approved.push("character");
    if (this.props.status === "done" || this.props.status === "review") this.props.status = "paused";
    this.touch();
  }

  /**
   * Skip the Audio step: no song or voice from the audio AI. The video AI sings / speaks each scene in its clip
   * (moving video), with no background music. The poem and pictures are kept; the scene videos are made again
   * with sound. Returns true when the clips have to be made again.
   */
  skipAudio(): boolean {
    this.assertEditable();
    if (!this.isStepDone("character")) throw new ConflictError("Make the character first");
    const already = soundInVideo(this.props.input) !== null && this.props.input.backgroundMusic === false && this.isStepDone("audio");
    if (already) return false;
    this.props.input = { ...this.props.input, videoAudio: true, backgroundMusic: false, videoMode: "veo" };
    this.props.song = null;
    this.redoFrom("audio");
    this.completeStep("audio");
    this.props.approved.push("audio");
    if (this.props.status === "done" || this.props.status === "review") this.props.status = "paused";
    this.touch();
    return true;
  }

  /** Undo `skipAudio`: the audio AI makes the song / voice again (the poem and pictures are kept). */
  useAudioAi(): boolean {
    this.assertEditable();
    if (this.props.input.audioMode === "character") throw new ValidationError('"The character speaks" always uses the video AI; pick another Audio choice in the Audio settings first');
    if (!this.props.input.videoAudio) return false;
    this.props.input = { ...this.props.input, videoAudio: false };
    this.invalidateAfterEdit("audio", "audio");
    if (this.props.status === "review") this.props.status = "paused";
    return true;
  }

  /** Turn every scene's picture on or off at once (Skip pictures on the Scenes / Clips page). */
  setAllScenePictures(on: boolean): void {
    for (const s of this.props.scenes?.scenes ?? []) this.setScenePicture(s.index, on);
    if (!this.props.scenes) throw new ConflictError("Make the scenes first");
  }

  /** Turn one scene's picture on or off (moving video only). Nothing already made is thrown away. */
  setScenePicture(index: number, on: boolean): void {
    this.assertEditable();
    const scene = this.props.scenes?.scenes[index];
    if (!scene) throw new ValidationError(`No scene ${index + 1}`);
    if (!on && this.props.input.videoMode !== "veo") throw new ValidationError("Animated pictures need a picture for every scene; switch Visuals to moving video clips first");
    scene.picture = on;
    this.touch();
  }

  setReviewMode(mode: ReviewMode): void {
    this.assertEditable();
    if (!ReviewModeSchema.safeParse(mode).success) throw new ValidationError(`Unknown mode "${mode}"`);
    this.props.input = { ...this.props.input, reviewMode: mode };
    this.touch();
  }

  /**
   * Replace the poem with an edited version. By default the scenes are planned again from it; with
   * `keepVisuals` the scenes (and their pictures/videos) stay and just get the new words, so only the
   * audio, clip timing and final video are made again.
   */
  editPoem(poem: Poem, opts: { keepVisuals?: boolean } = {}): void {
    this.assertEditable();
    if (poem.stanzas.length !== this.props.input.sceneCount) {
      throw new ValidationError(`The poem needs exactly ${this.props.input.sceneCount} stanzas (one per scene); it has ${poem.stanzas.length}`);
    }
    if (opts.keepVisuals) {
      if (!this.isStepDone("scenes")) throw new ConflictError("There are no scenes to keep yet");
      this.props.poem = poem;
      this.rewordScenes();
      this.invalidateAfterEdit("poem", "audio");
      return;
    }
    this.props.poem = poem;
    this.props.scenes = null;
    this.props.publish = null;
    this.invalidateAfterEdit("poem", "scenes");
  }

  /** Replace scene texts/visual descriptions; the character is kept, audio and clips are made again. */
  editScenes(plan: ScenePlan): void {
    this.assertEditable();
    const current = this.props.scenes?.scenes.length;
    if (current === undefined) throw new ConflictError("Scenes haven't been generated yet");
    if (plan.scenes.length !== current) throw new ValidationError(`Keep ${current} scenes (one per stanza); got ${plan.scenes.length}`);
    this.setScenes(plan);
    this.invalidateAfterEdit("scenes", "audio");
  }

  /** Replace the character's name/look; only the character image and later steps are made again. */
  editCharacter(character: Character): void {
    this.assertEditable();
    this.props.character = character;
    this.invalidateAfterEdit("character", "character");
  }

  /**
   * Use a character the user supplied (uploaded picture). The audio is kept; only the clips and the
   * final video, which draw the character, have to be made again.
   */
  useCharacter(character: Character): void {
    this.assertEditable();
    if (!this.isStepDone("scenes")) throw new ConflictError("Make the scenes first");
    this.props.character = character;
    this.props.approved = this.props.approved.filter((s) => stepIndex(s) < stepIndex("character"));
    if (this.isStepDone("character")) this.redoFrom("clips");
    else this.completeStep("character");
    if (this.props.status === "done") this.props.status = "paused";
    // Manual mode: check the new character before going on.
    if (this.needsReview("character") && this.props.status !== "failed") this.props.status = "review";
    this.touch();
  }

  /**
   * Use your own recording as the audio (Audio page upload). The poem, scenes, character and pictures are kept;
   * only the clips are re-timed to the recording and the final video is built again.
   */
  useRecording(song: SongTimeline): void {
    this.assertEditable();
    if (!this.isStepDone("character")) throw new ConflictError("Make the poem, scenes and character first");
    this.props.song = { ...song, source: "upload" };
    this.props.approved = this.props.approved.filter((s) => stepIndex(s) < stepIndex("audio"));
    // Choosing the audio means the steps before it are accepted (like making a step on its own page).
    for (const s of ["poem", "scenes", "character"] as const) if (!this.props.approved.includes(s)) this.props.approved.push(s);
    if (this.isStepDone("audio")) this.redoFrom("clips");
    else this.completeStep("audio");
    if (this.props.status === "done") this.props.status = "paused";
    this.touch();
  }

  /** Put the poem's stanzas into the existing scenes (one each), keeping what every scene shows. */
  rewordScenes(): void {
    const { poem, scenes } = this.props;
    if (!poem || !scenes || scenes.scenes.length !== poem.stanzas.length) throw new ConflictError("The poem and scenes don't match up");
    this.props.scenes = { scenes: scenes.scenes.map((s, i) => ({ ...s, text: poem.stanzas[i]!.lines.join("\n") })) };
    this.touch();
  }

  /** Drop the scene plan so it's planned again (pipeline redo from poem/scenes). */
  forgetScenes(): void {
    this.props.scenes = null;
    this.touch();
  }

  /**
   * Throw away a step's output so it is generated again from scratch. For the poem, `keepVisuals` keeps
   * the scenes so the new poem's words go into them (pictures and videos are reused).
   */
  regenerate(step: StepName, opts: { keepVisuals?: boolean } = {}): void {
    this.assertEditable();
    if (step === "poem" && opts.keepVisuals && !this.isStepDone("scenes")) throw new ConflictError("There are no scenes to keep yet");
    if (step === "poem") (this.props.poem = null), opts.keepVisuals || (this.props.scenes = null);
    if (step === "scenes") this.props.scenes = null;
    if (step === "character") this.props.character = null;
    if (step === "audio") this.props.song = null;
    this.invalidateAfterEdit(step, step);
  }

  /**
   * Make one step again but keep what the later steps made (character, audio, scene pictures and videos). Only the
   * clips and the final video, which are put together from them at no AI cost, have to be made again.
   */
  regenerateKeepingLater(step: StepName): void {
    this.assertEditable();
    if (!(KEEP_LATER_STEPS as readonly string[]).includes(step)) throw new ValidationError(`"${step}" can't be made again on its own`);
    if (step === "scenes") this.props.scenes = null;
    if (step === "character") this.props.character = null;
    if (step === "audio") this.props.song = null;
    const drop: StepName[] = [step, "clips", "final"];
    this.props.completed = this.props.completed.filter((s) => !drop.includes(s));
    this.props.approved = this.props.approved.filter((s) => !drop.includes(s));
    if (this.props.status === "done" || this.props.status === "review") this.props.status = "paused";
    this.touch();
  }

  /** Remove approvals from `reviewFrom` on and progress from `redoFrom` on. */
  private invalidateAfterEdit(reviewFrom: StepName, redoFrom: StepName) {
    this.props.approved = this.props.approved.filter((s) => stepIndex(s) < stepIndex(reviewFrom));
    this.redoFrom(redoFrom);
    if (this.props.status === "done") this.props.status = "paused";
  }

  private assertEditable() {
    if (this.isRunning) throw new ConflictError(`Project "${this.id}" is running; stop it first`);
  }

  /** Next step to run, or undefined when everything is done. */
  get nextStep(): StepName | undefined {
    return STEP_NAMES.find((s) => !this.props.completed.includes(s));
  }

  isStepDone(step: StepName): boolean {
    return this.props.completed.includes(step);
  }

  start(provider: string): void {
    if (this.isRunning) throw new ConflictError(`Project "${this.id}" is already running`);
    this.props.provider = provider;
    this.props.status = "running";
    this.props.error = null;
    this.touch();
  }

  pause(reason: string | null = null): void {
    this.props.status = "paused";
    this.props.error = reason;
    this.touch();
  }

  fail(error: string): void {
    this.props.status = "failed";
    this.props.error = error;
    this.touch();
  }

  finish(): void {
    if (this.nextStep) throw new ConflictError(`Cannot finish: step "${this.nextStep}" is not done`);
    this.props.status = "done";
    this.props.error = null;
    this.touch();
  }

  /** Forget progress from `step` onward (artifacts stay until overwritten). */
  redoFrom(step: StepName): void {
    this.props.completed = this.props.completed.filter((s) => stepIndex(s) < stepIndex(step));
    this.props.approved = this.props.approved.filter((s) => stepIndex(s) < stepIndex(step));
    this.touch();
  }

  completeStep(step: StepName): void {
    const missing = STEP_NAMES.slice(0, stepIndex(step)).find((s) => !this.props.completed.includes(s));
    if (missing) throw new ConflictError(`Cannot complete "${step}" before "${missing}"`);
    if (!this.props.completed.includes(step)) this.props.completed.push(step);
    this.touch();
  }

  /**
   * Change the video's settings after it was started. Returns the first step that has to be made again
   * (null when nothing changed). Only what depends on the changed settings is thrown away:
   * - topic, language, song/story, length, scenes, age → the poem (the character is kept);
   *   with `keepPoem`, a new length with the same number of scenes keeps the poem and pictures and only redoes the audio
   * - art style, character → the character and what comes after it
   * - voice → the audio · shape → the pictures and clips · quality → the clips
   * `sceneCount: null` means "pick it from the length"; `lengthSeconds: null` removes the target length.
   */
  changeSettings(patch: Record<string, unknown>, opts: { keepPoem?: boolean } = {}): StepName | null {
    this.assertEditable();
    const unknown = Object.keys(patch).filter((k) => !(SETTING_KEYS as readonly string[]).includes(k));
    if (unknown.length) throw new ValidationError(`These can't be changed here: ${unknown.join(", ")}`);
    const next: Record<string, unknown> = { ...this.props.input, ...patch };
    for (const k of ["sceneCount", "lengthSeconds", "characterHint", "voice", "singer", "videoConcurrency"]) if (next[k] === null || next[k] === "") delete next[k];
    const parsed = ProjectInputSchema.safeParse(next);
    if (!parsed.success) throw new ValidationError("Invalid settings", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    const input = parsed.data;
    const old = this.props.input;
    const changed = SETTING_KEYS.filter((k) => JSON.stringify(old[k] ?? null) !== JSON.stringify(input[k] ?? null));
    if (!changed.length) return null;
    // How fast to work, or whether scenes still to be made get a picture, changes nothing already made: just remember it.
    if (changed.every((k) => k === "videoConcurrency" || k === "scenePictures")) {
      this.props.input = parsed.data;
      this.touch();
      return null;
    }

    const has = (keys: readonly string[]) => changed.some((k) => keys.includes(k));
    const onlyLength = changed.every((k) => ["lengthSeconds", "songSeconds", "voice", "singer"].includes(k));
    let from: StepName;
    // Sound inside the clips changes how long each stanza is (one ~8 s clip per scene): new words.
    if (has(["topic", "language", "audioMode", "videoAudio", "lengthSeconds", "songSeconds", "sceneCount", "ageRange"])) {
      from = opts.keepPoem && onlyLength && this.props.poem && this.isStepDone("scenes") ? "audio" : "poem";
    } else if (has(["style", "characterHint"])) from = "character";
    else if (has(["voice", "singer", "backgroundMusic"])) from = "audio";
    else from = "clips"; // aspectRatio, resolution, videoMode (pictures and videos already made are kept)

    this.props.input = input;
    if (from === "poem") {
      this.props.poem = null;
      this.props.scenes = null;
      this.props.song = null;
    }
    if (from === "character" && has(["characterHint"])) this.props.character = null;
    if (from === "audio") this.props.song = null;
    this.invalidateAfterEdit(from, from);
    return from;
  }

  /** Extra wishes for the audio (used the next time the audio is made); empty = none. */
  setAudioRequest(text: unknown): void {
    this.assertEditable();
    const parsed = ProjectInputSchema.safeParse({ ...this.props.input, audioRequest: typeof text === "string" ? text : undefined });
    if (!parsed.success) throw new ValidationError("The audio wish is too long (max 500 characters)");
    this.props.input = { ...this.props.input, audioRequest: parsed.data.audioRequest };
    this.touch();
  }

  /** Turn the lyrics/caption subtitles on or off; only the final video has to be built again. */
  setSubtitles(on: boolean): void {
    this.assertEditable();
    if (typeof on !== "boolean") throw new ValidationError("subtitles must be true or false");
    this.props.input = { ...this.props.input, subtitles: on };
    if (this.isStepDone("final")) {
      this.redoFrom("final");
      if (this.props.status === "done") this.props.status = "paused";
    }
    this.touch();
  }

  /**
   * Switch between animated stills and Veo video. Keeps the poem, song and scene pictures;
   * only the clips and final video need to be rendered again.
   */
  changeVisuals(mode: VideoMode): boolean {
    if (this.isRunning) throw new ConflictError(`Project "${this.id}" is running; stop it before changing visuals`);
    if (!VideoModeSchema.safeParse(mode).success) throw new ValidationError(`Unknown visuals "${mode}"`);
    if (mode === "still" && soundInVideo(this.props.input)) throw new ValidationError("The voice / song is made inside the video clips, so they must be moving video; change the audio first");
    const changed = this.props.input.videoMode !== mode;
    this.props.input = { ...this.props.input, videoMode: mode };
    this.redoFrom("clips");
    return changed;
  }

  /** Move the video to another channel; its next runs use that channel's prompts. */
  moveTo(channelId: string): void {
    this.assertEditable();
    this.props.channelId = channelId;
    this.touch();
  }

  setPoem(poem: Poem): void {
    this.props.poem = poem;
    this.props.publish = null;
    this.touch();
  }

  setScenes(plan: ScenePlan): void {
    // Normalise indices so file layout and timelines can rely on 0..n-1.
    this.props.scenes = { scenes: plan.scenes.map((s, i) => ({ ...s, index: i })) };
    this.touch();
  }

  setCharacter(character: Character): void {
    this.props.character = character;
    this.touch();
  }

  /** YouTube upload info (generated or edited); clamped to YouTube's limits. */
  setPublish(info: PublishInfo | null): void {
    this.props.publish = info ? normalizePublishInfo(info) : null;
    this.touch();
  }

  setSong(song: SongTimeline | null): void {
    this.props.song = song;
    this.touch();
  }

  toProps(): ProjectProps {
    return { ...this.props, completed: [...this.props.completed], approved: [...this.props.approved] };
  }

  private touch() {
    this.props.updatedAt = new Date();
  }
}
