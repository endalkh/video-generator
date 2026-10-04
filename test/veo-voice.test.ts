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
    // Videos are made 2 at a time, so find scene 1's prompt by its words rather than its position.
    const first = veo.find((x) => x.prompt.includes(p.scenes!.scenes[0]!.text))!;
    expect(first.prompt).toContain(`she is singing along to it, singing these words: "${p.scenes!.scenes[0]!.text}"`);
    expect(first.prompt).toContain("No speech, no captions");
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
    const second = veo.find((x) => x.prompt.includes(p.scenes!.scenes[1]!.text))!;
    expect(second.prompt).toContain(`saying exactly these words, slowly and clearly, with her lips in sync: "${p.scenes!.scenes[1]!.text}"`);
    expect(second.prompt).toContain("in the voice of a cheerful little girl");
    expect(second.prompt).not.toContain("No speech");
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

describe("uploading a scene's video by hand", () => {
  it("uses the file instead of generating it, and re-makes only the clips", async () => {
    const { mock, p } = await run({ videoMode: "veo" });
    expect(p.status).toBe("done");
    const dir = await mkdtemp(path.join(os.tmpdir(), "up-"));
    try {
      await runFfmpeg(["-f", "lavfi", "-i", "testsrc=s=320x180:d=3:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "mine.mp4")]);
      const { readFile } = await import("node:fs/promises");
      const dataUrl = `data:video/mp4;base64,${(await readFile(path.join(dir, "mine.mp4"))).toString("base64")}`;
      const before = mock.prompts.filter((x) => x.kind === "video").length;

      const up = await c.projectService.uploadSceneVideo(p.id, 1, { video: dataUrl });
      expect(up.completed).not.toContain("clips");
      expect(await probeDuration(media(p.id).sceneVideo(1))).toBeCloseTo(3, 0);
      expect(await fileExists(media(p.id).sceneClip(1))).toBe(false);

      await c.projectService.start(p.id);
      await c.projectService.idle();
      expect((await c.projectService.get(p.id)).status).toBe("done");
      expect(mock.prompts.filter((x) => x.kind === "video").length).toBe(before); // nothing re-generated
      await expect(c.projectService.uploadSceneVideo(p.id, 5, { video: dataUrl })).rejects.toThrow(/No scene 6/);
      await expect(c.projectService.uploadSceneVideo(p.id, 0, { video: "data:video/mp4;base64,AAAA" })).rejects.toThrow(/empty/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("each scene's own audio", () => {
  it("song: cut from the song along the scene timings; narration: the voice plus the clip's tail", async () => {
    const song = await run({ videoMode: "veo" });
    expect(song.p.status).toBe("done");
    // The pieces follow the scene timings, so together they are the whole song, and each matches its clip.
    const pieces = await Promise.all(song.p.scenes!.scenes.map((s) => probeDuration(media(song.p.id).scenePiece(s.index))));
    expect(pieces.reduce((a, b) => a + b, 0)).toBeCloseTo(song.p.song!.duration, 0);
    for (const [i, d] of pieces.entries()) expect(Math.abs(d - (await probeDuration(media(song.p.id).sceneClip(i))))).toBeLessThan(0.1);
    const dto = await c.projectService.get(song.p.id);
    expect(dto.media.scenes[0]!.piece).toBe("scenes/01/scene-audio.mp3");
    expect(await c.projectService.scenePiece(song.p.id, 1)).toEqual({ file: "scenes/02/scene-audio.mp3" });
    await expect(c.projectService.scenePiece(song.p.id, 9)).rejects.toThrow(/No scene 10/);
    await c.cleanup();

    const story = await run({ videoMode: "still", audioMode: "narration" });
    const m = media(story.p.id);
    expect(await probeDuration(m.scenePiece(0))).toBeCloseTo((await probeDuration(m.sceneAudio(0))) + 0.5, 1);
  });

  it("the character-speaks mode has no separate scene audio", async () => {
    const { p } = await run({ audioMode: "character" });
    expect(await fileExists(media(p.id).scenePiece(0))).toBe(false);
    await expect(c.projectService.scenePiece(p.id, 0)).rejects.toThrow(/character speaks/);
  });
});

describe("approving uploaded videos", () => {
  it("needs a video for every scene, then makes the final video without generating anything", async () => {
    const mock = mockProvider();
    c = await makeTestContainer({ provider: () => mock });
    const ps = c.projectService;
    const { id } = await ps.create({ topic: "Butterfly colours", sceneCount: 3, reviewMode: "manual", videoMode: "veo" }, "mock");
    for (const s of ["poem", "scenes", "character", "audio"]) { await ps.generateStep(id, s); await ps.idle(); }

    const dir = await mkdtemp(path.join(os.tmpdir(), "up-"));
    try {
      await runFfmpeg(["-f", "lavfi", "-i", "testsrc=s=320x180:d=3:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "v.mp4")]);
      const { readFile } = await import("node:fs/promises");
      const video = `data:video/mp4;base64,${(await readFile(path.join(dir, "v.mp4"))).toString("base64")}`;
      await ps.uploadSceneVideo(id, 0, { video });

      await expect(ps.approveVideos(id)).rejects.toThrow(/^Scenes 2 and 3 have no video yet/);
      await ps.uploadSceneVideo(id, 1, { video });
      await expect(ps.approveVideos(id)).rejects.toThrow(/^Scene 3 has no video yet/);
      await ps.uploadSceneVideo(id, 2, { video });

      const sceneMedia = () => c.generations.items.filter((g) => g.promptKey === "scene_video" || g.promptKey === "scene_image").length;
      const paid = sceneMedia();
      await ps.approveVideos(id);
      await ps.idle();
      const p = await ps.get(id);
      expect([p.status, p.error, p.media.final]).toEqual(["done", null, "final.mp4"]);
      expect(p.completed).toContain("clips");
      expect(sceneMedia()).toBe(paid); // no scene video or picture was generated (only the usual YouTube thumbnail)
      expect(mock.prompts.filter((x) => x.kind === "video")).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
