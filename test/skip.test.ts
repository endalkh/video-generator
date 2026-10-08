import { afterEach, describe, expect, it } from "vitest";
import { makeTestContainer } from "./helpers.js";
import { fileExists } from "../src/util/fs.js";
import { mediaPaths } from "../src/services/pipeline.service.js";

let c: Awaited<ReturnType<typeof makeTestContainer>> | undefined;
afterEach(async () => { await c?.cleanup(); c = undefined; });

describe("skipping steps", () => {
  it("skips the character and the audio from their pages; the rest is made without them", async () => {
    c = await makeTestContainer();
    const ps = c.projectService;
    const { id } = await ps.create({ topic: "Swimming at the beach", sceneCount: 2, reviewMode: "manual", videoMode: "veo", audioMode: "song" }, "mock");
    await ps.start(id);
    await ps.idle();
    await ps.generateStep(id, "scenes");
    await ps.idle();

    const sk = await ps.skipCharacter(id);
    expect([sk.character?.skipped, sk.completed, sk.status]).toEqual([true, ["poem", "scenes", "character"], "paused"]);
    const sa = await ps.skipAudio(id);
    expect([sa.input.videoAudio, sa.input.backgroundMusic, sa.completed.includes("audio"), sa.status]).toEqual([true, false, true, "paused"]);
    await ps.idle();
    expect((await ps.get(id)).completed).not.toContain("clips"); // skipping doesn't start anything

    await ps.generateStep(id, "clips");
    await ps.idle();
    const p = await ps.get(id);
    expect([p.error, p.completed.includes("clips")]).toEqual([null, true]);
    const keys = c.generations.items.filter((g) => g.projectId === id).map((g) => g.promptKey);
    expect(keys).not.toContain("character_image");
    expect(keys).not.toContain("song");
    expect(keys).not.toContain("music_bed");
    expect(await fileExists(mediaPaths(c.pipelineService.mediaDir(id)).characterImage)).toBe(false);

    // Back to the audio AI: the step has to be made again (nothing starts).
    const back = await ps.useAudioAi(id);
    expect([back.input.videoAudio, back.completed]).toEqual([false, ["poem", "scenes", "character"]]);
  }, 90_000);

  it("skips every scene picture at once", async () => {
    c = await makeTestContainer();
    const ps = c.projectService;
    const { id } = await ps.create({ topic: "Shells", sceneCount: 3, reviewMode: "manual", videoMode: "veo" }, "mock");
    await ps.start(id);
    await ps.idle();
    await ps.generateStep(id, "scenes");
    await ps.idle();
    expect((await ps.setAllScenePictures(id, false)).scenes!.scenes.map((s) => s.picture)).toEqual([false, false, false]);
    expect((await ps.setAllScenePictures(id, true)).scenes!.scenes.map((s) => s.picture)).toEqual([true, true, true]);
  }, 60_000);

  it("skips the scene plan: one scene per stanza, no AI call", async () => {
    c = await makeTestContainer();
    const ps = c.projectService;
    const { id } = await ps.create({ topic: "Building sand castles", sceneCount: 2, reviewMode: "manual" }, "mock");
    await ps.start(id);
    await ps.idle();
    const p = await ps.skipScenes(id);
    expect([p.completed, p.status, p.scenes!.scenes.length]).toEqual([["poem", "scenes"], "paused", 2]);
    expect(p.scenes!.scenes[0]!.text).toBe(p.poem!.stanzas[0]!.lines.join("\n"));
    expect(p.scenes!.scenes[0]!.visualPrompt).toMatch(/Building sand castles/);
    expect(c.generations.items.filter((g) => g.projectId === id).map((g) => g.promptKey)).not.toContain("scenes");
  }, 60_000);
});
