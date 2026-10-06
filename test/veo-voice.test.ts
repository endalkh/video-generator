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
    await expect(c.projectService.changeVisuals(p.id, "still")).rejects.toThrow(/made inside the video clips/);
  }, 60_000);

  it("skip the audio AI with a song and no background music: she sings each scene in the clip, no audio model is used", async () => {
    const { mock, p } = await run({ videoAudio: true, backgroundMusic: false, singer: "boy", videoMode: "still", reviewMode: "manual" });
    // Manual mode: the poem, scenes and character pause for review; the empty audio step doesn't.
    for (const step of ["poem", "scenes", "character"]) {
      expect((await c.projectService.get(p.id)).status).toBe("review");
      await c.projectService.approve(p.id, step);
      await c.projectService.idle();
    }
    const done = await c.projectService.get(p.id);
    expect(done.status).toBe("review"); // the clips
    expect(done.input.videoMode).toBe("veo"); // forced: the sound is made in the clips
    expect(done.completed).toContain("audio");
    expect(mock.prompts.filter((x) => ["song", "speech"].includes(x.kind))).toHaveLength(0);
    const veo = mock.prompts.filter((x) => x.kind === "video");
    const first = veo.find((x) => x.prompt.includes(done.scenes!.scenes[0]!.text))!;
    expect(first.prompt).toContain("She sings to the camera in English, in the voice of a cheerful little boy");
    expect(first.prompt).toContain("No captions, no text.");
    expect(first.prompt).not.toContain("No speech");
    expect(mock.prompts.find((x) => x.kind === "poem")!.prompt).toContain("The main character sings each stanza herself");
    await c.projectService.approve(p.id, "clips");
    await c.projectService.idle();
    const m = media(p.id);
    expect((await c.projectService.get(p.id)).status).toBe("done");
    expect(await fileExists(m.music("wav"))).toBe(false); // not even background music
    expect(await probeDuration(m.final)).toBeCloseTo(4, 0); // 2 clips × the mock's 2 s clip
  }, 60_000);

  it("skip the audio AI with narration: she says the words herself, over soft background music (on by default)", async () => {
    const { mock, p } = await run({ videoAudio: true, audioMode: "narration" });
    expect([p.status, p.error]).toEqual(["done", null]);
    const video = mock.prompts.find((x) => x.kind === "video")!.prompt;
    expect(video).toContain("saying exactly these words");
    expect(video).not.toContain("she does not talk");
    expect(mock.prompts.filter((x) => x.kind === "speech")).toHaveLength(0);
    expect(mock.prompts.filter((x) => x.kind === "song").map((x) => x.prompt)).toEqual([expect.stringContaining("Instrumental only")]);
    const m = media(p.id);
    expect(await fileExists(m.music("wav"))).toBe(true);
    expect(await probeStreams(m.final)).toEqual(["video", "audio"]);
  }, 60_000);

  it("sound in the clips: \"Make the clips\" doesn't wait for the audio step, and failed background music never blocks it", async () => {
    const mock = mockProvider();
    mock.song = async () => {
      throw Object.assign(new Error("Your project has exceeded its monthly spending cap."), { status: 429 });
    };
    c = await makeTestContainer({ provider: () => mock });
    const created = await c.projectService.create({ topic: "Sun hats", sceneCount: 2, reviewMode: "manual", videoAudio: true }, "mock");
    for (const step of ["poem", "scenes", "character"]) {
      await c.projectService.generateStep(created.id, step);
      await c.projectService.idle();
    }
    // The audio step was never made: the clips can still be asked for.
    await c.projectService.generateStep(created.id, "clips");
    await c.projectService.idle();
    const p = await c.projectService.get(created.id);
    expect([p.status, p.error]).not.toContain("failed");
    expect(p.error).toBeNull();
    expect(p.completed).toEqual(expect.arrayContaining(["audio", "clips"]));
    expect(p.awaitingReview).not.toBe("audio");
    expect(await fileExists(media(p.id).music("wav"))).toBe(false); // no music this time; remaking the Audio tries again
    // Approving the videos goes straight on to the final video: the optional music isn't retried or reviewed again.
    await c.projectService.approveVideos(p.id);
    await c.projectService.idle();
    const after = await c.projectService.get(p.id);
    expect([after.status, after.awaitingReview, after.error]).toEqual(["done", null, null]);
    expect(after.media.music).toBeNull();
  }, 60_000);

  it("skip scene pictures: no image AI per scene, the video model gets the character, the thumbnail is a video frame", async () => {
    const mock = mockProvider();
    const stills: (Buffer | undefined)[] = [];
    const video = mock.video.bind(mock);
    mock.video = async (prompt, opts) => {
      stills.push(opts.still);
      return video(prompt, opts);
    };
    c = await makeTestContainer({ provider: () => mock });
    const created = await c.projectService.create({ topic: "Washing hands", sceneCount: 2, reviewMode: "auto", scenePictures: false, videoMode: "still" }, "mock");
    await c.projectService.start(created.id);
    await c.projectService.idle();
    const p = await c.projectService.get(created.id);
    expect([p.status, p.error, p.input.videoMode]).toEqual(["done", null, "veo"]);
    expect(stills).toEqual([undefined, undefined]);
    expect(mock.prompts.filter((x) => x.kind === "image").map((x) => x.prompt).some((t) => /scene/i.test(t) && !/character|thumbnail/i.test(t))).toBe(false);
    const m = media(p.id);
    expect([await fileExists(m.sceneImage(0)), await fileExists(m.sceneImage(1))]).toEqual([false, false]);
    expect(p.media.thumbnail).toBe("thumbnail.jpg");
    await expect(c.projectService.changeVisuals(p.id, "still")).rejects.toThrow(/no scene pictures/);
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
    await expect(c.projectService.scenePiece(p.id, 0)).rejects.toThrow(/made inside each video clip/);
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
