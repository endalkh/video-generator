import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import { GenerationMapper } from "../domain/generation/generation.mapper.js";
import type { GenerationDto } from "../domain/generation/generation.model.js";
import type { Provider } from "../domain/ports/generator.port.js";
import { Project } from "../domain/project/project.entity.js";
import { ProjectMapper, type ProjectDto, type ProjectSummaryDto } from "../domain/project/project.mapper.js";
import { CharacterSchema, MAX_VIDEO_SECONDS, PoemSchema, ProjectInputSchema, ScenePlanSchema, STEP_NAMES, type StepName } from "../domain/project/project.model.js";
import type { GenerationRepository, ProjectRepository } from "../repositories/repositories.js";
import { audioToWav, imageToPng, probeDuration } from "../infrastructure/media/ffmpeg.js";
import { songTimeline } from "../domain/ports/generator.port.js";
import { fileExists, slugify, writeFileAtomic } from "../util/fs.js";
import { log } from "../util/log.js";
import { mediaPaths, wipeMediaFrom, wipePictures, wipeRenders, wipeScene, PipelineCancelled, type PipelineEvent, type PipelineService } from "./pipeline.service.js";

export type ProviderFactory = (name: string) => Provider;

export interface ProjectDetailsDto extends ProjectDto {
  running: boolean;
  lastEvent: PipelineEvent | null;
  media: {
    characterImage: string | null;
    final: string | null;
    subtitles: string | null;
    scenes: { index: number; image: string | null; clip: string | null; video: string | null; audio: string | null }[];
  };
}

interface Job {
  controller: AbortController;
  events: PipelineEvent[];
  listeners: Set<(e: PipelineEvent) => void>;
  done: Promise<void>;
}

