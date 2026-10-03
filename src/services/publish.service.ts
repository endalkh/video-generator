import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import type { Provider } from "../domain/ports/generator.port.js";
import type { Project } from "../domain/project/project.entity.js";
import { ProjectMapper, type ProjectDto } from "../domain/project/project.mapper.js";
import { PublishInfoSchema, type PublishInfo } from "../domain/project/project.model.js";
import { fitImage } from "../infrastructure/media/ffmpeg.js";
import type { ProjectRepository } from "../repositories/repositories.js";
import { fileExists } from "../util/fs.js";
import { log } from "../util/log.js";
import type { ModelSettingsService } from "./model-settings.service.js";
import { mediaPaths } from "./pipeline.service.js";
import type { ProviderFactory } from "./project.service.js";
import type { PromptService, SnapshotExtras } from "./prompt.service.js";

/** The channel a video belongs to, as far as the upload text needs it. */
export interface ChannelInfo {
  name?: string;
  handle?: string;
  /** "both" = bilingual channel text. */
  language?: string;
}

const BILINGUAL = "both Amharic (Ge'ez script) and English (bilingual: each part in Amharic, then the same in English)";
const THUMB = { width: 1280, height: 720, maxBytes: 2 * 1024 * 1024 };

/**
 * YouTube upload info for a finished video: title, description, tags and a 1280×720 thumbnail. Made automatically
 * when the final video is built (if missing) and on demand from the Final video page; the text can be edited.
 */
export class PublishService {
  /** Set by the container: the video's channel name, handle and language. */
  channelInfo: (channelId: string | null) => Promise<ChannelInfo> = async () => ({});
  /** Set by the container: is the video being made right now? */
  isRunning: (id: string) => boolean = () => false;

  constructor(
    private readonly projects: ProjectRepository,
    private readonly promptService: PromptService,
    private readonly modelSettings: ModelSettingsService,
    private readonly providers: ProviderFactory,
    private readonly mediaDir: (id: string) => string,
  ) {}

  /** Pipeline hook after the final video: make whatever upload info is missing (never fails the video). */
  readonly afterFinal = async (project: Project, provider: Provider): Promise<void> => {
    try {
      if (!project.publish) await this.makeText(project, provider);
      if (!(await fileExists(this.thumbnailFile(project.id)))) await this.makeThumbnail(project, provider);
    } catch (err) {
      log.warn(`[${project.id}] YouTube title/description/thumbnail not made: ${(err as Error).message} (make them on the Final video page)`);
    }
  };

  /** Make the text ("text"), an AI thumbnail ("thumbnail", optional new `title`), or a thumbnail from the first scene's picture ("frame"). */
  async generate(id: string, what: string, opts: { provider?: string; title?: string } = {}): Promise<ProjectDto> {
    if (!["text", "thumbnail", "frame"].includes(what)) throw new ValidationError(`Unknown "${what}" (use text, thumbnail or frame)`);
    if (this.isRunning(id)) throw new ConflictError("The video is being made; wait for it to finish");
    const project = await this.load(id);
    if (!project.poem || !project.scenes) throw new ConflictError("Make the poem and scenes first");
    if (what === "frame") await this.fit(id, await this.firstPicture(project));
    else {
      const provider = this.providers(opts.provider ?? project.provider);
      if (what === "text") await this.makeText(project, provider);
      else await this.makeThumbnail(project, provider, opts.title);
    }
    await this.projects.save(project);
    return ProjectMapper.toDto(project);
  }

  async edit(id: string, raw: unknown): Promise<ProjectDto> {
    if (this.isRunning(id)) throw new ConflictError("The video is being made; wait for it to finish");
    const project = await this.load(id);
    const r = PublishInfoSchema.safeParse(raw);
    if (!r.success) throw new ValidationError("Invalid upload info", r.error.issues.map((i) => `${i.path.join(".") || "publish"}: ${i.message}`));
    project.setPublish(r.data);
    await this.projects.save(project);
    return ProjectMapper.toDto(project);
  }

