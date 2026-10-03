import { ConflictError } from "../../domain/errors.js";
import { ChannelKit } from "../../domain/channel/channel.entity.js";
import { ContentPlan } from "../../domain/plan/plan.entity.js";
import type { Generation } from "../../domain/generation/generation.model.js";
import { ModelSetting } from "../../domain/model-setting/model-setting.entity.js";
import { Project } from "../../domain/project/project.entity.js";
import { Prompt, type PromptRevision } from "../../domain/prompt/prompt.entity.js";
import type { ChannelKitRepository, ContentPlanRepository, GenerationRepository, ModelSettingRepository, ProjectRepository, PromptRepository } from "../repositories.js";

/** In-memory adapters: used by unit tests (and handy for trying the pipeline without Postgres). */

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly rows = new Map<string, ReturnType<Project["toProps"]>>();

  async findById(id: string) {
    const p = this.rows.get(id);
    return p ? Project.restore(p) : undefined;
  }
  async list({ channelId, limit = 100 }: { channelId?: string | null; limit?: number } = {}) {
    return [...this.rows.values()]
      .filter((p) => channelId === undefined || (p.channelId ?? null) === channelId)
      .sort((a, b) => +b.updatedAt - +a.updatedAt)
      .slice(0, limit)
      .map((p) => Project.restore(structuredClone(p)));
  }
  async exists(id: string) {
    return this.rows.has(id);
  }
  async create(project: Project) {
    if (this.rows.has(project.id)) throw new ConflictError(`Project "${project.id}" already exists`);
    this.rows.set(project.id, structuredClone(project.toProps()));
  }
  async save(project: Project) {
    this.rows.set(project.id, structuredClone(project.toProps()));
  }
  async pauseAllRunning(reason: string) {
    let n = 0;
    for (const [id, p] of this.rows) if (p.status === "running") (this.rows.set(id, { ...p, status: "paused", error: reason }), n++);
    return n;
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
}

export class InMemoryPromptRepository implements PromptRepository {
  private readonly prompts = new Map<string, ReturnType<Prompt["toProps"]>>();
  private revisions: PromptRevision[] = [];
  private static id = (channelId: string, key: string) => `${channelId}\u0000${key}`;

  async list(channelId: string) {
    return [...this.prompts.values()].filter((p) => p.channelId === channelId).map((p) => Prompt.restore(p));
  }
  async findByKey(channelId: string, key: string) {
    const p = this.prompts.get(InMemoryPromptRepository.id(channelId, key));
    return p ? Prompt.restore(p) : undefined;
  }
  async createIfMissing(prompt: Prompt, revision: PromptRevision) {
    const id = InMemoryPromptRepository.id(prompt.channelId, prompt.key);
    if (this.prompts.has(id)) return false;
    this.prompts.set(id, prompt.toProps());
    this.revisions.push(revision);
    return true;
  }
  async saveRevision(prompt: Prompt, revision: PromptRevision, expectedPreviousVersion: number) {
    const id = InMemoryPromptRepository.id(prompt.channelId, prompt.key);
    if (this.prompts.get(id)?.version !== expectedPreviousVersion) throw new ConflictError(`Prompt "${prompt.key}" was changed by someone else`);
    this.prompts.set(id, prompt.toProps());
    this.revisions.push(revision);
  }
  async history(channelId: string, key: string, limit = 50) {
    return this.revisions.filter((r) => r.channelId === channelId && r.key === key).sort((a, b) => b.version - a.version).slice(0, limit);
  }
  async deleteChannelCopies(channelId: string, key?: string) {
    if (!channelId) return 0;
    const hit = (p: { channelId: string; key: string }) => p.channelId === channelId && (key === undefined || p.key === key);
    let n = 0;
    for (const [id, p] of this.prompts) if (hit(p)) (this.prompts.delete(id), n++);
    this.revisions = this.revisions.filter((r) => !hit(r));
    return n;
  }
}

export class InMemoryGenerationRepository implements GenerationRepository {
  readonly items: Generation[] = [];
  async add(g: Omit<Generation, "createdAt">) {
    this.items.push({ ...g, createdAt: new Date() });
  }
  async listByProject(projectId: string, limit = 200) {
    return this.items.filter((g) => g.projectId === projectId).reverse().slice(0, limit);
  }
}

export class InMemoryChannelKitRepository implements ChannelKitRepository {
  private readonly rows = new Map<string, ReturnType<ChannelKit["toProps"]>>();

  async findById(id: string) {
    const k = this.rows.get(id);
    return k ? ChannelKit.restore(structuredClone(k)) : undefined;
  }
  async list(limit = 100) {
    return [...this.rows.values()].sort((a, b) => +b.updatedAt - +a.updatedAt).slice(0, limit).map((k) => ChannelKit.restore(structuredClone(k)));
  }
  async exists(id: string) {
    return this.rows.has(id);
  }
  async create(kit: ChannelKit) {
    if (this.rows.has(kit.id)) throw new ConflictError(`Channel kit "${kit.id}" already exists`);
    this.rows.set(kit.id, kit.toProps());
  }
  async save(kit: ChannelKit) {
    this.rows.set(kit.id, kit.toProps());
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
}

export class InMemoryContentPlanRepository implements ContentPlanRepository {
  private readonly rows = new Map<string, ReturnType<ContentPlan["toProps"]>>();
  private static id = (channelId: string, month: string) => `${channelId}\u0000${month}`;
  async findByMonth(channelId: string, month: string) {
    const p = this.rows.get(InMemoryContentPlanRepository.id(channelId, month));
    return p ? ContentPlan.restore(p) : undefined;
  }
  async list(channelId: string, limit = 100) {
    return [...this.rows.values()].filter((p) => p.channelId === channelId).sort((a, b) => b.month.localeCompare(a.month)).slice(0, limit).map((p) => ContentPlan.restore(p));
  }
  async save(plan: ContentPlan) {
    this.rows.set(InMemoryContentPlanRepository.id(plan.channelId, plan.month), plan.toProps());
  }
  async deleteChannel(channelId: string) {
    let n = 0;
    for (const [id, p] of this.rows) if (p.channelId === channelId) (this.rows.delete(id), n++);
    return n;
  }
  async reassign(fromChannelId: string, toChannelId: string) {
    let n = 0;
    for (const [id, p] of [...this.rows]) {
      if (p.channelId !== fromChannelId) continue;
      const target = InMemoryContentPlanRepository.id(toChannelId, p.month);
      if (this.rows.has(target)) continue;
      this.rows.delete(id);
      this.rows.set(target, { ...p, channelId: toChannelId });
      n++;
    }
    return n;
  }
}

export class InMemoryModelSettingRepository implements ModelSettingRepository {
  private readonly rows = new Map<string, ReturnType<ModelSetting["toProps"]>>();
  async list() {
    return [...this.rows.values()].map((r) => ModelSetting.restore(r));
  }
  async findByTask(task: string) {
    const r = this.rows.get(task);
    return r ? ModelSetting.restore(r) : undefined;
  }
  async createIfMissing(setting: ModelSetting) {
    if (this.rows.has(setting.task)) return false;
    this.rows.set(setting.task, setting.toProps());
    return true;
  }
  async save(setting: ModelSetting) {
    this.rows.set(setting.task, setting.toProps());
  }
}
