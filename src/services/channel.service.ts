import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChannelKit, parseChannelDetails, parseChannelInput } from "../domain/channel/channel.entity.js";
import { ChannelKitMapper, type ChannelKitDto } from "../domain/channel/channel.mapper.js";
import { CHANNEL_ASSETS, CHANNEL_IMAGE_SPECS, type ChannelAsset, type ChannelImageAsset } from "../domain/channel/channel.model.js";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import type { Provider } from "../domain/ports/generator.port.js";
import { ProjectInputSchema, type ProjectInput } from "../domain/project/project.model.js";
import { fitImage } from "../infrastructure/media/ffmpeg.js";
import { SHARED } from "../domain/prompt/prompt.entity.js";
import type { ChannelKitRepository, ContentPlanRepository } from "../repositories/repositories.js";
import { log } from "../util/log.js";
import { slugify, writeFileAtomic } from "../util/fs.js";
import type { ModelSettingsService } from "./model-settings.service.js";
import type { ProjectService, ProviderFactory } from "./project.service.js";
import { toPng } from "./project.service.js";
import type { PromptService, SnapshotExtras } from "./prompt.service.js";

type MediaKey = "photo" | ChannelImageAsset;
export interface ChannelMediaDto {
  file: string;
  /** Changes whenever the file is remade (cache-busting for <img>). */
  version: number;
  bytes: number;
}

export interface ChannelKitDetailsDto extends ChannelKitDto {
  media: Record<MediaKey, ChannelMediaDto | null>;
  /** The last prompt sent to the AI for each picture / text. */
  prompts: Partial<Record<ChannelAsset, string>>;
  /** Assets being made right now. */
  busy: ChannelAsset[];
}

export interface ChannelKitSummaryDto {
  id: string;
  name: string;
  logo: ChannelMediaDto | null;
  /** Videos in this channel. */
  videos: number;
  updatedAt: string;
}

const PHOTO_FILE = "photo.png";
/** {{language_name}} for bilingual kits: each text in Amharic, then the same in English. */
const BILINGUAL_LANGUAGE_NAME = "both Amharic (Ge'ez script) and English (bilingual: write it in Amharic, then the same in English, e.g. \"ልጆች ዜማ | Kids Melody\")";
const PROMPT_KEYS: Record<Exclude<ChannelAsset, "watermark">, string> = { details: "channel_details", logo: "channel_logo", banner: "channel_banner", thumbnail: "channel_thumbnail" };

/**
 * YouTube channel brand kits (Channel page): from a sample photo and/or a prompt, make the channel name,
 * handle, description and keywords, plus the profile picture, banner, watermark and a thumbnail, each at
 * the exact size YouTube asks for. Every asset can be (re)made on its own.
 */
export class ChannelService {
  private readonly busy = new Map<string, Set<ChannelAsset>>();

  constructor(
    private readonly kits: ChannelKitRepository,
    private readonly promptService: PromptService,
    private readonly modelSettings: ModelSettingsService,
    private readonly providers: ProviderFactory,
    private readonly mediaRoot: string,
    private readonly projects: ProjectService,
    private readonly plans: ContentPlanRepository,
  ) {}

  /** Throws NotFoundError for unknown channels (used by the video and plan services). */
  readonly assertExists = async (id: string): Promise<void> => {
    if (!(await this.kits.exists(id))) throw new NotFoundError(`Channel "${id}" not found`);
  };

  /** Media folder; "_" can't start a project id (slugify), so it never clashes with project folders. */
  mediaDir(id: string): string {
    return path.join(this.mediaRoot, "_channels", id);
  }

  async create(raw: { input?: unknown; provider?: unknown; image?: unknown }): Promise<ChannelKitDetailsDto> {
    if (raw.input && typeof raw.input === "object") raw = { ...raw, input: Object.fromEntries(Object.entries(raw.input).filter(([, v]) => v !== null)) };
    const input = parseChannelInput(raw.input);
    const providerName = typeof raw.provider === "string" && raw.provider ? raw.provider : "gemini";
    this.providers(providerName); // fail fast (e.g. missing API key)
    const photo = raw.image ? await toPng(raw.image) : undefined;
    ChannelKit.assertBrief(input, Boolean(photo));
    const base = slugify(input.name ?? input.brief ?? "channel").replace(/^project-/, "channel-");
    for (let n = 1; n < 1000; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (await this.kits.exists(id)) continue;
      const kit = ChannelKit.create({ id, input, provider: providerName, hasPhoto: Boolean(photo) });
      try {
        await this.kits.create(kit);
      } catch (err) {
        if (err instanceof ConflictError) continue; // lost a race for this id
        throw err;
      }
      await rm(this.mediaDir(id), { recursive: true, force: true }); // leftovers from an old kit with this id
      if (photo) await writeFileAtomic(this.file(id, PHOTO_FILE), photo);
      // The very first channel takes over everything made before channels existed.
      if ((await this.kits.list(2)).length === 1) await this.adoptLegacy();
      return this.toDetails(kit);
    }
    throw new ConflictError("Could not allocate a channel id");
  }

