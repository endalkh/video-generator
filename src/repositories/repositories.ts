import type { ChannelKit } from "../domain/channel/channel.entity.js";
import type { ContentPlan } from "../domain/plan/plan.entity.js";
import type { Generation } from "../domain/generation/generation.model.js";
import type { ModelSetting } from "../domain/model-setting/model-setting.entity.js";
import type { Project } from "../domain/project/project.entity.js";
import type { Prompt, PromptRevision } from "../domain/prompt/prompt.entity.js";

/** Repository ports. Services depend on these interfaces; Prisma and in-memory adapters implement them. */

export interface ProjectRepository {
  findById(id: string): Promise<Project | undefined>;
  /** Newest first. `channelId`: undefined = every video, null = videos without a channel (from before channels). */
  list(opts?: { channelId?: string | null; limit?: number }): Promise<Project[]>;
  exists(id: string): Promise<boolean>;
  /** Insert; throws ConflictError if the id is taken. */
  create(project: Project): Promise<void>;
  save(project: Project): Promise<void>;
  /** Mark rows left "running" by a crashed process as paused. */
  pauseAllRunning(reason: string): Promise<number>;
  /** Delete the row and its generation log. */
  delete(id: string): Promise<void>;
}

/** Prompts are scoped: SHARED ("") or a channel id (that channel's own copies). */
export interface PromptRepository {
  list(channelId: string): Promise<Prompt[]>;
  findByKey(channelId: string, key: string): Promise<Prompt | undefined>;
  /** Insert a prompt with its first revision if the key doesn't exist yet (never overwrites edits). */
  createIfMissing(prompt: Prompt, revision: PromptRevision): Promise<boolean>;
  /** Persist the prompt's new version and its revision atomically; fails if the stored version moved on. */
  saveRevision(prompt: Prompt, revision: PromptRevision, expectedPreviousVersion: number): Promise<void>;
  history(channelId: string, key: string, limit?: number): Promise<PromptRevision[]>;
  /** Delete a channel's copy of one prompt (or all its copies) with their history. Never the shared ones. */
  deleteChannelCopies(channelId: string, key?: string): Promise<number>;
}

export interface GenerationRepository {
  add(g: Omit<Generation, "createdAt">): Promise<void>;
  listByProject(projectId: string, limit?: number): Promise<Generation[]>;
}

export interface ChannelKitRepository {
  findById(id: string): Promise<ChannelKit | undefined>;
  list(limit?: number): Promise<ChannelKit[]>;
  exists(id: string): Promise<boolean>;
  /** Insert; throws ConflictError if the id is taken. */
  create(kit: ChannelKit): Promise<void>;
  save(kit: ChannelKit): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ContentPlanRepository {
  findByMonth(channelId: string, month: string): Promise<ContentPlan | undefined>;
  /** Newest month first. */
  list(channelId: string, limit?: number): Promise<ContentPlan[]>;
  /** Insert or replace. */
  save(plan: ContentPlan): Promise<void>;
  /** Delete every plan of a channel. */
  deleteChannel(channelId: string): Promise<number>;
  /** Move plans from one channel to another (e.g. plans made before channels, channelId ""), skipping months the target already has. */
  reassign(fromChannelId: string, toChannelId: string): Promise<number>;
}

export interface ModelSettingRepository {
  list(): Promise<ModelSetting[]>;
  findByTask(task: string): Promise<ModelSetting | undefined>;
  /** Insert if the task has no setting yet (never overwrites a user's choice). */
  createIfMissing(setting: ModelSetting): Promise<boolean>;
  save(setting: ModelSetting): Promise<void>;
}
