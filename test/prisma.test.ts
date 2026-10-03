import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError } from "../src/domain/errors.js";
import { Project } from "../src/domain/project/project.entity.js";
import { ProjectInputSchema } from "../src/domain/project/project.model.js";
import { createPrismaClient, type Db } from "../src/infrastructure/prisma.js";
import { PrismaChannelKitRepository, PrismaContentPlanRepository, PrismaGenerationRepository, PrismaModelSettingRepository, PrismaProjectRepository, PrismaPromptRepository } from "../src/repositories/prisma/prisma.repositories.js";
import { PromptService } from "../src/services/prompt.service.js";

/** Runs against TEST_DATABASE_URL (migrated with `prisma migrate deploy`); the tables are wiped. */
const url = process.env.TEST_DATABASE_URL;
if (url && url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL (tests wipe it)");

describe.skipIf(!url)("Prisma repositories (Postgres)", () => {
  let db: Db;
  beforeAll(async () => {
    db = createPrismaClient(url);
    await db.$executeRawUnsafe("TRUNCATE generations, projects, prompt_versions, prompts, model_settings, channel_kits, content_plans RESTART IDENTITY CASCADE");
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

  it("round-trips a YouTube channel kit", async () => {
    const { ChannelKit, parseChannelInput } = await import("../src/domain/channel/channel.entity.js");
    const repo = new PrismaChannelKitRepository(db);
    const kit = ChannelKit.create({ id: "db-channel", input: parseChannelInput({ brief: "ፊደል ዘፈኖች", language: "am" }), provider: "mock", hasPhoto: false });
    await repo.create(kit);
    await expect(repo.create(kit)).rejects.toBeInstanceOf(ConflictError);
    expect((await repo.findById("db-channel"))!.details).toBeNull();
    kit.setDetails({ name: "ፊደል", handle: "fidel", description: "d", keywords: ["a"] });
    await repo.save(kit);
    const loaded = (await repo.findById("db-channel"))!;
    expect([loaded.input.brief, loaded.details?.handle, loaded.channelName]).toEqual(["ፊደል ዘፈኖች", "fidel", "ፊደል"]);
    expect((await repo.list()).map((k) => k.id)).toEqual(["db-channel"]);
  });

  it("stores monthly plans", async () => {
    const { ContentPlan, parsePlanInput } = await import("../src/domain/plan/plan.entity.js");
    const repo = new PrismaContentPlanRepository(db);
    const input = parsePlanInput({ about: "Kids songs", postDays: [6] });
    const idea = { date: "2026-11-07", time: "09:00", language: "am" as const, title: "ሀ", topic: "Letters", lesson: "l", audioMode: "song" as const, sceneCount: 4, thumbnailTitle: "t", videoDescription: "d", tags: ["a"], projectId: null };
    const plan = ContentPlan.create("ch-1", "2026-11", input, "Letters", [idea]);
    await repo.save(plan);
    plan.linkProject(0, "db-test");
    await repo.save(plan); // upsert
    const loaded = (await repo.findByMonth("ch-1", "2026-11"))!;
    expect([loaded.theme, loaded.ideas[0]!.projectId, loaded.input.timezone]).toEqual(["Letters", "db-test", "Africa/Addis_Ababa"]);
    expect((await repo.list("ch-1")).map((p) => p.month)).toEqual(["2026-11"]);
    expect(await repo.list("other")).toEqual([]);
    expect(await repo.reassign("ch-1", "ch-2")).toBe(1);
    expect((await repo.findByMonth("ch-2", "2026-11"))!.channelId).toBe("ch-2");
    expect(await repo.deleteChannel("ch-2")).toBe(1);
  });
});