  async list(): Promise<ChannelKitSummaryDto[]> {
    const kits = await this.kits.list();
    return Promise.all(kits.map(async (k) => ({
      id: k.id,
      name: k.channelName ?? k.input.brief?.slice(0, 60) ?? "Untitled channel",
      logo: await this.media(k.id, CHANNEL_IMAGE_SPECS.logo.file),
      videos: (await this.projects.idsInChannel(k.id)).length,
      updatedAt: k.updatedAt.toISOString(),
    })));
  }

  async get(id: string): Promise<ChannelKitDetailsDto> {
    return this.toDetails(await this.load(id));
  }

  /** Change the brief (prompt, name, language, style), the provider, or the sample photo. Existing pictures are kept. */
  async update(id: string, raw: { input?: unknown; provider?: unknown; image?: unknown; removePhoto?: unknown }): Promise<ChannelKitDetailsDto> {
    const kit = await this.load(id);
    const merged: Record<string, unknown> = { ...kit.input, ...(raw.input as object) };
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k]; // null = clear the field
    const input = raw.input === undefined ? kit.input : parseChannelInput(merged);
    const provider = typeof raw.provider === "string" && raw.provider ? raw.provider : undefined;
    if (provider) this.providers(provider);
    const photo = raw.image ? await toPng(raw.image) : undefined;
    const hasPhoto = photo ? true : raw.removePhoto === true ? false : Boolean(await this.media(id, PHOTO_FILE));
    kit.editInput(input, hasPhoto, provider);
    await this.kits.save(kit);
    if (photo) await writeFileAtomic(this.file(id, PHOTO_FILE), photo);
    else if (raw.removePhoto === true) await rm(this.file(id, PHOTO_FILE), { force: true });
    return this.toDetails(kit);
  }

  /** Save edited channel text (clamped to YouTube's limits). */
  async editDetails(id: string, raw: unknown): Promise<ChannelKitDetailsDto> {
    if (this.busy.get(id)?.has("details")) throw new ConflictError("The channel text is being written; wait for it to finish");
    const kit = await this.load(id);
    kit.setDetails(parseChannelDetails(raw));
    await this.kits.save(kit);
    return this.toDetails(kit);
  }

  /** Make (or remake) one asset. Waits for the AI and returns the updated kit. */
  async generate(id: string, asset: string, opts: { provider?: string; title?: string } = {}): Promise<ChannelKitDetailsDto> {
    if (!CHANNEL_ASSETS.includes(asset as ChannelAsset)) throw new ValidationError(`Unknown channel asset "${asset}" (use ${CHANNEL_ASSETS.join(", ")})`);
    const a = asset as ChannelAsset;
    const kit = await this.load(id);
    const running = this.busy.get(id) ?? new Set<ChannelAsset>();
    if (running.has(a)) throw new ConflictError(`The ${a} is already being made`);
    if (a === "watermark" && !(await this.media(id, CHANNEL_IMAGE_SPECS.logo.file))) throw new ConflictError("Make the logo first (the watermark is made from it)");
    const provider = a === "watermark" ? undefined : this.providers(opts.provider ?? kit.provider);
    running.add(a);
    this.busy.set(id, running);
    try {
      if (a === "details") await this.makeDetails(kit, provider!);
      else if (a === "watermark") await this.makeWatermark(id);
      else await this.makePicture(kit, a, provider!, opts.title?.trim().slice(0, 100) || undefined);
    } finally {
      running.delete(a);
      if (!running.size) this.busy.delete(id);
    }
    return this.get(id);
  }

  /**
   * Delete a channel: its branding, monthly plans and own prompt copies. Its videos are deleted too, unless
   * `moveVideosTo` names another channel: then the videos (and the plans for months that channel has no plan for)
   * move there instead. Nothing happens while one of its videos is being made.
   */
  async delete(id: string, opts: { moveVideosTo?: string } = {}): Promise<{ deletedVideos: number; movedVideos: number; movedPlans: number }> {
    await this.assertExists(id);
    const target = opts.moveVideosTo?.trim() || undefined;
    if (target === id) throw new ValidationError("Choose a different channel to move the videos to");
    if (target) await this.assertExists(target);
    if (this.busy.get(id)?.size) throw new ConflictError("Channel art is being made; wait for it to finish");
    const videos = await this.projects.idsInChannel(id);
    if (videos.some((v) => this.projects.isRunning(v))) throw new ConflictError("A video in this channel is being made; stop it first");

    let movedPlans = 0;
    if (target) {
      for (const v of videos) await this.projects.moveToChannel(v, target);
      movedPlans = await this.plans.reassign(id, target);
    } else {
      for (const v of videos) await this.projects.delete(v);
    }
    await this.plans.deleteChannel(id);
    await this.promptService.deleteChannel(id);
    await this.kits.delete(id);
    await rm(this.mediaDir(id), { recursive: true, force: true });
    log.info(`channel ${id} deleted (${target ? `${videos.length} videos moved to ${target}` : `${videos.length} videos deleted`})`);
    return { deletedVideos: target ? 0 : videos.length, movedVideos: target ? videos.length : 0, movedPlans };
  }

  /**
   * Videos, monthly plans and prompt edits made before channels existed go into the first (oldest) channel.
   * Runs at startup and when the first channel is created; does nothing once everything has a channel.
   */
  async adoptLegacy(): Promise<{ channel: string; videos: number; plans: number; prompts: number } | null> {
    const kits = await this.kits.list(1000);
    if (!kits.length) return null;
    const first = kits.reduce((a, b) => (+a.createdAt <= +b.createdAt ? a : b));
    const videos = await this.projects.idsInChannel(null);
    for (const v of videos) await this.projects.moveToChannel(v, first.id);
    const plans = await this.plans.reassign(SHARED, first.id);
    // Only when nothing else was adopted would a shared edit be a deliberate "for every channel" change: so move
    // shared edits only together with old videos/plans, or while this is still the only channel.
    const prompts = videos.length || plans || kits.length === 1 ? await this.promptService.moveSharedEditsTo(first.id) : 0;
    if (videos.length || plans || prompts) log.info(`moved ${videos.length} videos, ${plans} plans and ${prompts} prompt edits into channel "${first.channelName ?? first.id}"`);
    return { channel: first.id, videos: videos.length, plans, prompts };
  }

  /** Absolute path of a kit media file, or undefined if it's outside the kit folder. */
  mediaFile(id: string, relative: string[]): string | undefined {
    const dir = this.mediaDir(id);
    const file = path.resolve(dir, ...relative);
    return file.startsWith(dir + path.sep) && !file.endsWith(".txt") ? file : undefined;
  }

  // ---------- generation ----------

  private async makeDetails(kit: ChannelKit, provider: Provider): Promise<void> {
    const photo = await this.readMedia(kit.id, PHOTO_FILE);
    const refs = photo ? [photo] : [];
    const { input, text, model } = await this.render(kit, "details", { channel_name: kit.input.name ?? "" }, { has_reference: refs.length > 0, has_channel_name: Boolean(kit.input.name) });
    const out = await provider.text("channel", text, { model, images: refs, ctx: { input, channelName: kit.input.name } });
    // Reload: the brief may have been edited while the model was writing.
    const fresh = await this.load(kit.id);
    fresh.setDetails(fresh.input.name ? { ...out, name: fresh.input.name } : out);
    await this.kits.save(fresh);
    await writeFileAtomic(this.file(kit.id, "details.prompt.txt"), text);
  }

  private async makePicture(kit: ChannelKit, asset: Exclude<ChannelImageAsset, "watermark">, provider: Provider, title?: string): Promise<void> {
    const spec = CHANNEL_IMAGE_SPECS[asset];
    // The logo is drawn from the sample photo; the banner and thumbnail also see the logo, so the kit matches.
    const refs = (await Promise.all([this.readMedia(kit.id, PHOTO_FILE), asset === "logo" ? undefined : this.readMedia(kit.id, CHANNEL_IMAGE_SPECS.logo.file)])).filter((b): b is Buffer => Boolean(b));
    const name = kit.channelName;
    const { input, text, model } = await this.render(
      kit,
      asset,
      { channel_name: name ?? "", thumbnail_title: title ?? "" },
      { has_reference: refs.length > 0, has_channel_name: Boolean(name), has_title: Boolean(title) },
    );
    const picture = await provider.image(text, { model, aspectRatio: spec.aspectRatio!, references: refs, label: `channel ${asset}`, ctx: { input, channelName: name } });
    await this.fit(kit.id, picture, asset);
    await writeFileAtomic(this.file(kit.id, `${asset}.prompt.txt`), text);
  }

  private async makeWatermark(id: string): Promise<void> {
    const logo = await this.readMedia(id, CHANNEL_IMAGE_SPECS.logo.file);
    if (!logo) throw new ConflictError("Make the logo first (the watermark is made from it)");
    await this.fit(id, logo, "watermark");
  }

  /** Resize/crop to YouTube's exact size and size limit, then swap the file in atomically. */
  private async fit(id: string, picture: Buffer, asset: ChannelImageAsset): Promise<void> {
    const spec = CHANNEL_IMAGE_SPECS[asset];
    const dir = this.mediaDir(id);
    await mkdir(dir, { recursive: true });
    const tag = `${process.pid}-${Date.now()}`;
    const src = path.join(dir, `.${asset}-${tag}.src`);
    const out = path.join(dir, `.${asset}-${tag}${path.extname(spec.file)}`);
    try {
      await writeFile(src, picture);
      await fitImage({ input: src, out, width: spec.width, height: spec.height, maxBytes: spec.maxBytes });
      await rename(out, this.file(id, spec.file));
    } finally {
      await Promise.all([rm(src, { force: true }), rm(out, { force: true })]);
    }
  }

  /** Render a channel prompt; the channel brief stands in for the project topic. */
  private async render(kit: ChannelKit, asset: Exclude<ChannelAsset, "watermark">, vars: Record<string, string>, flags: SnapshotExtras["flags"]) {
    const input = this.promptInput(kit);
    const both = kit.input.language === "both";
    const extras: SnapshotExtras = both ? { languageName: BILINGUAL_LANGUAGE_NAME, flags: { ...flags, am: true, en: true } } : { flags };
    const [prompts, models] = await Promise.all([this.promptService.snapshotFor(input, { ...extras, channel: kit.id }), this.modelSettings.snapshot()]);
    const r = prompts.render(PROMPT_KEYS[asset], vars);
    return { input, text: r.text, model: asset === "details" ? models.channel_text : models.channel_image };
  }

  private promptInput(kit: ChannelKit): ProjectInput {
    const { brief, name, language, ageRange, style } = kit.input;
    const topic = brief ?? (name ? `the kids' channel "${name}"` : "a fun, friendly kids' channel, inspired by the sample photo");
    // Bilingual kits render as Amharic (Ge'ez script) with English added by BILINGUAL_LANGUAGE_NAME.
    return ProjectInputSchema.parse({ topic, language: language === "both" ? "am" : language, ageRange, style, aspectRatio: "16:9" });
  }

  // ---------- files ----------

  private file(id: string, name: string): string {
    return path.join(this.mediaDir(id), name);
  }

  private async media(id: string, name: string): Promise<ChannelMediaDto | null> {
    const info = await stat(this.file(id, name)).catch(() => undefined);
    return info?.isFile() && info.size > 0 ? { file: name, version: Math.round(info.mtimeMs), bytes: info.size } : null;
  }

  private async readMedia(id: string, name: string): Promise<Buffer | undefined> {
    return readFile(this.file(id, name)).catch(() => undefined);
  }

  private async toDetails(kit: ChannelKit): Promise<ChannelKitDetailsDto> {
    const id = kit.id;
    const keys: MediaKey[] = ["photo", "logo", "banner", "watermark", "thumbnail"];
    const files = await Promise.all(keys.map((k) => this.media(id, k === "photo" ? PHOTO_FILE : CHANNEL_IMAGE_SPECS[k].file)));
    const prompts: Partial<Record<ChannelAsset, string>> = {};
    for (const a of ["details", "logo", "banner", "thumbnail"] as const) {
      const t = await readFile(this.file(id, `${a}.prompt.txt`), "utf8").catch(() => undefined);
      if (t) prompts[a] = t;
    }
    return {
      ...ChannelKitMapper.toDto(kit),
      media: Object.fromEntries(keys.map((k, i) => [k, files[i]])) as Record<MediaKey, ChannelMediaDto | null>,
      prompts,
      busy: [...(this.busy.get(id) ?? [])],
    };
  }

  private async load(id: string): Promise<ChannelKit> {
    const kit = await this.kits.findById(id);
    if (!kit) throw new NotFoundError(`Channel kit "${id}" not found`);
    return kit;
  }
}
