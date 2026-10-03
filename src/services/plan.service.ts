import { DomainError, ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import { planToIcs } from "../domain/plan/plan.calendar.js";
import { ContentPlan, parseMonth, parsePlanInput } from "../domain/plan/plan.entity.js";
import { ContentPlanMapper, type ContentPlanDto } from "../domain/plan/plan.mapper.js";
import { dayLabel, monthName, PlanInputSchema, planSlots, type PlanIdea, type PlanInput, type PlanSlot } from "../domain/plan/plan.model.js";
import type { Provider } from "../domain/ports/generator.port.js";
import { ProjectInputSchema, type ProjectInput } from "../domain/project/project.model.js";
import type { ContentPlanRepository } from "../repositories/repositories.js";
import { log } from "../util/log.js";
import type { ModelSettingsService } from "./model-settings.service.js";
import type { ProjectService, ProviderFactory } from "./project.service.js";
import type { PromptService, SnapshotExtras } from "./prompt.service.js";

export interface ContentPlanSummaryDto {
  month: string;
  theme: string | null;
  videos: number;
  made: number;
}

const LANG = { am: "Amharic", en: "English" } as const;
const BILINGUAL = "Amharic (Ge'ez script) and English: each video is in ONE language, the one listed for its slot";

/**
 * Ideas & schedule: once a month, plan one video per posting slot. The app computes the dates and times
 * (so they're always real); the AI fills each slot with the inputs for the Videos form. Ideas can be edited,
 * turned into a video project with one click, and exported as a calendar.
 */
export class PlanService {
  private readonly generating = new Set<string>();

  constructor(
    private readonly plans: ContentPlanRepository,
    private readonly promptService: PromptService,
    private readonly modelSettings: ModelSettingsService,
    private readonly providers: ProviderFactory,
    private readonly projects: ProjectService,
    /** Throws NotFoundError for unknown channels. */
    private readonly assertChannel: (channel: string) => Promise<void>,
    /** The channel's audio defaults (audio mode, singer, voice) for videos made from ideas. */
    private readonly channelDefaults: (channel: string) => Promise<{ audioMode?: string; singer?: string; voice?: string }> = async () => ({}),
  ) {}

  async list(channel: string): Promise<ContentPlanSummaryDto[]> {
    await this.assertChannel(channel);
    return (await this.plans.list(channel)).map((p) => ({ month: p.month, theme: p.theme, videos: p.ideas.length, made: p.ideas.filter((i) => i.projectId).length }));
  }

  async get(channel: string, month: string): Promise<ContentPlanDto> {
    return ContentPlanMapper.toDto(await this.load(channel, month));
  }

  /** Settings of the channel's latest plan, to prefill next month's form. */
  async lastInput(channel: string): Promise<PlanInput | null> {
    await this.assertChannel(channel);
    return (await this.plans.list(channel, 1))[0]?.input ?? null;
  }

  /** The posting slots these settings give (shown live while filling in the form; only the schedule fields matter). */
  slots(month: string, raw: unknown): PlanSlot[] {
    const r = PlanInputSchema.pick({ postDays: true, weekdayTime: true, weekendTime: true, timezone: true, language: true }).safeParse(raw ?? {});
    if (!r.success) throw new ValidationError("Invalid schedule", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    return planSlots(parseMonth(month), r.data);
  }

  /**
   * Plan (or re-plan) a month. Ideas that already became a video are kept on their dates;
   * the other slots get new ideas.
   */
  async generate(channel: string, month: string, raw: unknown, opts: { provider?: string } = {}): Promise<ContentPlanDto> {
    parseMonth(month);
    await this.assertChannel(channel);
    const input = parsePlanInput(raw);
    const provider = this.providers(opts.provider ?? "gemini");
    const lock = `${channel}#${month}`;
    if (this.generating.has(lock)) throw new ConflictError(`${monthName(month)} is already being planned`);
    this.generating.add(lock);
    try {
      const existing = await this.plans.findByMonth(channel, month);
      const kept = (existing?.ideas ?? []).filter((i) => i.projectId);
      const taken = new Set(kept.map((i) => i.date));
      const slots = planSlots(month, input).filter((s) => !taken.has(s.date));
      if (!slots.length && !kept.length) throw new DomainError(`No posting days left in ${monthName(month)} with these settings`);
      const { theme, ideas } = slots.length ? await this.planIdeas(channel, month, input, slots, provider, kept) : { theme: existing?.theme ?? "", ideas: [] };
      const all = [...kept, ...ideas].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
      const plan = existing ?? ContentPlan.create(channel, month, input, theme, all);
      if (existing) plan.replace(input, theme, all);
      await this.plans.save(plan);
      return ContentPlanMapper.toDto(plan);
    } finally {
      this.generating.delete(lock);
    }
  }

  /**
   * Replace one idea you don't like with a new one for the same date, time and language.
   * `hint` says what you'd like instead (e.g. "about animals", "keep the topic, funnier title").
   */
  async regenerateIdea(channel: string, month: string, index: number, opts: { provider?: string; hint?: string } = {}): Promise<ContentPlanDto> {
    const plan = await this.load(channel, month);
    const idea = plan.idea(index);
    if (idea.projectId) throw new ConflictError(`A video was already made from "${idea.title}"; edit it instead`);
    const provider = this.providers(opts.provider ?? "gemini");
    const key = `${channel}#${month}#${idea.date}`;
    if (this.generating.has(`${channel}#${month}`) || this.generating.has(key)) throw new ConflictError("This idea is already being made again");
    this.generating.add(key);
    try {
      const hint = opts.hint?.trim().slice(0, 500);
      const notes = [
        `This replaces one video the parent didn't like: "${idea.title}" (topic: ${idea.topic}). Plan a different one${hint ? `. What they want instead: ${hint}` : ", with a new topic and a fresh, catchier title"}.`,
        plan.input.notes ? `Requests for the month: ${plan.input.notes}` : "",
      ].filter(Boolean).join(" ");
      // The rest of this month counts as "already used", so the new idea doesn't repeat any of them.
      const others = plan.ideas.filter((_, i) => i !== index);
      const { ideas } = await this.planIdeas(channel, month, { ...plan.input, notes }, [{ date: idea.date, time: idea.time, language: idea.language }], provider, [...others, ...(hint ? [] : [idea])]);
      // Reload: other ideas may have been edited while the model was writing.
      const fresh = await this.load(channel, month);
      const at = fresh.ideas.findIndex((i) => i.date === idea.date && i.time === idea.time && !i.projectId);
      if (at < 0) throw new ConflictError("That idea changed while the new one was being written; reload and try again");
      fresh.replaceIdea(at, ideas[0]!);
      await this.plans.save(fresh);
      return ContentPlanMapper.toDto(fresh);
    } finally {
      this.generating.delete(key);
    }
  }

  async editIdea(channel: string, month: string, index: number, raw: unknown): Promise<ContentPlanDto> {
    const plan = await this.load(channel, month);
    plan.editIdea(index, raw);
    await this.plans.save(plan);
    return ContentPlanMapper.toDto(plan);
  }

  /** Create (and start) a video project from an idea, using the plan's character and age range. */
  async makeVideo(channel: string, month: string, index: number, opts: { provider?: string; reviewMode?: string } = {}): Promise<{ projectId: string; plan: ContentPlanDto }> {
    const plan = await this.load(channel, month);
    const idea = plan.idea(index);
    if (idea.projectId && (await this.projects.get(idea.projectId).then(() => true, (e) => (e instanceof NotFoundError ? false : Promise.reject(e))))) {
      throw new ConflictError(`"${idea.title}" was already made (project ${idea.projectId})`);
    }
    const defaults = await this.channelDefaults(channel);
    const input = {
      topic: idea.topic,
      language: idea.language,
      // A channel set to "voice over music" uses it for every planned song (e.g. Amharic channels).
      audioMode: defaults.audioMode === "music_voice" && idea.audioMode === "song" ? "music_voice" : idea.audioMode,
      ...(defaults.singer ? { singer: defaults.singer } : {}),
      ...(defaults.voice ? { voice: defaults.voice } : {}),
      // A month with a set length: the length picks the scene count. Otherwise the planned count.
      ...(plan.input.videoMinutes ? { lengthSeconds: Math.round(plan.input.videoMinutes * 60) } : { sceneCount: idea.sceneCount }),
      ageRange: plan.input.ageRange,
      characterHint: plan.input.mainCharacter,
      reviewMode: opts.reviewMode === "auto" ? "auto" : "manual",
    };
    const project = await this.projects.create(input, opts.provider ?? "gemini", { channelId: channel });
    plan.linkProject(index, project.id);
    await this.plans.save(plan);
    await this.projects.start(project.id);
    return { projectId: project.id, plan: ContentPlanMapper.toDto(plan) };
  }

  async calendar(channel: string, month: string): Promise<string> {
    const plan = await this.load(channel, month);
    return planToIcs({ month, channelName: plan.input.channelName, timezone: plan.input.timezone, ideas: [...plan.ideas] });
  }

  // ---------- generation ----------

  private async planIdeas(channel: string, month: string, input: PlanInput, slots: PlanSlot[], provider: Provider, kept: PlanIdea[]): Promise<{ theme: string; ideas: PlanIdea[] }> {
    const projectInput = this.promptInput(input);
    const extras: SnapshotExtras = input.language === "both"
      ? { languageName: BILINGUAL, flags: { am: true, en: true, has_channel_name: Boolean(input.channelName) } }
      : { flags: { has_channel_name: Boolean(input.channelName) } };
    const [prompts, models] = await Promise.all([this.promptService.snapshotFor(projectInput, { ...extras, channel }), this.modelSettings.snapshot()]);
    // Only this channel's earlier months: another channel may well use the same topics.
    const earlier = (await this.plans.list(channel, 6)).filter((p) => p.month !== month).flatMap((p) => p.ideas.map((i) => i.title));
    const previous = [...kept.map((i) => i.title), ...earlier].slice(0, 120);
    const { text } = prompts.render("content_plan", {
      month_name: monthName(month),
      channel_name: input.channelName ?? "",
      schedule: slots.map((s, i) => `${i + 1}. ${dayLabel(s.date)}, ${s.time} (${LANG[s.language]})`).join("\n"),
      video_count: slots.length,
      notes: input.notes ?? "(none)",
      previous_topics: previous.length ? previous.join("; ") : "(none yet)",
      video_length: input.videoMinutes ? `about ${input.videoMinutes} minute${input.videoMinutes === 1 ? "" : "s"}` : "about 30 seconds",
    });
    const ctx = { input: projectInput, planSlots: slots };
    let out = await provider.text("plan", text, { model: models.plan_text, ctx });
    if (out.ideas.length < slots.length) {
      log.warn(`plan ${month}: ${out.ideas.length} ideas for ${slots.length} slots; asking again`);
      out = await provider.text("plan", text, { model: models.plan_text, ctx });
      if (out.ideas.length < slots.length) throw new DomainError(`The AI planned ${out.ideas.length} videos for ${slots.length} posting days; try again`);
    }
    const ideas = slots.map((s, i): PlanIdea => {
      const idea = out.ideas[i]!;
      const tags = [...new Set(idea.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 15);
      return { ...idea, tags, ...s, projectId: null };
    });
    return { theme: out.theme.trim(), ideas };
  }

  private promptInput(input: PlanInput): ProjectInput {
    return ProjectInputSchema.parse({ topic: input.about, language: input.language === "both" ? "am" : input.language, ageRange: input.ageRange, characterHint: input.mainCharacter });
  }

  private async load(channel: string, month: string): Promise<ContentPlan> {
    await this.assertChannel(channel);
    const plan = await this.plans.findByMonth(channel, parseMonth(month));
    if (!plan) throw new NotFoundError(`No plan for ${monthName(month)} yet`);
    return plan;
  }
}