/** Project use cases: create, query, and run/resume/cancel the pipeline in the background. */
export class ProjectService {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly projects: ProjectRepository,
    private readonly generations: GenerationRepository,
    private readonly pipeline: PipelineService,
    private readonly providers: ProviderFactory,
  ) {}

  /** Call at startup: rows left "running" by a crashed process can be resumed. */
  async recoverInterrupted(): Promise<void> {
    const n = await this.projects.pauseAllRunning("interrupted");
    if (n) log.warn(`${n} interrupted project(s) marked as paused; resume them from the UI or with --resume`);
  }

  /** Throws NotFoundError for unknown channels (set by the container). */
  assertChannel: (channel: string) => Promise<void> = async () => {};

  async create(rawInput: unknown, providerName: string, opts: { channelId?: string | null } = {}): Promise<ProjectDto> {
    const parsed = ProjectInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError("Invalid project input", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`));
    this.providers(providerName); // validate provider (e.g. missing API key) before creating anything
    if (opts.channelId) await this.assertChannel(opts.channelId);
    const base = slugify(parsed.data.topic);
    for (let n = 1; n < 1000; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (await this.projects.exists(id)) continue;
      const project = Project.create({ id, input: parsed.data, provider: providerName, channelId: opts.channelId ?? null });
      try {
        await this.projects.create(project);
        return ProjectMapper.toDto(project);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err; // lost a race for this id; try the next
      }
    }
    throw new ConflictError("Could not allocate a project id");
  }

  /** Videos of a channel (or every video when `channel` is undefined), newest first. */
  async list(channel?: string): Promise<(ProjectSummaryDto & { running: boolean; hasVideo: boolean })[]> {
    if (channel) await this.assertChannel(channel);
    const all = await this.projects.list({ channelId: channel, limit: 500 });
    return Promise.all(
      all.map(async (p) => ({ ...ProjectMapper.toSummaryDto(p), running: this.jobs.has(p.id), hasVideo: await fileExists(mediaPaths(this.pipeline.mediaDir(p.id)).final) })),
    );
  }

  async get(id: string): Promise<ProjectDetailsDto> {
    const project = await this.load(id);
    const p = mediaPaths(this.pipeline.mediaDir(id));
    const rel = async (file: string) => ((await fileExists(file)) ? path.relative(p.dir, file).split(path.sep).join("/") : null);
    const job = this.jobs.get(id);
    return {
      ...ProjectMapper.toDto(project),
      running: Boolean(job),
      lastEvent: job?.events.at(-1) ?? this.lastEvents.get(id) ?? null,
      media: {
        characterImage: await rel(p.characterImage),
        final: await rel(p.final),
        subtitles: await rel(p.srt),
        scenes: await Promise.all((project.scenes?.scenes ?? []).map(async (s) => ({ index: s.index, image: await rel(p.sceneImage(s.index)), clip: await rel(p.sceneClip(s.index)), video: await rel(p.sceneVideo(s.index)), audio: await rel(p.sceneAudio(s.index)) }))),
      },
    };
  }

  async generationsOf(id: string): Promise<GenerationDto[]> {
    await this.load(id);
    return (await this.generations.listByProject(id)).map(GenerationMapper.toDto);
  }

  /** Absolute path of a project media file, or undefined if it's outside the project folder. */
  mediaFile(id: string, relative: string[]): string | undefined {
    const dir = this.pipeline.mediaDir(id);
    const file = path.resolve(dir, ...relative);
    return file.startsWith(dir + path.sep) ? file : undefined;
  }

  /** Start (or resume) in the background; progress is published to subscribers. */
  async start(id: string, opts: { provider?: string; from?: string; until?: StepName } = {}): Promise<void> {
    if (this.jobs.has(id)) throw new ConflictError(`Project "${id}" is already running`);
    const project = await this.load(id);
    if (opts.from !== undefined && !STEP_NAMES.includes(opts.from as StepName)) throw new ValidationError(`Unknown step "${opts.from}"`);
    const provider = this.providers(opts.provider ?? project.provider);
    const job: Job = { controller: new AbortController(), events: [], listeners: new Set(), done: Promise.resolve() };
    this.jobs.set(id, job);
    const onEvent = (e: PipelineEvent) => {
      job.events.push(e);
      if (job.events.length > 500) job.events.splice(0, 100);
      for (const l of job.listeners) l(e);
    };
    job.done = this.pipeline
      // "final" ends the run anyway, so it never needs an explicit stop.
      .run(project, { provider, from: opts.from as StepName | undefined, until: opts.until === "final" ? undefined : opts.until, signal: job.controller.signal, onEvent })
      .then(
        () => undefined,
        (err) => {
          if (!(err instanceof PipelineCancelled)) log.error(`[${id}] ${(err as Error).message}`);
        },
      )
      .finally(() => {
        this.jobs.delete(id);
        this.lastEvents.set(id, job.events.at(-1) ?? null);
      });
  }

  /** Switch visuals (stills ↔ Veo) and re-render only the clips and final video. */
  async changeVisuals(id: string, videoMode: string): Promise<ProjectDto> {
    if (this.jobs.has(id)) throw new ConflictError(`Project "${id}" is running; stop it first`);
    const project = await this.load(id);
    project.changeVisuals(videoMode as never);
    await wipeRenders(mediaPaths(this.pipeline.mediaDir(id)));
    await this.projects.save(project);
    await this.start(id);
    return ProjectMapper.toDto(project);
  }

  /**
   * Change settings (length, scenes, language, song/story, style, shape…) after the video was started.
   * Only the steps that depend on what changed are made again; nothing is generated until asked for.
   */
  async changeSettings(id: string, patch: unknown, opts: { keepPoem?: boolean } = {}): Promise<{ project: ProjectDto; redoFrom: StepName | null }> {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new ValidationError("settings must be an object");
    const project = await this.loadIdle(id);
    const from = project.changeSettings(patch as Record<string, unknown>, opts);
    if (from) {
      const media = this.media(id);
      if (from === "poem") {
        // New words and scenes, same character: keep the character picture, repaint the scenes.
        await wipeMediaFrom(media, "audio");
        await wipePictures(media);
      } else await wipeMediaFrom(media, from);
      await this.projects.save(project);
    }
    return { project: ProjectMapper.toDto(project), redoFrom: from };
  }

  /** Move a video to another channel; it keeps everything it made, and its next runs use that channel's prompts. */
  async moveToChannel(id: string, channel: string): Promise<ProjectDto> {
    await this.assertChannel(channel);
    const project = await this.loadIdle(id);
    project.moveTo(channel);
    await this.projects.save(project);
    return ProjectMapper.toDto(project);
  }

  /**
   * Re-create a video as a new copy with the same settings (and channel), then start it. The original stays as it is.
   * `keepPoem`: start from the same words (new scenes, pictures, audio and clips).
   * `keepCharacter`: reuse the same character and its picture, so it looks the same (default).
   */
  async recreate(id: string, opts: { keepPoem?: boolean; keepCharacter?: boolean; provider?: string } = {}): Promise<ProjectDto> {
    const source = await this.load(id);
    const keepPoem = opts.keepPoem === true && source.poem !== null;
    const keepCharacter = opts.keepCharacter !== false && source.character !== null;
    const { audioRequest: _wish, ...input } = source.input; // a fresh start: no leftover audio wish
    const created = await this.create(input, opts.provider ?? source.provider, { channelId: source.channelId });
    const copy = await this.load(created.id);
    if (keepPoem) {
      copy.setPoem(source.poem!);
      copy.completeStep("poem");
      copy.approve("poem");
    }
    if (keepCharacter) {
      copy.setCharacter(source.character!);
      const from = this.media(id).characterImage;
      if (await fileExists(from)) await writeFileAtomic(this.media(copy.id).characterImage, await readFile(from));
    }
    await this.projects.save(copy);
    await this.start(copy.id);
    return ProjectMapper.toDto(copy);
  }

  /** Delete a video: its database row, prompt log and every media file. */
  async delete(id: string): Promise<void> {
    await this.loadIdle(id);
    await this.projects.delete(id);
    await rm(this.pipeline.mediaDir(id), { recursive: true, force: true });
    this.lastEvents.delete(id);
  }

  /** Every video of a channel (all of them, for moving or deleting a channel). */
  async idsInChannel(channel: string | null): Promise<string[]> {
    return (await this.projects.list({ channelId: channel, limit: 100_000 })).map((p) => p.id);
  }

  isRunning(id: string): boolean {
    return this.jobs.has(id);
  }

  /** Show or hide the lyrics/caption subtitles; rebuilds only the final video if the clips are ready. */
  async setSubtitles(id: string, on: unknown): Promise<ProjectDto> {
    const project = await this.loadIdle(id);
    project.setSubtitles(on as boolean);
    await rm(this.media(id).final, { force: true });
    await this.projects.save(project);
    if (project.isStepDone("clips")) await this.start(id, { until: "final" });
    return ProjectMapper.toDto(project);
  }

  // ---------- Manual review ----------

  /** Approve the step under review and continue to the next one. */
  async approve(id: string, step: string): Promise<void> {
    const project = await this.loadIdle(id);
    project.approve(this.step(step));
    await this.projects.save(project);
    await this.start(id);
  }

  async setReviewMode(id: string, mode: string): Promise<ProjectDto> {
    const project = await this.loadIdle(id);
    project.setReviewMode(mode as never);
    await this.projects.save(project);
    return ProjectMapper.toDto(project);
  }

  /**
   * Save an edited poem. The character is kept. By default the scenes are planned again (new pictures);
   * with `keepVisuals` the pictures and Veo videos stay, and only the audio, clip timing and final video are redone.
   */
  async editPoem(id: string, raw: unknown, opts: { keepVisuals?: boolean } = {}): Promise<ProjectDto> {
    const poem = parse(PoemSchema, raw, "poem");
    const project = await this.loadIdle(id);
    // "The character speaks": her voice is inside each Veo clip, so new words always need new clips.
    const keep = opts.keepVisuals === true && project.input.audioMode !== "character";
    project.editPoem(poem, { keepVisuals: keep });
    await wipeMediaFrom(this.media(id), "audio");
    if (!keep) await wipePictures(this.media(id));
    await this.projects.save(project);
    return ProjectMapper.toDto(project);
  }

  /** Save edited scene words / picture descriptions. The audio and clips are redone; only scenes whose picture description changed get new pictures. */
  async editScenes(id: string, raw: unknown): Promise<ProjectDto> {
    const plan = parse(ScenePlanSchema, raw, "scenes");
    const project = await this.loadIdle(id);
    const before = project.scenes?.scenes ?? [];
    project.editScenes(plan);
    const media = this.media(id);
    await wipeMediaFrom(media, "audio");
    const speaks = project.input.audioMode === "character";
    for (const s of project.scenes!.scenes) {
      if (s.visualPrompt !== before[s.index]?.visualPrompt || (speaks && s.text !== before[s.index]?.text)) await wipeScene(media, s.index);
    }
    await this.projects.save(project);
    return ProjectMapper.toDto(project);
  }

  /**
   * Write one stanza (scene) again without touching the rest of the poem. `draft` is the poem as it is in the
   * editor (may have unsaved edits). Returns the new lines only; saving them is the normal "Save changes".
   */
  async rewriteStanza(id: string, index: number, opts: { draft?: unknown; hint?: string; provider?: string } = {}): Promise<{ index: number; lines: string[] }> {
    const project = await this.loadIdle(id);
    const poem = opts.draft === undefined ? project.poem : parse(PoemSchema, opts.draft, "poem");
    if (!poem) throw new ConflictError("Write the poem first");
    if (!Number.isInteger(index) || index < 0 || index >= poem.stanzas.length) throw new ValidationError(`No stanza ${index + 1}`);
    const provider = this.providers(opts.provider ?? project.provider);
    return { index, lines: await this.pipeline.rewriteStanza(project, poem, index, provider, opts.hint) };
  }

  /** Save an edited character and redraw its picture, then stop so it can be checked. */
  async editCharacter(id: string, raw: unknown): Promise<ProjectDto> {
    const character = parse(CharacterSchema, raw, "character");
    const project = await this.loadIdle(id);
    project.editCharacter(character);
    await wipeMediaFrom(this.media(id), "character");
    await this.projects.save(project);
    await this.start(id, { until: "character" });
    return ProjectMapper.toDto(project);
  }

  /**
   * Use an uploaded picture as the main character. Without a description, the character model looks at the
   * picture and writes one (it's reused in every scene prompt). The audio is kept; clips are made again.
   */
  async uploadCharacter(id: string, raw: { image?: unknown; name?: unknown; description?: unknown }, opts: { provider?: string } = {}): Promise<ProjectDto> {
    const project = await this.loadIdle(id);
    if (!project.isStepDone("scenes")) throw new ConflictError("Make the scenes first");
    const picture = await toPng(raw.image);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const character = description
      ? parse(CharacterSchema, { name: name || project.character?.name, description }, "character")
      : await this.pipeline.describeCharacter(project, picture, this.providers(opts.provider ?? project.provider), name || undefined);
    if (this.jobs.has(id)) throw new ConflictError(`Project "${id}" is running; stop it first`); // started while the model was looking
    for (const s of ["poem", "scenes"] as const) project.approve(s);
    project.useCharacter(character);
    const media = this.media(id);
    await wipeMediaFrom(media, "clips");
    await writeFileAtomic(media.characterImage, picture);
    await this.projects.save(project);
    return ProjectMapper.toDto(project);
  }

  /**
   * Use your own recording (you or your child singing or reading) as the audio. The scenes are timed to it by
   * the length of each scene's words. Pictures and Veo videos are kept; the clips and final video are made again.
   */
  async uploadAudio(id: string, raw: { audio?: unknown }): Promise<ProjectDto> {
    const project = await this.loadIdle(id);
    if (!project.isStepDone("character") || !project.scenes) throw new ConflictError("Make the poem, scenes and character first");
    const m = typeof raw.audio === "string" ? /^data:((?:audio|video)\/[\w.+-]+)(?:;[^,]*)?;base64,(.*)$/s.exec(raw.audio) : null;
    if (!m) throw new ValidationError("Upload an audio file (MP3, M4A, WAV, OGG or WebM)");
    const bytes = Buffer.from(m[2]!, "base64");
    if (bytes.length < 1000) throw new ValidationError("That recording is empty");
    if (bytes.length > MAX_AUDIO_UPLOAD_BYTES) throw new ValidationError(`The recording is too big (max ${MAX_AUDIO_UPLOAD_BYTES / 1024 / 1024} MB)`);
    const dir = await mkdtemp(path.join(os.tmpdir(), "kids-studio-audio-"));
    try {
      await writeFile(path.join(dir, "in"), bytes);
      const wav = path.join(dir, "song.wav");
      await audioToWav(path.join(dir, "in"), wav).catch(() => {
        throw new ValidationError("Couldn't read that recording; upload an MP3, M4A, WAV, OGG or WebM file");
      });
      const duration = await probeDuration(wav);
      if (duration < 3) throw new ValidationError("The recording is shorter than 3 seconds");
      if (duration > MAX_VIDEO_SECONDS + 30) throw new ValidationError(`The recording is longer than ${MAX_VIDEO_SECONDS / 60} minutes`);
      if (this.jobs.has(id)) throw new ConflictError(`Project "${id}" is running; stop it first`);
      const media = this.media(id);
      await wipeMediaFrom(media, "audio");
      await writeFileAtomic(media.song("wav"), await readFile(wav));
      project.useRecording({ file: "song.wav", duration, slots: songTimeline(project.scenes.scenes, duration) });
      await this.projects.save(project);
      return ProjectMapper.toDto(project);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Throw away a step's output and generate it again (only that step; later steps must be made again). */
  async regenerate(id: string, step: string, opts: { provider?: string; keepVisuals?: boolean } = {}): Promise<void> {
    const name = this.step(step);
    const project = await this.loadIdle(id);
    await this.makeFresh(project, name, opts.keepVisuals === true);
    await this.projects.save(project);
    await this.start(id, { provider: opts.provider, until: name });
  }

  /**
   * Generate one step on its own (each step has its own page in the UI). The steps before it must be done;
   * asking for the next step counts as approving them. A step that's already done is made again from scratch.
   */
  async generateStep(id: string, step: string, opts: { provider?: string; keepVisuals?: boolean; audioRequest?: string } = {}): Promise<void> {
    const name = this.step(step);
    const project = await this.loadIdle(id);
    if (name === "audio" && opts.audioRequest !== undefined) project.setAudioRequest(opts.audioRequest);
    const missing = STEP_NAMES.slice(0, STEP_NAMES.indexOf(name)).find((s) => !project.isStepDone(s));
    if (missing) throw new ConflictError(`Make the ${missing} first`);
    if (opts.provider) this.providers(opts.provider); // fail fast (e.g. missing API key) before wiping anything
    for (const s of STEP_NAMES.slice(0, STEP_NAMES.indexOf(name))) project.approve(s);
    if (project.isStepDone(name)) await this.makeFresh(project, name, opts.keepVisuals === true);
    await this.projects.save(project);
    await this.start(id, { provider: opts.provider, until: name });
  }

  /** Forget a step's output and delete its media. A new poem with `keepVisuals` keeps the pictures and videos. */
  private async makeFresh(project: Project, step: StepName, keepVisuals: boolean): Promise<void> {
    const keep = keepVisuals && step === "poem" && project.input.audioMode !== "character";
    project.regenerate(step, { keepVisuals: keep });
    await wipeMediaFrom(this.media(project.id), keep ? "audio" : step);
  }

  /** Make one scene's picture and clip again, keeping the others. */
  async redoScene(id: string, index: number): Promise<void> {
    const project = await this.loadIdle(id);
    const count = project.scenes?.scenes.length ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new ValidationError(`No scene ${index + 1}`);
    project.redoFrom("clips");
    await wipeScene(this.media(id), index);
    await this.projects.save(project);
    await this.start(id, { until: "clips" });
  }

  private media(id: string) {
    return mediaPaths(this.pipeline.mediaDir(id));
  }

  private step(step: string): StepName {
    if (!STEP_NAMES.includes(step as StepName)) throw new ValidationError(`Unknown step "${step}"`);
    return step as StepName;
  }

  private async loadIdle(id: string): Promise<Project> {
    if (this.jobs.has(id)) throw new ConflictError(`Project "${id}" is running; stop it first`);
    return this.load(id);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    job?.controller.abort();
    return Boolean(job);
  }

  /** Subscribe to live events; replays recent ones. Returns an unsubscribe function. */
  subscribe(id: string, listener: (e: PipelineEvent) => void): () => void {
    const job = this.jobs.get(id);
    if (!job) {
      const last = this.lastEvents.get(id);
      if (last) listener(last);
      return () => {};
    }
    for (const e of job.events.slice(-50)) listener(e);
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  /** Wait for background runs to settle (graceful shutdown, tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }

  async shutdown(): Promise<void> {
    for (const j of this.jobs.values()) j.controller.abort();
    await this.idle();
  }

  private readonly lastEvents = new Map<string, PipelineEvent | null>();

  private async load(id: string): Promise<Project> {
    const project = await this.projects.findById(id);
    if (!project) throw new NotFoundError(`Project "${id}" not found`);
    return project;
  }
}


export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD_BYTES = 30 * 1024 * 1024;

/** Decode a base64 / data-URL picture and normalise it to PNG (also rejects anything that isn't an image). */
export async function toPng(image: unknown): Promise<Buffer> {
  if (typeof image !== "string" || !image) throw new ValidationError("Choose a picture to upload");
  const m = /^data:(image\/(png|jpeg|webp));base64,(.*)$/s.exec(image);
  if (image.startsWith("data:") && !m) throw new ValidationError("Upload a PNG, JPEG or WebP picture");
  const bytes = Buffer.from(m ? m[3]! : image, "base64");
  if (bytes.length < 64) throw new ValidationError("That picture is empty or not valid");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new ValidationError(`The picture is too big (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
  const dir = await mkdtemp(path.join(os.tmpdir(), "kids-studio-upload-"));
  try {
    await writeFile(path.join(dir, "in"), bytes);
    await imageToPng(path.join(dir, "in"), path.join(dir, "out.png")).catch(() => {
      throw new ValidationError("Couldn't read that picture; upload a PNG, JPEG or WebP");
    });
    return await readFile(path.join(dir, "out.png"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, raw: unknown, what: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ValidationError(`Invalid ${what}`, r.error.issues.map((i) => `${i.path.map(String).join(".") || what}: ${i.message}`));
  return r.data;
}
