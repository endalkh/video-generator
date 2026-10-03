import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "../src/domain/errors.js";
import { defaultVoice } from "../src/domain/project/project.model.js";
import { probeDuration, probeStreams, runFfmpeg } from "../src/infrastructure/media/ffmpeg.js";
import { MockProvider } from "../src/infrastructure/providers/mock.js";
import { mediaPaths } from "../src/services/pipeline.service.js";
import { fileExists } from "../src/util/fs.js";
import { makeTestContainer, mockProvider } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());

const media = (id: string) => mediaPaths(c.projectService.mediaFile(id, ["x"])!.replace(/\/x$/, ""));

/** A mock that records the voice each speech request used. */
function voiceRecordingMock() {
  const mock = mockProvider();
  const voices: string[] = [];
  const speech = mock.speech.bind(mock);
  mock.speech = async (prompt, opts) => (voices.push((opts as unknown as { voice: string }).voice), speech(prompt, opts));
  return { mock, voices };
}

describe("rhyme over music (voice over instrumental music)", () => {
  it("chants each scene with the voice model over looped instrumental music", async () => {
    const { mock, voices } = voiceRecordingMock();
    c = await makeTestContainer({ provider: () => mock });
    const p = await c.projectService.create({ topic: "እጅ መታጠብ", language: "am", audioMode: "music_voice", singer: "girl", sceneCount: 3, reviewMode: "auto" }, "mock");
    await c.projectService.start(p.id);
    await c.projectService.idle();
    const done = await c.projectService.get(p.id);
    expect([done.status, done.error]).toEqual(["done", null]);
    expect(done.song).toMatchObject({ file: "song.wav", source: "music_voice" });

    // 3 voice clips (1 s each in the mock) + intro/pauses/outro; one music request, no vocals asked for.
    const speech = mock.prompts.filter((x) => x.kind === "speech");
    expect(speech).toHaveLength(3);
    expect(speech[0]!.prompt).toContain("nursery rhyme with a steady, bouncy beat");
    expect(speech[0]!.prompt).toContain("in the voice of a cheerful little girl");
    expect(speech[0]!.prompt).toContain("native Ethiopian Amharic pronunciation");
    expect(voices).toEqual(["Leda", "Leda", "Leda"]);
    const music = mock.prompts.filter((x) => x.kind === "song");
    expect(music).toHaveLength(1);
    expect(music[0]!.prompt).toContain("Instrumental only: no vocals");

    const m = media(p.id);
    const total = 2 + 3 * (1 + 0.6) + 2.5;
    expect(await probeDuration(m.song("wav"))).toBeCloseTo(total, 0);
    expect(await probeDuration(m.final)).toBeCloseTo(total, 0);
    expect(await fileExists(m.music("wav"))).toBe(true);
  }, 60_000);
});

describe("singer / voice", () => {
  it("describes the singer to the music model and picks a matching speech voice", async () => {
    const { mock, voices } = voiceRecordingMock();
    c = await makeTestContainer({ provider: () => mock });
    const song = await c.projectService.create({ topic: "Counting stars", singer: "kids", sceneCount: 2, reviewMode: "auto" }, "mock");
    await c.projectService.start(song.id);
    await c.projectService.idle();
    expect(mock.prompts.find((x) => x.kind === "song")!.prompt).toContain("a small, joyful children's choir singing together in unison singing slowly");

    const story = await c.projectService.create({ topic: "A goat finds a friend", audioMode: "narration", singer: "man", voice: "Puck", sceneCount: 2, reviewMode: "auto" }, "mock");
    await c.projectService.start(story.id);
    await c.projectService.idle();
    expect(voices.slice(-2)).toEqual(["Puck", "Puck"]); // the exact voice wins
    expect(mock.prompts.filter((x) => x.kind === "speech").at(-1)!.prompt).toContain("in the voice of a warm, friendly young man");
    expect([defaultVoice("man", "narration"), defaultVoice("auto", "narration"), defaultVoice("girl", "music_voice")]).toEqual(["Achird", "Kore", "Leda"]);
    await expect(c.projectService.create({ topic: "abc", voice: "Nobody" }, "mock")).rejects.toBeInstanceOf(ValidationError);

    // Changing the singer later only redoes the audio.
    const r = await c.projectService.changeSettings(story.id, { singer: "girl", voice: null });
    expect([r.redoFrom, r.project.completed]).toEqual(["audio", ["poem", "scenes", "character"]]);
  }, 60_000);
});

