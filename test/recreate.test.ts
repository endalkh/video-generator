import { afterEach, describe, expect, it } from "vitest";
import { fileExists } from "../src/util/fs.js";
import { mediaPaths } from "../src/services/pipeline.service.js";
import { makeTestContainer, mockProvider } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());
const media = (id: string) => mediaPaths(c.projectService.mediaFile(id, ["x"])!.replace(/\/x$/, ""));

describe("re-create a video", () => {
  it("makes a new copy with the same settings, keeping the words and character when asked", async () => {
    const mock = mockProvider();
    c = await makeTestContainer({ provider: () => mock });
    const ch = (await c.channelService.create({ input: { name: "Milcah's World" }, provider: "mock" })).id;
    const src = await c.projectService.create({ topic: "Washing hands", sceneCount: 2, singer: "girl", reviewMode: "auto", audioRequest: "slower" }, "mock", { channelId: ch });
    await c.projectService.start(src.id);
    await c.projectService.idle();
    const original = await c.projectService.get(src.id);
    const characterPrompts = mock.prompts.filter((x) => x.kind === "character").length;

    const copy = await c.projectService.recreate(src.id, { keepPoem: true, keepCharacter: true });
    await c.projectService.idle();
    const done = await c.projectService.get(copy.id);
    expect(copy.id).not.toBe(src.id);
    expect(done).toMatchObject({ status: "done", channelId: ch, poem: original.poem, character: original.character });
    expect(done.input).toMatchObject({ topic: "Washing hands", sceneCount: 2, singer: "girl" });
    expect(done.input.audioRequest).toBeUndefined();
    expect(mock.prompts.filter((x) => x.kind === "character")).toHaveLength(characterPrompts); // character reused
    expect(await fileExists(media(copy.id).final)).toBe(true);
    expect((await c.projectService.get(src.id)).updatedAt).toBe(original.updatedAt); // original untouched

    // From scratch: a new poem and character.
    const fresh = await c.projectService.recreate(src.id, { keepPoem: false, keepCharacter: false });
    await c.projectService.idle();
    expect(mock.prompts.filter((x) => x.kind === "character").length).toBe(characterPrompts + 1);
    expect((await c.projectService.get(fresh.id)).status).toBe("done");
  }, 60_000);
});
