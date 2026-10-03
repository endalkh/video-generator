import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROMPTS, promptDefinition } from "../src/domain/prompt/prompt.defaults.js";
import { Prompt } from "../src/domain/prompt/prompt.entity.js";
import { probeDuration } from "../src/infrastructure/media/ffmpeg.js";
import { InMemoryPromptRepository } from "../src/repositories/memory/memory.repositories.js";
import { mediaPaths } from "../src/services/pipeline.service.js";
import { PromptService } from "../src/services/prompt.service.js";
import { makeTestContainer, mockProvider } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());

describe("video length", () => {
  it("makes a song longer than one model request in parts and joins them", async () => {
    const mock = mockProvider(); // fixed 4 s songs, like a tiny Lyria 3 Clip
    c = await makeTestContainer({ provider: () => mock });
    const p = await c.projectService.create({ reviewMode: "auto", topic: "Counting goats", lengthSeconds: 20, sceneCount: 6 }, "mock");
    await c.projectService.start(p.id);
    await c.projectService.idle();
    const done = await c.projectService.get(p.id);
    expect(done.status).toBe("done");
    expect(done.song!.file).toBe("song.wav");

    const songs = mock.prompts.filter((x) => x.kind === "song");
    expect(songs).toHaveLength(5); // 20 s / 4 s
    expect(songs[0]!.prompt).toContain("part 1 of 5");
    expect(songs[1]!.prompt).toContain("Continue the same song");
    expect(songs[4]!.prompt).toContain("happy, clear ending");
    // Every verse is sung exactly once across the parts.
    for (let i = 1; i <= 6; i++) expect(songs.filter((s) => s.prompt.includes(`Verse ${i}:`) || s.prompt.includes(`verse ${i}:`)).length).toBe(1);

    const dir = c.projectService.mediaFile(p.id, ["x"])!.replace(/\/x$/, "");
    expect(await probeDuration(mediaPaths(dir).final)).toBeCloseTo(20, 0);
    expect((await readdir(dir)).filter((f) => f.startsWith("song-part-"))).toHaveLength(5);

    // A new song wipes the parts too.
    await c.projectService.generateStep(p.id, "audio", { provider: "mock" });
    await c.projectService.idle();
    expect(mock.prompts.filter((x) => x.kind === "song")).toHaveLength(10);
  }, 60_000);

  it("asks for a narrated story that fills the chosen length", async () => {
    const mock = mockProvider();
    c = await makeTestContainer({ provider: () => mock });
    const p = await c.projectService.create({ topic: "A goat finds a friend", audioMode: "narration", lengthSeconds: 300, reviewMode: "manual" }, "mock");
    expect(p.input.sceneCount).toBe(25);
    await c.projectService.start(p.id);
    await c.projectService.idle();
    const poem = mock.prompts.find((x) => x.kind === "poem")!.prompt;
    expect(poem).toContain("Exactly 25 stanzas of 4 short lines each");
    expect(poem).toContain("in about 300 seconds");
    expect(poem).toMatch(/each line has about \d+ syllables/);
  });
});

describe("built-in prompt upgrades", () => {
  it("updates prompts still on an old default, never ones the user edited", async () => {
    const repo = new InMemoryPromptRepository();
    const service = new PromptService(repo);
    const poemDef = promptDefinition("poem");
    const songDef = promptDefinition("song");
    // Simulate an older install: poem on an old default (untouched), song edited by the user.
    const oldPoem = Prompt.fromDefault({ ...poemDef, template: poemDef.previousTemplates![0]! });
    await repo.createIfMissing(oldPoem, oldPoem.initialRevision());
    const song = Prompt.fromDefault({ ...songDef, template: songDef.previousTemplates![0]! });
    await repo.createIfMissing(song, song.initialRevision());
    const rev = song.revise("My own song prompt about {{title}}", "mine")!;
    await repo.saveRevision(song, rev, 1);

    expect(await service.seedDefaults()).toBe(DEFAULT_PROMPTS.length - 2);
    expect(await service.get("poem")).toMatchObject({ version: 2, isDefault: true });
    expect((await service.history("poem"))[0]!.note).toBe("built-in default updated");
    expect((await service.get("song")).template).toBe("My own song prompt about {{title}}");
    expect(await service.seedDefaults()).toBe(0); // idempotent
    expect((await service.get("poem")).version).toBe(2);
  });
});