describe("extra wishes for the audio", () => {
  it("adds the wish to the song, music and voice prompts and remembers it; empty removes it", async () => {
    const { mock } = voiceRecordingMock();
    c = await makeTestContainer({ provider: () => mock });
    const p = await c.projectService.create({ topic: "Counting goats", sceneCount: 2, reviewMode: "manual" }, "mock");
    for (const s of ["poem", "scenes", "character"] as const) {
      await c.projectService.generateStep(p.id, s);
      await c.projectService.idle();
    }
    await c.projectService.generateStep(p.id, "audio", { audioRequest: "slower and happier, more krar" });
    await c.projectService.idle();
    expect(mock.prompts.filter((x) => x.kind === "song").at(-1)!.prompt).toContain("Extra wishes from the parent (follow them unless they break the rules above): slower and happier, more krar");
    expect((await c.projectService.get(p.id)).input.audioRequest).toBe("slower and happier, more krar");

    // Rhyme over music: the wish reaches the voice (inside the instruction, before the words) and the music.
    await c.projectService.changeSettings(p.id, { audioMode: "music_voice" });
    for (const s of ["poem", "scenes", "character", "audio"] as const) {
      await c.projectService.generateStep(p.id, s);
      await c.projectService.idle();
    }
    expect(mock.prompts.filter((x) => x.kind === "speech").at(-1)!.prompt).toMatch(/, and: slower and happier, more krar:\n\n/);
    expect(mock.prompts.filter((x) => x.kind === "song").at(-1)!.prompt).toContain("Instrumental only");
    expect(mock.prompts.filter((x) => x.kind === "song").at(-1)!.prompt).toContain("more krar");

    await c.projectService.generateStep(p.id, "audio", { audioRequest: "" });
    await c.projectService.idle();
    expect((await c.projectService.get(p.id)).input.audioRequest).toBeUndefined();
    expect(mock.prompts.filter((x) => x.kind === "song").at(-1)!.prompt).not.toContain("Extra wishes");
    await expect(c.projectService.generateStep(p.id, "audio", { audioRequest: "x".repeat(501) })).rejects.toBeInstanceOf(ValidationError);
  }, 60_000);
});

describe("your own recording", () => {
  it("uses an uploaded recording as the audio and times the clips to it", async () => {
    c = await makeTestContainer();
    const p = await c.projectService.create({ topic: "Brushing teeth", sceneCount: 2, reviewMode: "manual" }, "mock");
    const dir = await mkdtemp(path.join(os.tmpdir(), "kids-studio-rec-"));
    await runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=7", "-c:a", "libmp3lame", "-q:a", "6", path.join(dir, "rec.mp3")]).catch(() =>
      runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=7", path.join(dir, "rec.mp3").replace(/mp3$/, "wav")]));
    const file = (await fileExists(path.join(dir, "rec.mp3"))) ? path.join(dir, "rec.mp3") : path.join(dir, "rec.wav");
    const audio = `data:audio/${file.endsWith("mp3") ? "mpeg" : "wav"};base64,${(await readFile(file)).toString("base64")}`;
    await rm(dir, { recursive: true, force: true });

    await expect(c.projectService.uploadAudio(p.id, { audio })).rejects.toBeInstanceOf(ConflictError); // no character yet
    for (const s of ["poem", "scenes", "character"] as const) {
      await c.projectService.generateStep(p.id, s);
      await c.projectService.idle();
    }
    await expect(c.projectService.uploadAudio(p.id, { audio: "data:text/plain;base64,aGk=" })).rejects.toBeInstanceOf(ValidationError);
    const up = await c.projectService.uploadAudio(p.id, { audio });
    expect(up.song).toMatchObject({ file: "song.wav", source: "upload" });
    expect(up.song!.duration).toBeCloseTo(7, 0);
    expect(up.completed).toContain("audio");

    // Continue: clips + final are made with the recording; no AI audio is generated.
    await c.projectService.approve(p.id, "audio");
    await c.projectService.idle();
    const mid = await c.projectService.get(p.id);
    expect([mid.status, mid.error, mid.completed]).toEqual(["review", null, ["poem", "scenes", "character", "audio", "clips"]]);
    await c.projectService.approve(p.id, "clips");
    await c.projectService.idle();
    const done = await c.projectService.get(p.id);
    expect(done.status).toBe("done");
    expect(await probeDuration(media(p.id).final)).toBeCloseTo(7, 0);
    expect(await probeStreams(media(p.id).final)).toEqual(["video", "audio"]);
  }, 60_000);
});

describe("channel audio defaults", () => {
  it("planned songs use the channel's rhyme-over-music mode, singer and voice", async () => {
    c = await makeTestContainer({ provider: () => new MockProvider({ audioSecondsPerScene: 1, songLengthSec: 4, imageSize: [320, 180] }) });
    const ch = (await c.channelService.create({ input: { name: "Milcah's World", audioMode: "music_voice", singer: "girl", voice: "Zephyr" }, provider: "mock" })).id;
    const month = `${new Date().getFullYear() + 1}-07`;
    const plan = await c.planService.generate(ch, month, { about: "Kids songs", postDays: [6], language: "am" }, { provider: "mock" });
    const songIdea = plan.ideas.findIndex((i) => i.audioMode === "song");
    const { projectId } = await c.planService.makeVideo(ch, month, songIdea, { provider: "mock" });
    c.projectService.cancel(projectId);
    await c.projectService.idle();
    expect((await c.projectService.get(projectId)).input).toMatchObject({ audioMode: "music_voice", singer: "girl", voice: "Zephyr" });
  }, 60_000);
});
