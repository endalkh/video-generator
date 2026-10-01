import { ConflictError } from "../../domain/errors.js";
import type { Generation } from "../../domain/generation/generation.model.js";
import { ModelSetting } from "../../domain/model-setting/model-setting.entity.js";
import { Project } from "../../domain/project/project.entity.js";
import { Prompt, type PromptRevision } from "../../domain/prompt/prompt.entity.js";
import type { GenerationRepository, ModelSettingRepository, ProjectRepository, PromptRepository } from "../repositories.js";

/** In-memory adapters: used by unit tests (and handy for trying the pipeline without Postgres). */

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly rows = new Map<string, ReturnType<Project["toProps"]>>();

  async findById(id: string) {
    const p = this.rows.get(id);
    return p ? Project.restore(p) : undefined;
  }
  async list(limit = 100) {
    return [...this.rows.values()].sort((a, b) => +b.updatedAt - +a.updatedAt).slice(0, limit).map((p) => Project.restore(p));
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
}

export class InMemoryPromptRepository implements PromptRepository {
  private readonly prompts = new Map<string, ReturnType<Prompt["toProps"]>>();
  private readonly revisions: PromptRevision[] = [];

  async list() {
    return [...this.prompts.values()].map((p) => Prompt.restore(p));
  }
  async findByKey(key: string) {
    const p = this.prompts.get(key);
    return p ? Prompt.restore(p) : undefined;
  }
  async createIfMissing(prompt: Prompt, revision: PromptRevision) {
    if (this.prompts.has(prompt.key)) return false;
    this.prompts.set(prompt.key, prompt.toProps());
    this.revisions.push(revision);
    return true;
  }
  async saveRevision(prompt: Prompt, revision: PromptRevision, expectedPreviousVersion: number) {
    if (this.prompts.get(prompt.key)?.version !== expectedPreviousVersion) throw new ConflictError(`Prompt "${prompt.key}" was changed by someone else`);
    this.prompts.set(prompt.key, prompt.toProps());
    this.revisions.push(revision);
  }
  async history(key: string, limit = 50) {
    return this.revisions.filter((r) => r.key === key).sort((a, b) => b.version - a.version).slice(0, limit);
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
