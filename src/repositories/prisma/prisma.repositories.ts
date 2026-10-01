import { ConflictError } from "../../domain/errors.js";
import type { Generation } from "../../domain/generation/generation.model.js";
import { GenerationMapper } from "../../domain/generation/generation.mapper.js";
import type { ModelSetting } from "../../domain/model-setting/model-setting.entity.js";
import { ModelSettingMapper } from "../../domain/model-setting/model-setting.mapper.js";
import type { Project } from "../../domain/project/project.entity.js";
import { ProjectMapper } from "../../domain/project/project.mapper.js";
import type { Prompt, PromptRevision } from "../../domain/prompt/prompt.entity.js";
import { PromptMapper } from "../../domain/prompt/prompt.mapper.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { Db } from "../../infrastructure/prisma.js";
import type { GenerationRepository, ModelSettingRepository, ProjectRepository, PromptRepository } from "../repositories.js";

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export class PrismaProjectRepository implements ProjectRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string) {
    const row = await this.db.project.findUnique({ where: { id } });
    return row ? ProjectMapper.toDomain(row) : undefined;
  }

  async list(limit = 100) {
    const rows = await this.db.project.findMany({ orderBy: { updatedAt: "desc" }, take: limit });
    return rows.map(ProjectMapper.toDomain);
  }

  async exists(id: string) {
    return (await this.db.project.count({ where: { id } })) > 0;
  }

  async create(project: Project) {
    try {
      await this.db.project.create({ data: ProjectMapper.toPersistence(project) });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`Project "${project.id}" already exists`);
      throw err;
    }
  }

  async save(project: Project) {
    const { id, createdAt: _c, ...data } = ProjectMapper.toPersistence(project);
    await this.db.project.update({ where: { id }, data });
  }

  async pauseAllRunning(reason: string) {
    const res = await this.db.project.updateMany({ where: { status: "running" }, data: { status: "paused", error: reason } });
    return res.count;
  }
}

export class PrismaPromptRepository implements PromptRepository {
  constructor(private readonly db: Db) {}

  async list() {
    const rows = await this.db.prompt.findMany();
    return rows.flatMap((r) => {
      try {
        return [PromptMapper.toDomain(r)];
      } catch {
        return []; // keys no longer defined in code are ignored
      }
    });
  }

  async findByKey(key: string) {
    const row = await this.db.prompt.findUnique({ where: { key } });
    return row ? PromptMapper.toDomain(row) : undefined;
  }

  async createIfMissing(prompt: Prompt, revision: PromptRevision) {
    try {
      await this.db.prompt.create({
        data: { ...PromptMapper.toPersistence(prompt), versions: { create: { version: revision.version, template: revision.template, note: revision.note } } },
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async saveRevision(prompt: Prompt, revision: PromptRevision, expectedPreviousVersion: number) {
    const { key, template, version } = PromptMapper.toPersistence(prompt);
    await this.db.$transaction(async (tx) => {
      // Optimistic concurrency: two editors saving at once can't silently overwrite each other.
      const res = await tx.prompt.updateMany({ where: { key, version: expectedPreviousVersion }, data: { template, version } });
      if (res.count !== 1) throw new ConflictError(`Prompt "${key}" was changed by someone else; reload and try again`);
      await tx.promptVersion.create({ data: { key, version: revision.version, template: revision.template, note: revision.note } });
    });
  }

  async history(key: string, limit = 50) {
    const rows = await this.db.promptVersion.findMany({ where: { key }, orderBy: { version: "desc" }, take: limit });
    return rows.map(PromptMapper.revisionToDomain);
  }
}

export class PrismaGenerationRepository implements GenerationRepository {
  constructor(private readonly db: Db) {}

  async add(g: Omit<Generation, "createdAt">) {
    await this.db.generation.create({ data: GenerationMapper.toPersistence(g) });
  }

  async listByProject(projectId: string, limit = 200) {
    const rows = await this.db.generation.findMany({ where: { projectId }, orderBy: { id: "desc" }, take: limit });
    return rows.map(GenerationMapper.toDomain);
  }
}

export class PrismaModelSettingRepository implements ModelSettingRepository {
  constructor(private readonly db: Db) {}

  async list() {
    const rows = await this.db.modelSetting.findMany();
    return rows.flatMap((r) => {
      try {
        return [ModelSettingMapper.toDomain(r)];
      } catch {
        return []; // tasks no longer defined in code are ignored
      }
    });
  }

  async findByTask(task: string) {
    const row = await this.db.modelSetting.findUnique({ where: { task } });
    return row ? ModelSettingMapper.toDomain(row) : undefined;
  }

  async createIfMissing(setting: ModelSetting) {
    try {
      await this.db.modelSetting.create({ data: ModelSettingMapper.toPersistence(setting) });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async save(setting: ModelSetting) {
    const { task, model } = ModelSettingMapper.toPersistence(setting);
    await this.db.modelSetting.upsert({ where: { task }, create: { task, model }, update: { model } });
  }
}
