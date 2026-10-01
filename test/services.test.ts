import { readFile, stat, unlink } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "../src/domain/errors.js";
import { probeDuration } from "../src/infrastructure/media/ffmpeg.js";
import { mediaPaths } from "../src/services/pipeline.service.js";
import { makeTestContainer, mockProvider } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());

async function runToEnd(id: string, opts: { from?: string } = {}) {
  await c.projectService.start(id, opts);
  await c.projectService.idle();
  return c.projectService.get(id);
}

describe("PromptService", () => {
  it("seeds once, versions edits, restores, and resets", async () => {
    c = await makeTestContainer();
    expect(await c.promptService.seedDefaults()).toBe(0); // idempotent
    const edited = await c.promptService.update("safety", "Be very gentle.", { note: "tone" });
    expect([edited.version, edited.isDefault]).toEqual([2, false]);
    await expect(c.promptService.update("safety", "x", { expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictError);
    await expect(c.promptService.update("safety", "{{nope}}")).rejects.toBeInstanceOf(ValidationError);
    expect((await c.promptService.restore("safety", 1)).isDefault).toBe(true);
    expect((await c.promptService.history("safety")).map((h) => h.version)).toEqual([3, 2, 1]);
  });

  it("previews unsaved drafts with the project's language flags", async () => {
    c = await makeTestContainer();
    const text = await c.promptService.preview("poem", "{{#if am}}AMHARIC{{else}}ENGLISH{{/if}} {{topic}}", { topic: "Sharing", language: "am" } as never);
    expect(text).toBe("AMHARIC Sharing");
    expect((await c.promptService.get("poem")).version).toBe(1); // preview never saves
  });
});

describe("manual review mode", () => {
  it("stops after each step, allows edits, and continues on approval", async () => {
    c = await makeTestContainer();
    const created = await c.projectService.create({ topic: "sheep and goats", sceneCount: 2, reviewMode: "manual" }, "mock");
    const ps = c.projectService;
    const settle = async () => { await ps.idle(); return ps.get(created.id); };

    await ps.start(created.id);
    let p = await settle();
    expect([p.status, p.awaitingReview, p.completed]).toEqual(["review", "poem", ["poem"]]);

    // Edit the poem: stanza count must match the scenes.
    await expect(ps.editPoem(created.id, { title: "T", stanzas: [{ lines: ["only one"] }] })).rejects.toBeInstanceOf(ValidationError);
    await ps.editPoem(created.id, { title: "Selam's Flock", stanzas: [{ lines: ["Sheep on the hill"] }, { lines: ["Goats by the stream"] }] });
    await ps.approve(created.id, "poem");
    p = await settle();
    expect([p.awaitingReview, p.scenes!.scenes.map((s) => s.text)]).toEqual(["scenes", ["Sheep on the hill", "Goats by the stream"]]);

    await ps.approve(created.id, "scenes");
    p = await settle();
    expect(p.awaitingReview).toBe("character");
    const charCalls = () => c.generations.items.filter((g) => g.promptKey === "character").length;
    const before = charCalls();
    await ps.editCharacter(created.id, { name: "Selam", description: "a girl in a yellow dress" });
    p = await settle(); // picture redrawn, waiting for review again
    expect([p.awaitingReview, p.character!.name, p.media.characterImage]).toEqual(["character", "Selam", "character.png"]);
    expect(charCalls()).toBe(before); // edited character reused, not regenerated
    await ps.approve(created.id, "character");
    p = await settle();

    // Regenerating the song keeps earlier approvals.
    expect(p.awaitingReview).toBe("audio");
    await ps.regenerate(created.id, "audio");
    p = await settle();
    expect([p.awaitingReview, p.approved]).toEqual(["audio", ["poem", "scenes", "character"]]);

    await ps.approve(created.id, "audio");
    p = await settle();
    expect(p.awaitingReview).toBe("clips");
    await ps.redoScene(created.id, 1);
    p = await settle();
    expect(p.awaitingReview).toBe("clips");
    await ps.approve(created.id, "clips");
    p = await settle();
    expect([p.status, p.media.final]).toEqual(["done", "final.mp4"]);
  }, 60_000);

  it("can switch a manual project to auto and finish", async () => {
    c = await makeTestContainer();
    const created = await c.projectService.create({ topic: "counting stars", sceneCount: 2, reviewMode: "manual" }, "mock");
    await c.projectService.start(created.id);
    await c.projectService.idle();
    await c.projectService.setReviewMode(created.id, "auto");
    await c.projectService.start(created.id);
    await c.projectService.idle();
    expect((await c.projectService.get(created.id)).status).toBe("done");
  }, 60_000);
});

describe("one step at a time", () => {
  it("generates each step on its own, in order, and remakes a done step", async () => {
    c = await makeTestContainer();
    const ps = c.projectService;
    const { id } = await ps.create({ topic: "feeding the chickens", sceneCount: 2 }, "mock");
    const gen = async (step: string) => { await ps.generateStep(id, step, { provider: "mock" }); await ps.idle(); return ps.get(id); };

    await expect(ps.generateStep(id, "scenes")).rejects.toBeInstanceOf(ConflictError); // poem first
    await expect(ps.generateStep(id, "nope")).rejects.toBeInstanceOf(ValidationError);

    let p = await gen("poem");
    expect([p.status, p.error, p.completed]).toEqual(["paused", null, ["poem"]]);
    p = await gen("scenes");
    expect([p.completed, p.media.characterImage]).toEqual([["poem", "scenes"], null]);
    p = await gen("character");
    expect([p.completed.at(-1), p.media.characterImage]).toEqual(["character", "character.png"]);
    p = await gen("audio");
    expect(p.completed.at(-1)).toBe("audio");
    p = await gen("clips");
    expect([p.completed.at(-1), p.media.final, p.media.scenes.every((s) => s.clip)]).toEqual(["clips", null, true]);

    // Remaking the scenes clears everything after them.
    p = await gen("scenes");
    expect(p.completed).toEqual(["poem", "scenes"]);
    await expect(ps.generateStep(id, "clips")).rejects.toBeInstanceOf(ConflictError);
    for (const s of ["character", "audio", "clips"]) await gen(s);
    p = await gen("final");
    expect([p.status, p.media.final]).toEqual(["done", "final.mp4"]);
  }, 60_000);

  it("uses an uploaded character picture, describing it with AI when no description is given", async () => {
    c = await makeTestContainer();
    const ps = c.projectService;
    const { id } = await ps.create({ topic: "herding the goats", sceneCount: 2 }, "mock");
    const picture = await mockProvider().image("x", { model: "m", ctx: { input: (await ps.get(id)).input } });
    const dataUrl = `data:image/png;base64,${picture.toString("base64")}`;

    await expect(ps.uploadCharacter(id, { image: dataUrl })).rejects.toBeInstanceOf(ConflictError); // scenes first
    for (const s of ["poem", "scenes"]) { await ps.generateStep(id, s); await ps.idle(); }
    await expect(ps.uploadCharacter(id, { image: "data:image/gif;base64,R0lGOD" })).rejects.toBeInstanceOf(ValidationError);
    await expect(ps.uploadCharacter(id, { image: Buffer.alloc(200, 7).toString("base64") })).rejects.toThrow(/Couldn't read that picture/);

    // With a name only: the character model looks at the picture; the given name is kept.
    let p = await ps.uploadCharacter(id, { image: dataUrl, name: "Selam" });
    expect([p.character!.name, p.completed]).toEqual(["Selam", ["poem", "scenes", "character"]]);
    const described = c.generations.items.filter((g) => g.promptKey === "character_from_image");
    expect(described).toHaveLength(1);
    expect(described[0]!.prompt).toContain("Name: Selam");
    const media = mediaPaths(c.pipelineService.mediaDir(id));
    expect((await readFile(media.characterImage)).subarray(1, 4).toString()).toBe("PNG");

    // Run to the end: the uploaded picture is used, not redrawn.
    await runToEnd(id);
    expect(c.generations.items.some((g) => g.promptKey === "character" || g.promptKey === "character_image")).toBe(false);

    // Replacing it later keeps the song and only redoes clips + final; a given description skips the AI.
    const before = c.generations.items.length;
    p = await ps.uploadCharacter(id, { image: picture.toString("base64"), name: "Abeba", description: "a girl in a green dress" });
    expect([p.character, p.completed, p.status]).toEqual([{ name: "Abeba", description: "a girl in a green dress" }, ["poem", "scenes", "character", "audio"], "paused"]);
    expect(c.generations.items.length).toBe(before);
    expect((await ps.get(id)).media.final).toBeNull();
  }, 60_000);

  it("in manual mode, generating the next step approves the earlier ones", async () => {
    c = await makeTestContainer();
    const ps = c.projectService;
    const { id } = await ps.create({ topic: "rainy day songs", sceneCount: 2, reviewMode: "manual" }, "mock");
    await ps.generateStep(id, "poem");
    await ps.idle();
    expect((await ps.get(id)).awaitingReview).toBe("poem");
    await ps.generateStep(id, "scenes");
    await ps.idle();
    const p = await ps.get(id);
    expect([p.awaitingReview, p.approved]).toEqual(["scenes", ["poem"]]);
  }, 60_000);
});

describe("ModelSettingsService", () => {
  it("lists, updates, resets and groups available models", async () => {
    c = await makeTestContainer();
    const list = await c.modelSettingsService.list();
    expect(list.map((s) => s.task)).toEqual(["poem", "scenes", "character", "character_image", "scene_image", "song", "narration", "scene_video"]);
    expect((await c.modelSettingsService.update("poem", "gemini-3.1-pro-preview")).isDefault).toBe(false);
    await expect(c.modelSettingsService.update("poem", "lyria-3.5")).rejects.toBeInstanceOf(ValidationError);
    expect((await c.modelSettingsService.reset("poem")).model).toBe("gemini-3.8-flash");
    const avail = await c.modelSettingsService.availableModels("mock");
    expect(avail.byCapability.music.map((m) => m.id)).toEqual(["lyria-3-clip-preview"]);
    expect(avail.warning).toBeNull();
  });
});

describe("pipeline (mock provider, real ffmpeg)", () => {
  it("sends each task to the model chosen in settings", async () => {
    c = await makeTestContainer();
    await c.modelSettingsService.update("poem", "gemini-3.1-pro-preview");
    await c.modelSettingsService.update("scene_image", "gemini-3-pro-image");
    const created = await c.projectService.create({ topic: "sharing is caring", sceneCount: 2 }, "mock");
    await runToEnd(created.id);
    const byKey = (k: string) => c.generations.items.filter((g) => g.promptKey === k).map((g) => g.model);
    expect(byKey("poem")).toEqual(["gemini-3.1-pro-preview"]);
    expect(byKey("scenes")).toEqual(["gemini-3.8-flash"]);
    expect(byKey("scene_image")).toEqual(["gemini-3-pro-image", "gemini-3-pro-image"]);
    expect(byKey("song")).toEqual(["lyria-3-clip-preview"]);
  }, 60_000);

  it("renders a song video using DB prompts, then resumes from checkpoints", async () => {
    c = await makeTestContainer();
    await c.promptService.update("song", "SONG PROMPT for {{title}}:\n{{timed_lyrics}}");
    const created = await c.projectService.create({ topic: "washing hands", sceneCount: 2, audioMode: "song" }, "mock");

    const done = await runToEnd(created.id);
    expect(done.status).toBe("done");
    expect(done.completed).toEqual(["poem", "scenes", "character", "audio", "clips", "final"]);
    const p = mediaPaths(c.pipelineService.mediaDir(created.id));
    expect(await probeDuration(p.final)).toBeCloseTo(4, 0);

    // The edited song prompt was used and logged with its version.
    const song = c.generations.items.find((g) => g.promptKey === "song")!;
    expect(song.promptVersion).toBe(2);
    expect(song.prompt).toMatch(/^SONG PROMPT for washing hands:\n\[0:00 - /);

    // Delete one clip: only clips + final rerun, and the other scene's clip is untouched.
    const keep = (await stat(p.sceneClip(0))).mtimeMs;
    await unlink(p.sceneClip(1));
    const before = c.generations.items.length;
    const again = await runToEnd(created.id);
    expect(again.status).toBe("done");
    expect((await stat(p.sceneClip(0))).mtimeMs).toBe(keep);
    expect(c.generations.items.length).toBe(before); // image already existed → no new model calls
  }, 60_000);

  it("narration mode renders per-scene audio; redo-from wipes stale media", async () => {
    c = await makeTestContainer();
    const created = await c.projectService.create({ topic: "counting goats", sceneCount: 2, audioMode: "narration", aspectRatio: "9:16" }, "mock");
    await runToEnd(created.id);
    const p = mediaPaths(c.pipelineService.mediaDir(created.id));
    expect(await probeDuration(p.final)).toBeCloseTo(3, 0); // 2 × (1s + 0.5s tail)

    const imageCalls = () => c.generations.items.filter((g) => g.promptKey === "scene_image").length;
    const before = imageCalls();
    const redone = await runToEnd(created.id, { from: "clips" });
    expect(redone.status).toBe("done");
    expect(imageCalls()).toBe(before + 2); // scene images regenerated, not reused
  }, 60_000);

  it("switching visuals re-renders only clips and final", async () => {
    c = await makeTestContainer();
    const created = await c.projectService.create({ topic: "goats on the hill", sceneCount: 2 }, "mock");
    await runToEnd(created.id);
    const before = c.generations.items.map((g) => g.promptKey);
    await c.projectService.changeVisuals(created.id, "veo");
    await c.projectService.idle();
    const p = await c.projectService.get(created.id);
    expect([p.status, p.input.videoMode]).toEqual(["done", "veo"]);
    // Only scene_video prompts were added; poem, song and pictures were kept.
    const added = c.generations.items.map((g) => g.promptKey).slice(before.length);
    expect(added).toEqual(["scene_video", "scene_video"]);
    await expect(c.projectService.changeVisuals(created.id, "hologram")).rejects.toBeInstanceOf(ValidationError);
  }, 60_000);

  it("a failed video clip fails the run with the error (no fallback to pictures)", async () => {
    c = await makeTestContainer();
    const created = await c.projectService.create({ topic: "goats and sheep", sceneCount: 2, videoMode: "veo" }, "mock");
    const { MockProvider } = await import("../src/infrastructure/providers/mock.js");
    MockProvider.prototype.video = async () => { throw new Error("quota exceeded"); };
    try {
      const p = await runToEnd(created.id);
      expect(p.status).toBe("failed");
      expect(p.error).toMatch(/^Scene \d video \(veo-3.1-fast-generate-preview\) failed: quota exceeded$/);
      expect(p.media.final).toBeNull();
    } finally {
      delete (MockProvider.prototype as { video?: unknown }).video;
    }
  }, 60_000);

  it("fails clearly when the poem ignores the scene count", async () => {
    c = await makeTestContainer();
    await c.promptService.update("poem", "Write exactly 8 stanzas about {{topic}}.");
    const created = await c.projectService.create({ topic: "counting sheep", sceneCount: 3 }, "mock");
    const { MockProvider } = await import("../src/infrastructure/providers/mock.js");
    const orig = MockProvider.prototype.text;
    MockProvider.prototype.text = async function (kind, prompt, opts) {
      const out = await orig.call(this, kind, prompt, opts);
      return (kind === "poem" ? { ...out, stanzas: Array.from({ length: 8 }, () => ({ lines: ["la"] })) } : out) as never;
    };
    try {
      const p = await runToEnd(created.id);
      expect(p.status).toBe("failed");
      expect(p.error).toMatch(/8 stanzas but the video has 3 scenes/);
    } finally {
      MockProvider.prototype.text = orig;
    }
  }, 60_000);

  it("cancels, then resumes to completion", async () => {
    c = await makeTestContainer();
    const created = await c.projectService.create({ topic: "sharing toys", sceneCount: 2 }, "mock");
    await c.projectService.start(created.id);
    c.projectService.cancel(created.id);
    await c.projectService.idle();
    expect((await c.projectService.get(created.id)).status).toBe("paused");
    expect((await runToEnd(created.id)).status).toBe("done");
  }, 60_000);

  it("rejects invalid input and concurrent runs", async () => {
    c = await makeTestContainer();
    await expect(c.projectService.create({ topic: "x" }, "mock")).rejects.toBeInstanceOf(ValidationError);
    const created = await c.projectService.create({ topic: "tidy up time", sceneCount: 2 }, "mock");
    await c.projectService.start(created.id);
    await expect(c.projectService.start(created.id)).rejects.toBeInstanceOf(ConflictError);
    await c.projectService.idle();
  }, 60_000);
});
