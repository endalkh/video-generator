import path from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import { GenerationMapper } from "../domain/generation/generation.mapper.js";
import type { GenerationDto } from "../domain/generation/generation.model.js";
import type { Provider } from "../domain/ports/generator.port.js";
import { Project } from "../domain/project/project.entity.js";
import { ProjectMapper, type ProjectDto, type ProjectSummaryDto } from "../domain/project/project.mapper.js";
import { CharacterSchema, PoemSchema, ProjectInputSchema, ScenePlanSchema, STEP_NAMES, type StepName } from "../domain/project/project.model.js";
import type { GenerationRepository, ProjectRepository } from "../repositories/repositories.js";
import { fileExists, slugify } from "../util/fs.js";
import { log } from "../util/log.js";
import { mediaPaths, wipeMediaFrom, wipeRenders, wipeScene, PipelineCancelled, type PipelineEvent, type PipelineService } from "./pipeline.service.js";

export type ProviderFactory = (name: string) => Provider;

export interface ProjectDetailsDto extends ProjectDto {
  running: boolean;
  lastEvent: PipelineEvent | null;
  media: {
    characterImage: string | null;
    final: string | null;
    subtitles: string | null;
    scenes: { index: number; image: string | null; clip: string | null; video: string | null }[];
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

  async create(rawInput: unknown, providerName: string): Promise<ProjectDto> {
    const parsed = ProjectInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError("Invalid project input", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`));
    this.providers(providerName); // validate provider (e.g. missing API key) before creating anything
    const base = slugify(parsed.data.topic);
    for (let n = 1; n < 1000; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (await this.projects.exists(id)) continue;
      const project = Project.create({ id, input: parsed.data, provider: providerName });
      try {
        await this.projects.create(project);
        return ProjectMapper.toDto(project);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err; // lost a race for this id; try the next
      }
    }
    throw new ConflictError("Could not allocate a project id");
  }

  async list(): Promise<(ProjectSummaryDto & { running: boolean; hasVideo: boolean })[]> {
    const all = await this.projects.list();
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
        scenes: await Promise.all((project.scenes?.scenes ?? []).map(async (s) => ({ index: s.index, image: await rel(p.sceneImage(s.index)), clip: await rel(p.sceneClip(s.index)), video: await rel(p.sceneVideo(s.index)) }))),
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
  async start(id: string, opts: { provider?: string; from?: string } = {}): Promise<void> {
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
      .run(project, { provider, from: opts.from as StepName | undefined, signal: job.controller.signal, onEvent })
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

  /** Save an edited poem. Scenes (and later steps) will be planned again from it; the character is kept. */
  async editPoem(id: string, raw: unknown): Promise<ProjectDto> {
    const poem = parse(PoemSchema, raw, "poem");
    const project = await this.loadIdle(id);
    project.editPoem(poem);
    await wipeMediaFrom(this.media(id), "audio");
    await this.projects.save(project);
    return ProjectMapper.toDto(project);
  }

  /** Save edited scene texts / picture descriptions. Song, pictures and clips will be made again. */
  async editScenes(id: string, raw: unknown): Promise<ProjectDto> {
    const plan = parse(ScenePlanSchema, raw, "scenes");
    const project = await this.loadIdle(id);
    project.editScenes(plan);
    await wipeMediaFrom(this.media(id), "audio");
    await this.projects.save(project);
    return ProjectMapper.toDto(project);
  }

  /** Save an edited character and redraw its picture (in manual mode it then stops for review again). */
  async editCharacter(id: string, raw: unknown): Promise<ProjectDto> {
    const character = parse(CharacterSchema, raw, "character");
    const project = await this.loadIdle(id);
    project.editCharacter(character);
    await wipeMediaFrom(this.media(id), "character");
    await this.projects.save(project);
    await this.start(id);
    return ProjectMapper.toDto(project);
  }

  /** Throw away a step's output and generate it again. */
  async regenerate(id: string, step: string): Promise<void> {
    const name = this.step(step);
    const project = await this.loadIdle(id);
    project.regenerate(name);
    await wipeMediaFrom(this.media(id), name);
    await this.projects.save(project);
    await this.start(id);
  }

  /** Make one scene's picture and clip again, keeping the others. */
  async redoScene(id: string, index: number): Promise<void> {
    const project = await this.loadIdle(id);
    const count = project.scenes?.scenes.length ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new ValidationError(`No scene ${index + 1}`);
    project.redoFrom("clips");
    await wipeScene(this.media(id), index);
    await this.projects.save(project);
    await this.start(id);
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


function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, raw: unknown, what: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ValidationError(`Invalid ${what}`, r.error.issues.map((i) => `${i.path.map(String).join(".") || what}: ${i.message}`));
  return r.data;
}
