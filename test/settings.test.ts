import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "../src/domain/errors.js";
import { fileExists } from "../src/util/fs.js";
import { mediaPaths } from "../src/services/pipeline.service.js";
import { makeTestContainer, mockProvider } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());

async function runToEnd(id: string) {
  await c.projectService.start(id);
  await c.projectService.idle();
  return c.projectService.get(id);
}
const media = (id: string) => mediaPaths(c.projectService.mediaFile(id, ["x"])!.replace(/\/x$/, ""));

describe("changing settings after the video was started", () => {
  it("a new length with auto scenes writes a new poem but keeps the character", async () => {
    c = await makeTestContainer();
    const p = await c.projectService.create({ reviewMode: "auto", topic: "Sharing toys", sceneCount: 2 }, "mock");
    const done = await runToEnd(p.id);
    expect(done.status).toBe("done");
    const character = done.character;

    const r = await c.projectService.changeSettings(p.id, { lengthSeconds: 60, sceneCount: null });
    expect(r.redoFrom).toBe("poem");
    expect(r.project).toMatchObject({ poem: null, scenes: null, completed: [], status: "paused" });
    expect(r.project.input).toMatchObject({ lengthSeconds: 60, sceneCount: 6, songSeconds: 60 });
    expect(r.project.character).toEqual(character);
    expect(await fileExists(media(p.id).characterImage)).toBe(true); // kept, not redrawn
    expect(await fileExists(media(p.id).final)).toBe(false);
    expect(await fileExists(media(p.id).sceneImage(0))).toBe(false);

    const again = await runToEnd(p.id);
    expect([again.status, again.poem!.stanzas.length]).toEqual(["done", 6]);
  }, 60_000);

  it("a new length with the same scenes can keep the poem and pictures (audio only)", async () => {
    c = await makeTestContainer();
    const p = await c.projectService.create({ reviewMode: "auto", topic: "Counting stars", sceneCount: 2 }, "mock");
    const done = await runToEnd(p.id);
    const r = await c.projectService.changeSettings(p.id, { lengthSeconds: 40 }, { keepPoem: true });
    expect(r.redoFrom).toBe("audio");
    expect(r.project.poem).toEqual(done.poem);
    expect(r.project.completed).toEqual(["poem", "scenes", "character"]);
    expect(await fileExists(media(p.id).sceneImage(0))).toBe(true);
    expect(await fileExists(media(p.id).final)).toBe(false);
  }, 60_000);

  it("only redoes what depends on the change", async () => {
    c = await makeTestContainer({ provider: mockProvider });
    const p = await c.projectService.create({ topic: "Brushing teeth", sceneCount: 2, reviewMode: "manual" }, "mock");
    await c.projectService.start(p.id);
    await c.projectService.idle(); // poem made, waiting for review
    expect((await c.projectService.changeSettings(p.id, { topic: "Brushing teeth" })).redoFrom).toBeNull(); // no change
    expect((await c.projectService.changeSettings(p.id, { language: "am" })).redoFrom).toBe("poem");

    for (const s of ["poem", "scenes", "character"] as const) {
      await c.projectService.generateStep(p.id, s);
      await c.projectService.idle();
    }
    expect((await c.projectService.changeSettings(p.id, { style: "watercolour picture book" })).project.completed).toEqual(["poem", "scenes"]);
    await c.projectService.generateStep(p.id, "character");
    await c.projectService.idle();
    expect((await c.projectService.changeSettings(p.id, { aspectRatio: "9:16" })).redoFrom).toBe("clips");

    await expect(c.projectService.changeSettings(p.id, { provider: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(c.projectService.changeSettings(p.id, { lengthSeconds: 5000 })).rejects.toBeInstanceOf(ValidationError);
    await c.projectService.start(p.id);
    await expect(c.projectService.changeSettings(p.id, { language: "en" })).rejects.toBeInstanceOf(ConflictError);
    await c.projectService.idle();
  }, 60_000);
});