  thumbnailFile(id: string): string {
    return mediaPaths(this.mediaDir(id)).thumbnail;
  }

  // ---------- generation ----------

  private async makeText(project: Project, provider: Provider): Promise<void> {
    const channel = await this.channelInfo(project.channelId);
    const extras: SnapshotExtras = {
      channel: project.channelId,
      ...(channel.language === "both" ? { languageName: BILINGUAL } : {}),
      flags: { has_channel_name: Boolean(channel.name), ...(channel.language === "both" ? { am: true, en: true } : {}) },
    };
    const [prompts, models] = await Promise.all([this.promptService.snapshotFor(project.input, extras), this.modelSettings.snapshot()]);
    const duration = project.song?.duration ?? project.input.lengthSeconds ?? null;
    const r = prompts.render("video_publish", {
      title: project.poem!.title,
      lyrics: project.poem!.stanzas.map((s) => s.lines.join("\n")).join("\n\n"),
      channel_name: channel.name ?? "",
      channel_handle: channel.handle ? `@${channel.handle}` : "(none)",
      video_length: duration ? (duration < 60 ? `about ${Math.round(duration)} seconds` : `about ${Math.round(duration / 30) / 2} minutes`) : "short",
    });
    const out = await provider.text("publish", r.text, { model: models.channel_text, ctx: { input: project.input, poem: project.poem! } });
    project.setPublish(out);
  }

  private async makeThumbnail(project: Project, provider: Provider, title?: string): Promise<void> {
    const p = mediaPaths(this.mediaDir(project.id));
    const character = await readFile(p.characterImage).catch(() => undefined);
    const scene = await this.firstPicture(project).catch(() => undefined);
    const refs = [character, scene].filter((b): b is Buffer => Boolean(b));
    if (!refs.length) throw new ConflictError("Make the character and pictures first");
    const thumbTitle = (title ?? project.publish?.thumbnailTitle ?? "").trim();
    const channel = await this.channelInfo(project.channelId);
    const [prompts, models] = await Promise.all([
      this.promptService.snapshotFor(project.input, { channel: project.channelId, flags: { has_title: Boolean(thumbTitle), has_channel_name: Boolean(channel.name) } }),
      this.modelSettings.snapshot(),
    ]);
    const r = prompts.render("video_thumbnail", {
      thumbnail_title: thumbTitle,
      character_name: project.character?.name ?? "the main character",
      character_description: project.character?.description ?? "",
      channel_name: channel.name ?? "",
    });
    const image = await provider.image(r.text, { model: models.channel_image, aspectRatio: "16:9", references: refs, label: "video thumbnail", ctx: { input: project.input, poem: project.poem ?? undefined } });
    await this.fit(project.id, image);
    if (project.publish && title !== undefined && title.trim() !== project.publish.thumbnailTitle) project.setPublish({ ...project.publish, thumbnailTitle: title.trim() });
  }

  private async firstPicture(project: Project): Promise<Buffer> {
    const p = mediaPaths(this.mediaDir(project.id));
    for (const s of project.scenes?.scenes ?? []) {
      const img = await readFile(p.sceneImage(s.index)).catch(() => undefined);
      if (img) return img;
    }
    throw new ConflictError("There are no scene pictures yet");
  }

  /** Crop/resize to YouTube's 1280×720, under 2 MB, and swap the file in atomically. */
  private async fit(id: string, picture: Buffer): Promise<void> {
    const out = this.thumbnailFile(id);
    await mkdir(path.dirname(out), { recursive: true });
    const src = `${out}.src`;
    const tmp = `${out}.part.jpg`;
    try {
      await writeFile(src, picture);
      await fitImage({ input: src, out: tmp, ...THUMB });
      await rename(tmp, out);
    } finally {
      await Promise.all([rm(src, { force: true }), rm(tmp, { force: true })]);
    }
  }

  private async load(id: string): Promise<Project> {
    const project = await this.projects.findById(id);
    if (!project) throw new NotFoundError(`Project "${id}" not found`);
    return project;
  }
}
