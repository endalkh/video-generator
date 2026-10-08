import { describe, expect, it } from "vitest";
import { lengthRange, songStylePrompt, TrebloMusic } from "../src/infrastructure/providers/treblo.js";
import { capabilityOf, ModelSetting } from "../src/domain/model-setting/model-setting.entity.js";
import { ProjectInputSchema } from "../src/domain/project/project.model.js";
import { songParts } from "../src/domain/ports/generator.port.js";

const input = ProjectInputSchema.parse({ topic: "Swimming at the beach", language: "am", singer: "girl", sceneCount: 2 });
const ctx = { input, poem: { title: "Beach Day", stanzas: [] } } as never;

/** A fake Treblo API: records requests and answers from a script. */
function fakeFetch(statuses: string[], song = Buffer.alloc(4000, 1)) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (u.endsWith("/generations/v3")) return json({ task_id: "t1" });
    if (u.includes("/generations/status/t1")) return json(statuses.shift() ?? "SUCCESS");
    if (u.endsWith("/generations/t1")) return json({ song_paths: ["https://cdn.treblo.com/song.mp3"], lyrics: "la la" });
    if (u === "https://cdn.treblo.com/song.mp3") return new Response(new Uint8Array(song));
    return json({ detail: "not found" }, 404);
  }) as typeof fetch;
  return { impl, calls };
}

describe("Treblo (Sonauto) music", () => {
  it("is a music model and a valid Song setting", () => {
    expect(capabilityOf("treblo/v3")).toBe("music");
    const s = ModelSetting.default("song");
    s.change("treblo/v3");
    expect(s.model).toBe("treblo/v3");
    expect(() => ModelSetting.default("poem").change("treblo/v3")).toThrow(/needs a text model/);
  });

  it("asks for a length window in multiples of 30 s", () => {
    expect([lengthRange(180), lengthRange(30), lengthRange(270), lengthRange(10)]).toEqual([[150, 210], [0, 60], [240, 300], [0, 30]]);
  });

  it("sends the lyrics and a style prompt for songs, and instrumental for music beds", () => {
    const song = TrebloMusic.body("ignored Lyria prompt", { model: "treblo/v3", label: "song", durationSec: 180, ctx, lyrics: "  verse one\n\nverse two " });
    expect(song).toMatchObject({ lyrics: "verse one\n\nverse two", output_format: "mp3", length_range: [150, 210] });
    expect(song.prompt).toBe(songStylePrompt(ctx));
    expect(song.prompt).toMatch(/sung in Amharic by a little girl about 4 years old.*not an adult woman.*"Beach Day".*Swimming at the beach/);
    // Never tags + lyrics + prompt together: Treblo answers 422 "cannot provide all three tags, lyrics, and prompt".
    expect(song.tags).toBeUndefined();
    expect(song.negative_tags).toEqual(["opera", "aggressive", "heavy", "male vocalist", "soul", "r&b"]);
    expect(song.instrumental).toBeUndefined();
    const bed = TrebloMusic.body("soft ukulele music", { model: "treblo/v3", label: "music", durationSec: 60, ctx, instrumental: true, lyrics: "x" });
    expect(bed).toMatchObject({ prompt: "soft ukulele music", instrumental: true });
    expect(bed.lyrics).toBeUndefined();
  });

  it("starts a song, polls until done and downloads it without sending the key to the CDN", async () => {
    const { impl, calls } = fakeFetch(["GENERATING", "SAVING", "SUCCESS"]);
    const t = new TrebloMusic("k", { fetchImpl: impl, pollMs: 0 });
    const r = await t.song("p", { model: "treblo/v3", label: "song", durationSec: 120, ctx, lyrics: "hi" });
    expect([r.ext, r.audio.length, r.lyrics]).toEqual(["mp3", 4000, "la la"]);
    expect(calls.filter((c) => c.url.includes("/status/")).length).toBe(3);
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer k");
    expect(calls.at(-1)!.init).toBeUndefined();
  });

  it("explains a failed generation and a missing key", async () => {
    const { impl } = fakeFetch(["FAILURE"]);
    await expect(new TrebloMusic("k", { fetchImpl: impl, pollMs: 0 }).song("p", { model: "treblo/v3", label: "song", durationSec: 60, ctx, lyrics: "hi" })).rejects.toThrow(/couldn't make the song \(task t1\)/);
    const saved = process.env.TREBLO_API_KEY;
    delete process.env.TREBLO_API_KEY;
    try {
      expect(() => new TrebloMusic()).toThrow(/TREBLO_API_KEY is not set/);
    } finally {
      if (saved !== undefined) process.env.TREBLO_API_KEY = saved;
    }
  });

  it("makes a 4-minute song in one part (Lyria needs two)", () => {
    const scenes = Array.from({ length: 24 }, () => ({ text: "a short line to sing" }));
    expect(songParts(scenes, 240, { maxPart: 270 }).length).toBe(1);
    expect(songParts(scenes, 240).length).toBe(2);
  });
});

describe("Skip scene pictures", () => {
  it("knows which video models can make a scene from the character alone", async () => {
    const { needsScenePicture } = await import("../src/infrastructure/providers/gemini.js");
    expect(["veo-3.1-lite-generate-preview", "veo-3.0-generate-001", "inference.sh/pixverse/v6", "inference.sh/pruna/p-video", "inference.sh/unknown/app"].map(needsScenePicture)).toEqual([true, true, true, true, true]);
    expect(["veo-3.1-fast-generate-preview", "veo-3.1-generate-preview", "inference.sh/bytedance/seedance-2-5", "inference.sh/alibaba/wan-2-7-i2v", "inference.sh/xai/grok-imagine-video-1-5"].map(needsScenePicture)).toEqual([false, false, false, false, false]);
  });
});

describe("step review and per-scene pictures", () => {
  it("Approve only approves; a scene's picture can be switched off on its own", async () => {
    const { makeTestContainer } = await import("./helpers.js");
    const c = await makeTestContainer();
    const ps = c.projectService;
    const created = await ps.create({ topic: "sand castles", sceneCount: 2, reviewMode: "manual", videoMode: "veo" }, "mock");
    await ps.start(created.id);
    await ps.idle();
    const approved = await ps.approve(created.id, "poem");
    await ps.idle();
    expect([approved.completed, approved.status, (await ps.get(created.id)).completed]).toEqual([["poem"], "paused", ["poem"]]);
    await ps.generateStep(created.id, "scenes");
    await ps.idle();
    const off = await ps.setScenePicture(created.id, 1, false);
    expect(off.scenes!.scenes.map((s) => s.picture)).toEqual([undefined, false]);
    await expect(ps.setScenePicture(created.id, 5, false)).rejects.toThrow(/No scene 6/);
  }, 60_000);
});
