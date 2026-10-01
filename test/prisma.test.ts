import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError } from "../src/domain/errors.js";
import { Project } from "../src/domain/project/project.entity.js";
import { ProjectInputSchema } from "../src/domain/project/project.model.js";
import { createPrismaClient, type Db } from "../src/infrastructure/prisma.js";
import { PrismaGenerationRepository, PrismaModelSettingRepository, PrismaProjectRepository, PrismaPromptRepository } from "../src/repositories/prisma/prisma.repositories.js";
import { PromptService } from "../src/services/prompt.service.js";

/** Runs against TEST_DATABASE_URL (migrated with `prisma migrate deploy`); the tables are wiped. */
const url = process.env.TEST_DATABASE_URL;
if (url && url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL (tests wipe it)");

describe.skipIf(!url)("Prisma repositories (Postgres)", () => {
  let db: Db;
  beforeAll(async () => {
    db = createPrismaClient(url);
    await db.$executeRawUnsafe("TRUNCATE generations, projects, prompt_versions, prompts, model_settings RESTART IDENTITY CASCADE");
  });
  afterAll(async () => db?.$disconnect());

  it("round-trips a project aggregate including JSON artifacts", async () => {
    const repo = new PrismaProjectRepository(db);
    const p = Project.create({ id: "db-test", input: ProjectInputSchema.parse({ topic: "ሰላም ልጆች", language: "am" }), provider: "mock" });
    await repo.create(p);
    await expect(repo.create(p)).rejects.toBeInstanceOf(ConflictError);

    p.start("mock");
    p.setPoem({ title: "ሰላም", stanzas: [{ lines: ["አንድ", "ሁለት"] }] });
    p.completeStep("poem");
    await repo.save(p);

    const loaded = (await repo.findById("db-test"))!;
    expect(loaded.status).toBe("running");
    expect(loaded.poem?.stanzas[0]?.lines).toEqual(["አንድ", "ሁለት"]);
    expect(loaded.completed).toEqual(["poem"]);
    expect(loaded.character).toBeNull();
    expect(await repo.pauseAllRunning("interrupted")).toBe(1);
    expect((await repo.findById("db-test"))!.status).toBe("paused");
  });

  it("stores prompts with versions and optimistic locking", async () => {
    const service = new PromptService(new PrismaPromptRepository(db));
    expect(await service.seedDefaults()).toBeGreaterThan(0);
    expect(await service.seedDefaults()).toBe(0);
    const v2 = await service.update("safety", "Always gentle.", { note: "test" });
    expect(v2.version).toBe(2);
    await expect(service.update("safety", "stale", { expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictError);
    expect((await service.history("safety")).map((h) => [h.version, h.note])).toEqual([[2, "test"], [1, "default"]]);
    expect((await service.snapshotFor(ProjectInputSchema.parse({ topic: "Colors" }))).render("character_image", { character_name: "A", character_description: "B" }).text).toContain("Always gentle.");
  });

  it("persists per-task model settings", async () => {
    const repo = new PrismaModelSettingRepository(db);
    const { ModelSetting } = await import("../src/domain/model-setting/model-setting.entity.js");
    expect(await repo.createIfMissing(ModelSetting.default("poem"))).toBe(true);
    expect(await repo.createIfMissing(ModelSetting.default("poem"))).toBe(false);
    const s = (await repo.findByTask("poem"))!;
    s.change("gemini-3.1-pro-preview");
    await repo.save(s);
    expect((await repo.findByTask("poem"))!.model).toBe("gemini-3.1-pro-preview");
  });

  it("logs generations per project", async () => {
    const repo = new PrismaGenerationRepository(db);
    await repo.add({ projectId: "db-test", step: "poem", sceneIndex: null, promptKey: "poem", promptVersion: 1, prompt: "hi", provider: "mock", model: "gemini-3.8-flash" });
    expect((await repo.listByProject("db-test"))[0]).toMatchObject({ promptKey: "poem", prompt: "hi" });
  });
});
