import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "../src/domain/errors.js";
import { probeStreams } from "../src/infrastructure/media/ffmpeg.js";
import { mediaPaths } from "../src/services/pipeline.service.js";
import { fileExists } from "../src/util/fs.js";
import { makeTestContainer, mockProvider } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());
const media = (id: string) => mediaPaths(c.projectService.mediaFile(id, ["x"])!.replace(/\/x$/, ""));

async function size(file: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) =>
    execFile(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", file], (err, out) => (err ? reject(err) : resolve(out.trim()))));
}

describe("YouTube upload info at the end of a video", () => {
  it("writes the title, description, tags and a 1280×720 thumbnail when the video is finished", async () => {
    const mock = mockProvider();
    c = await makeTestContainer({ provider: () => mock });
    const ch = (await c.channelService.create({ input: { name: "Milcah's World" }, provider: "mock" })).id;
    const p = await c.projectService.create({ topic: "Washing hands", sceneCount: 2, reviewMode: "auto" }, "mock", { channelId: ch });
    await c.projectService.start(p.id);
    await c.projectService.idle();
    const done = await c.projectService.get(p.id);
    expect(done.status).toBe("done");
    expect(done.publish).toMatchObject({ title: "Washing hands | Kids Song", thumbnailTitle: "Sing along!" });
    expect(done.publish!.tags).toEqual(["kids songs", "nursery rhymes", "Washing hands"]); // de-duplicated
    expect(done.media.thumbnail).toBe("thumbnail.jpg");
    expect(await size(media(p.id).thumbnail)).toBe("1280x720");

    const text = mock.prompts.find((x) => x.prompt.includes("YouTube upload text"))!.prompt;
    expect(text).toContain('on the channel "Milcah\'s World"');
    expect(text).toContain(done.poem!.stanzas[0]!.lines[0]!);
    const thumb = mock.prompts.find((x) => x.kind === "image" && x.prompt.includes("YouTube video thumbnail"))!.prompt;
    expect(thumb).toContain('Add the title "Sing along!"');
  }, 60_000);

  it("can be edited and made again; a missing thumbnail or text never fails the video", async () => {
    const mock = mockProvider();
    const image = mock.image.bind(mock);
    mock.image = async (prompt, opts) => {
      if (prompt.includes("YouTube video thumbnail")) throw new Error("quota exceeded");
      return image(prompt, opts);
    };
    c = await makeTestContainer({ provider: () => mock });
    const p = await c.projectService.create({ topic: "Counting goats", sceneCount: 2, reviewMode: "auto" }, "mock");
    await c.projectService.start(p.id);
    await c.projectService.idle();
    const done = await c.projectService.get(p.id);
    expect([done.status, done.media.thumbnail, done.publish !== null]).toEqual(["done", null, true]);

    // No AI: the first picture as the thumbnail.
    const framed = await c.publishService.generate(p.id, "frame");
    expect(await size(media(p.id).thumbnail)).toBe("1280x720");
    expect(framed.publish).not.toBeNull();

    const edited = await c.publishService.edit(p.id, { title: "  Count   the goats! ", description: "Hi", tags: ["#goats", "goats", "counting"], thumbnailTitle: "1, 2, 3!" });
    expect(edited.publish).toEqual({ title: "Count the goats!", description: "Hi", tags: ["goats", "counting"], thumbnailTitle: "1, 2, 3!" });
    await expect(c.publishService.edit(p.id, { title: "" })).rejects.toBeInstanceOf(ValidationError);
    await expect(c.publishService.generate(p.id, "poster")).rejects.toBeInstanceOf(ValidationError);
    expect((await c.publishService.generate(p.id, "text")).publish!.title).toBe("Counting goats | Kids Song");

    // A new poem: the old title and description no longer fit, so they're cleared.
    await c.projectService.regenerate(p.id, "poem");
    await c.projectService.idle();
    expect((await c.projectService.get(p.id)).publish).toBeNull();
    expect(await probeStreams(media(p.id).sceneImage(0)).catch(() => [])).toBeDefined();
  }, 60_000);

  it("needs the poem and scenes", async () => {
    c = await makeTestContainer();
    const p = await c.projectService.create({ topic: "Brushing teeth", reviewMode: "manual" }, "mock");
    await expect(c.publishService.generate(p.id, "text")).rejects.toBeInstanceOf(ConflictError);
    expect(await fileExists(media(p.id).thumbnail)).toBe(false);
  });
});
