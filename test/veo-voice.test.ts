import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeDuration, probeStreams, runFfmpeg, videoToClip } from "../src/infrastructure/media/ffmpeg.js";
import { mediaPaths } from "../src/services/pipeline.service.js";
import { fileExists } from "../src/util/fs.js";
import { makeTestContainer, mockProvider } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());
const media = (id: string) => mediaPaths(c.projectService.mediaFile(id, ["x"])!.replace(/\/x$/, ""));

async function run(input: Record<string, unknown>) {
  const mock = mockProvider();
  c = await makeTestContainer({ provider: () => mock });
  const p = await c.projectService.create({ topic: "Washing hands", sceneCount: 2, reviewMode: "auto", ...input }, "mock");
  await c.projectService.start(p.id);
  await c.projectService.idle();
  return { mock, p: await c.projectService.get(p.id) };
}

describe("the video matches the audio", () => {
  it("song: she sings along to the words of each scene", async () => {
    const { mock, p } = await run({ videoMode: "veo" });
    expect(p.status).toBe("done");
    const veo = mock.prompts.filter((x) => x.kind === "video");
    expect(veo).toHaveLength(2);
    expect(veo[0]!.prompt).toContain(`she is singing along to it, singing these words: "${p.scenes!.scenes[0]!.text}"`);
    expect(veo[0]!.prompt).toContain("No speech, no captions");
  }, 60_000);

  it("narration: a storyteller reads, she acts it out without talking", async () => {
    const { mock, p } = await run({ videoMode: "veo", audioMode: "narration" });
    expect(p.status).toBe("done");
    expect(mock.prompts.find((x) => x.kind === "video")!.prompt).toContain("she does not talk");
    expect(mock.prompts.filter((x) => x.kind === "speech")).toHaveLength(2); // the narrator
  }, 60_000);

  it("the character speaks: Veo makes her say the words, with soft background music; needs Veo", async () => {
    const { mock, p } = await run({ audioMode: "character", singer: "girl", videoMode: "still" });
    expect([p.status, p.error]).toEqual(["done", null]);
    expect(p.input.videoMode).toBe("veo"); // forced
    const veo = mock.prompts.filter((x) => x.kind === "video");
    expect(veo[1]!.prompt).toContain(`saying exactly these words, slowly and clearly, with her lips in sync: "${p.scenes!.scenes[1]!.text}"`);
    expect(veo[1]!.prompt).toContain("in the voice of a cheerful little girl");
    expect(veo[1]!.prompt).not.toContain("No speech");
    expect(mock.prompts.filter((x) => x.kind === "speech")).toHaveLength(0); // no separate narrator
    expect(mock.prompts.find((x) => x.kind === "song")!.prompt).toContain("Instrumental only");
    expect(mock.prompts.find((x) => x.kind === "poem")!.prompt).toContain("The main character says each stanza herself");
    const m = media(p.id);
    expect(p.song).toBeNull();
    expect(await fileExists(m.music("wav"))).toBe(true);
    expect(await probeStreams(m.final)).toEqual(["video", "audio"]);
    expect(await probeDuration(m.final)).toBeCloseTo(4, 0); // 2 clips × the mock's 2 s Veo clip
    // Changing a scene's words makes a new clip (her voice is in it).
    await c.projectService.editScenes(p.id, { scenes: p.scenes!.scenes.map((s, i) => (i === 0 ? { ...s, text: "New words" } : s)) });
    expect([await fileExists(m.sceneVideo(0)), await fileExists(m.sceneVideo(1))]).toEqual([false, true]);
    await expect(c.projectService.changeVisuals(p.id, "still")).rejects.toThrow(/only speak in Veo/);
  }, 60_000);
});

describe("fitting an animation to its scene", () => {
  it("plays a slightly short animation a bit slower instead of restarting it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kids-studio-fit-"));
    try {
      await runFfmpeg(["-f", "lavfi", "-i", "testsrc=s=320x180:d=8:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "veo.mp4")]);
      const fmt = { width: 320, height: 180, fps: 25 };
      expect(await videoToClip({ duration: 10, video: path.join(dir, "veo.mp4"), out: path.join(dir, "a.mp4"), fmt })).toBe(10);
      expect(await probeDuration(path.join(dir, "a.mp4"))).toBeCloseTo(10, 0);
      expect(await videoToClip({ duration: 20, video: path.join(dir, "veo.mp4"), out: path.join(dir, "b.mp4"), fmt })).toBe(20); // too long: loops
      expect(await probeDuration(path.join(dir, "b.mp4"))).toBeCloseTo(20, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
