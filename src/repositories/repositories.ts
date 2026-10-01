import type { Generation } from "../domain/generation/generation.model.js";
import type { ModelSetting } from "../domain/model-setting/model-setting.entity.js";
import type { Project } from "../domain/project/project.entity.js";
import type { Prompt, PromptRevision } from "../domain/prompt/prompt.entity.js";

/** Repository ports. Services depend on these interfaces; Prisma and in-memory adapters implement them. */

export interface ProjectRepository {
  findById(id: string): Promise<Project | undefined>;
  list(limit?: number): Promise<Project[]>;
  exists(id: string): Promise<boolean>;
  /** Insert; throws ConflictError if the id is taken. */
  create(project: Project): Promise<void>;
  save(project: Project): Promise<void>;
  /** Mark rows left "running" by a crashed process as paused. */
  pauseAllRunning(reason: string): Promise<number>;
}

export interface PromptRepository {
  list(): Promise<Prompt[]>;
  findByKey(key: string): Promise<Prompt | undefined>;
  /** Insert a prompt with its first revision if the key doesn't exist yet (never overwrites edits). */
  createIfMissing(prompt: Prompt, revision: PromptRevision): Promise<boolean>;
  /** Persist the prompt's new version and its revision atomically; fails if the stored version moved on. */
  saveRevision(prompt: Prompt, revision: PromptRevision, expectedPreviousVersion: number): Promise<void>;
  history(key: string, limit?: number): Promise<PromptRevision[]>;
}

export interface GenerationRepository {
  add(g: Omit<Generation, "createdAt">): Promise<void>;
  listByProject(projectId: string, limit?: number): Promise<Generation[]>;
}

export interface ModelSettingRepository {
  list(): Promise<ModelSetting[]>;
  findByTask(task: string): Promise<ModelSetting | undefined>;
  /** Insert if the task has no setting yet (never overwrites a user's choice). */
  createIfMissing(setting: ModelSetting): Promise<boolean>;
  save(setting: ModelSetting): Promise<void>;
}
