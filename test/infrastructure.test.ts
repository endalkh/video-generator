import { describe, expect, it } from "vitest";
import { buildSrt, zoompanFilter } from "../src/infrastructure/media/ffmpeg.js";
import { encodePng } from "../src/infrastructure/media/png.js";
import { pcmToWav, toneWav, wavDurationSeconds } from "../src/infrastructure/media/wav.js";
import { srtToVtt } from "../src/api/routes/projects.routes.js";
import { mapLimit, videoConcurrency } from "../src/services/pipeline.service.js";
import { GeminiProvider, maxVeoResolution, supportsImageSize, supportsReferenceImages } from "../src/infrastructure/providers/gemini.js";
import { formatFor } from "../src/infrastructure/media/ffmpeg.js";
import { minResolution, videoResolution } from "../src/domain/project/project.model.js";
import { InferenceShVideo, isAudioDrivenModel } from "../src/infrastructure/providers/inference-sh.js";
import { capabilityOf } from "../src/domain/model-setting/model-setting.entity.js";
import { slugify } from "../src/util/fs.js";
import { isTransientError, retryHintMs, withRetry } from "../src/util/retry.js";

describe("slugify", () => {
  it("makes ascii slugs", () => expect(slugify("Washing Hands, Before Eating!")).toBe("washing-hands-before-eating"));
  it("is stable for Amharic", () => {
    const a = slugify("እጅ መታጠብ");
    expect(a).toMatch(/^project-[a-z0-9]+$/);
    expect(slugify("እጅ መታጠብ")).toBe(a);
  });
});

describe("media helpers", () => {
  it("wav round-trips duration", () => {
    expect(wavDurationSeconds(pcmToWav(Buffer.alloc(48_000)))).toBeCloseTo(1, 5);
    expect(wavDurationSeconds(toneWav(2.5))).toBeCloseTo(2.5, 3);
    expect(() => wavDurationSeconds(Buffer.from("hello world!"))).toThrow();
  });
  it("png has a valid signature + IHDR", () => {
    const png = encodePng(3, 2, () => [255, 0, 0]);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([3, 2]);
  });
  it("builds SRT and WebVTT", () => {
    const srt = buildSrt([{ text: "one", duration: 2 }, { text: "two", duration: 3.5 }]);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,750\none");
    expect(srt).toContain("2\n00:00:02,000 --> 00:00:05,250\ntwo");
    expect(srtToVtt("1\n00:00:01,500 --> 00:00:02,000\nhi\n")).toBe("WEBVTT\n\n1\n00:00:01.500 --> 00:00:02.000\nhi\n");
  });
  it("zoompan targets output size and fps", () => {
    const f = zoompanFilter("zoom-in", 50, { width: 1280, height: 720, fps: 25 });
    expect(f).toContain("s=1280x720");
    expect(f).toContain("d=50");
  });
});

describe("retry", () => {
  it("classifies errors", () => {
    expect(isTransientError({ status: 429 })).toBe(true);
    // Ordinary rate limits retry; a monthly spending cap doesn't (waiting won't fix it).
    expect(isTransientError({ status: 429, message: "You exceeded your current quota, please check your plan and billing details." })).toBe(true);
    expect(isTransientError({ status: 429, message: "Your project has exceeded its monthly spending cap. Please go to AI Studio" })).toBe(false);
    expect(isTransientError({ status: 429, message: "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-omni-1.1-flash" })).toBe(false);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError(new Error("API key not valid"))).toBe(false);
  });
  it("runs \"free/<model>\" on the free-tier key and everything else on the paid key", () => {
    const before = process.env.GEMINI_TEXT_API_KEY;
    try {
      delete process.env.GEMINI_TEXT_API_KEY;
      const paidOnly = new GeminiProvider("paid") as unknown as { client(m: string): { model: string } };
      expect(paidOnly.client("gemini-3.8-flash").model).toBe("gemini-3.8-flash");
      expect(() => paidOnly.client("free/gemini-3.8-flash")).toThrow(/GEMINI_TEXT_API_KEY is not set/);
      process.env.GEMINI_TEXT_API_KEY = "free";
      const both = new GeminiProvider("paid") as unknown as { client(m: string): { ai: unknown; model: string }; ai: unknown; freeAi: unknown };
      expect([both.client("free/gemini-3.8-flash").model, both.client("free/gemini-3.8-flash").ai === both.freeAi, both.client("gemini-3.8-flash").ai === both.ai]).toEqual(["gemini-3.8-flash", true, true]);
    } finally {
      if (before === undefined) delete process.env.GEMINI_TEXT_API_KEY;
      else process.env.GEMINI_TEXT_API_KEY = before;
    }
  });
  it("never retries a spending cap, even when the caller retries everything (text models)", async () => {
    let n = 0;
    const cap = Object.assign(new Error("Your project has exceeded its monthly spending cap."), { status: 429 });
    await expect(withRetry(async () => { n++; throw cap; }, { shouldRetry: () => true, sleep: async () => {} })).rejects.toBe(cap);
    expect(n).toBe(1);
  });
  it("retries transient failures, fails fast on client errors", async () => {
    let n = 0;
    const out = await withRetry(async () => {
      if (n++ < 2) throw Object.assign(new Error("busy"), { status: 503 });
      return "ok";
    }, { sleep: async () => {} });
    expect([out, n]).toEqual(["ok", 3]);
    let m = 0;
    await expect(withRetry(async () => { m++; throw Object.assign(new Error("bad"), { status: 400 }); }, { sleep: async () => {} })).rejects.toThrow("bad");
    expect(m).toBe(1);
  });
});

describe("mapLimit", () => {
  it("preserves order and bounds concurrency", async () => {
    let active = 0, peak = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (x) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, x));
      active--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 30, 20]);
    expect(peak).toBe(2);
  });
  it("on a failure starts nothing new but lets running items finish, then throws", async () => {
    const finished: number[] = [];
    const started: number[] = [];
    await expect(mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
      started.push(x);
      if (x === 1) throw new Error("scene 1 failed");
      await new Promise((r) => setTimeout(r, 20));
      finished.push(x);
    })).rejects.toThrow("scene 1 failed");
    expect(started).toEqual([1, 2]); // 3..5 never started
    expect(finished).toEqual([2]); // 2 was already running and still finished
  });
});

describe("videoConcurrency", () => {
  it("runs inference.sh tasks 4 at a time, Google Veo 2, and VIDEO_CONCURRENCY overrides", () => {
    expect([videoConcurrency("inference.sh/klingai/avatar", ""), videoConcurrency("veo-3.1-fast-generate-preview", "")]).toEqual([4, 2]);
    expect([videoConcurrency("veo-3.1-fast-generate-preview", "6"), videoConcurrency("x", "50"), videoConcurrency("x", "0")]).toEqual([6, 10, 2]);
  });
});

describe("slugify length", () => {
  it("cuts long topics at a word boundary", () => {
    expect(slugify("Washing our hands with soap before we eat lunch")).toBe("washing-our-hands-with-soap-before-we");
  });
});

describe("supportsReferenceImages", () => {
  it("is true for Veo 3.1 standard/fast and false for Lite and older models", () => {
    expect(supportsReferenceImages("veo-3.1-generate-preview")).toBe(true);
    expect(supportsReferenceImages("veo-3.1-fast-generate-preview")).toBe(true);
    expect(supportsReferenceImages("veo-3.1-lite-generate-preview")).toBe(false);
    expect(supportsReferenceImages("veo-3.0-generate-001")).toBe(false);
  });
});

describe("inference.sh Seedance video", () => {
  const MP4 = Buffer.alloc(4096, 7);
  const mime = () => "image/png";
  const still = Buffer.from("still");
  const character = Buffer.from("char");
  const model = "inference.sh/bytedance/seedance-2-5";
  const base = { still, aspectRatio: "16:9", label: "scene 1 video", mime, model };

  it("uses the character sheet + scene picture as references, or the scene picture as first frame", () => {
    const refs = InferenceShVideo.input("dance", { ...base, character });
    expect(refs.app).toBe("bytedance/seedance-2-5");
    expect(refs.input).toMatchObject({ resolution: "720p", ratio: "16:9", duration: 8, generate_audio: true, watermark: false });
    expect(refs.input.task_type).toBeUndefined();
    expect(refs.input.prompt).toMatch(/^@Image1 .*@Image2 .*\n\ndance$/s);
    expect(refs.input.reference_images).toEqual([{ bytes: character, contentType: "image/png" }, { bytes: still, contentType: "image/png" }]);
    expect(refs.input.image).toBeUndefined();

    const first = InferenceShVideo.input("dance", base);
    expect(first.input).toMatchObject({ prompt: "dance", ratio: "adaptive", image: { bytes: still, contentType: "image/png" } });
    expect(first.input.reference_images).toBeUndefined();

    expect(() => InferenceShVideo.input("p", { ...base, model: "inference.sh/google/veo-3-1" })).toThrow(/Unknown inference.sh video app/);
  });

  it("Kling V3 animates the scene picture, as long as the scene (3-15 s), up to real 4K", () => {
    const v3 = InferenceShVideo.input("she twirls", { ...base, model: "inference.sh/klingai/video-v3", character, resolution: "4k", durationSec: 9.84 });
    expect(v3.app).toBe("klingai/video-v3");
    expect(v3.input).toEqual({ image: { bytes: still, contentType: "image/png" }, prompt: "she twirls", sound: true, multi_shot: false, resolution: "4k", aspect_ratio: "16:9", duration: 10 });
    expect(InferenceShVideo.input("x", { ...base, model: "inference.sh/klingai/video-v3", durationSec: 1.2 }).input.duration).toBe(3);
    expect(InferenceShVideo.input("x", { ...base, model: "inference.sh/klingai/video-v3", durationSec: 40 }).input.duration).toBe(15);
    expect(isAudioDrivenModel("inference.sh/klingai/video-v3")).toBe(false);
  });

  it("Kling Avatar animates the scene picture to the scene's own audio (standard or pro)", () => {
    const audio = Buffer.from("mp3");
    const std = InferenceShVideo.input("she sings", { ...base, model: "inference.sh/klingai/avatar", character, audio });
    expect(std.app).toBe("klingai/avatar");
    expect(std.input).toMatchObject({ image: { bytes: still, contentType: "image/png" }, audio: { bytes: audio, contentType: "audio/mpeg" }, mode: "std", aspect_ratio: "16:9" });
    expect(String(std.input.prompt)).toMatch(/she sings$/);
    expect(InferenceShVideo.input("x", { ...base, model: "inference.sh/klingai/avatar-pro", audio }).input.mode).toBe("pro");
    expect(() => InferenceShVideo.input("x", { ...base, model: "inference.sh/klingai/avatar" })).toThrow(/make the audio first/);
    expect([isAudioDrivenModel("inference.sh/klingai/avatar-pro"), isAudioDrivenModel(model)]).toEqual([true, false]);
    expect(new InferenceShVideo("k").listModels().map((m) => m.id).slice(0, 4)).toEqual([model, "inference.sh/klingai/video-v3", "inference.sh/klingai/avatar", "inference.sh/klingai/avatar-pro"]);
  });

  it("lists Seedance 2.0 Fast, Wan 2.7, FLUX 3, MiniMax H3 (+Max), Gemini Omni Flash and Grok Imagine 1.5 as video models", () => {
    const ids = new InferenceShVideo("k").listModels().map((m) => m.id);
    const added = ["bytedance/seedance-2-0-fast", "alibaba/wan-2-7-i2v", "bfl/flux-3-video", "minimax/h3", "falai/minimax-h3-max", "google/gemini-omni-flash", "xai/grok-imagine-video-1-5", "pruna/p-video", "pixverse/v6"].map((a) => `inference.sh/${a}`);
    expect(ids).toEqual(expect.arrayContaining(added));
    for (const id of ids) expect(capabilityOf(id)).toBe("video");
    expect(capabilityOf("inference.sh/xai/grok-imagine-video")).toBeUndefined();
  });

  it("Seedance 2.0 Fast is capped at 720p and gets no output_format", () => {
    const fast = InferenceShVideo.input("hop", { ...base, model: "inference.sh/bytedance/seedance-2-0-fast", resolution: "4k" });
    expect(fast.app).toBe("bytedance/seedance-2-0-fast");
    expect(fast.input).toMatchObject({ resolution: "720p", ratio: "adaptive", duration: 8, image: { bytes: still, contentType: "image/png" } });
    expect(fast.input.output_format).toBeUndefined();
    expect(InferenceShVideo.input("hop", { ...base, resolution: "4k" }).input).toMatchObject({ resolution: "1080p", output_format: "mp4" });
  });

  it("maps the scene picture, quality and scene length to each picture-animating model's inputs", () => {
    const img = { bytes: still, contentType: "image/png" };
    const run = (app: string, extra: Record<string, unknown> = {}) => InferenceShVideo.input("she waves", { ...base, model: `inference.sh/${app}`, character, durationSec: 6.2, ...extra }).input;
    expect(run("alibaba/wan-2-7-i2v", { resolution: "4k" })).toEqual({ prompt: "she waves", first_frame: img, resolution: "1080P", duration: 7, watermark: false });
    expect(run("alibaba/wan-2-7-i2v", { resolution: "720p", durationSec: 30 })).toMatchObject({ resolution: "720P", duration: 15 });
    expect(run("bfl/flux-3-video", { resolution: "1080p", durationSec: 2 })).toEqual({ prompt: "she waves", image: img, resolution: "fhd", duration: 5, aspect_ratio: "auto", generate_audio: true });
    expect(run("minimax/h3", { resolution: "720p", durationSec: 14 })).toEqual({ prompt: "she waves", image: img, resolution: "768P", duration: 10, ratio: "adaptive" });
    expect(run("minimax/h3", { resolution: "1080p" }).resolution).toBe("2K");
    expect(run("falai/minimax-h3-max", { resolution: "4k", durationSec: 14 })).toEqual({ prompt: "she waves", image: img, resolution: "768P", duration: 14, aspect_ratio: "adaptive" });
    expect(run("google/gemini-omni-flash", { aspectRatio: "9:16" })).toEqual({ prompt: "she waves", image: img, aspect_ratio: "9:16" });
    expect(run("xai/grok-imagine-video-1-5", { resolution: "4k" })).toEqual({ prompt: "she waves", image: img, resolution: "1080p", duration: 7, generate_audio: true });
    expect(run("xai/grok-imagine-video-1-5", { durationSec: undefined }).duration).toBe(8);
    expect(run("pruna/p-video", { resolution: "4k", durationSec: 14 })).toEqual({ prompt: "she waves", image: img, resolution: "1080p", duration: 10, save_audio: true, disable_safety_filter: false });
    expect(run("pixverse/v6", { resolution: "720p", durationSec: 2 })).toEqual({ prompt: "she waves", image: img, quality: "720p", duration: 5 });
  });

  it("with no scene picture, makes the scene from the character picture as a reference (or says which models can)", () => {
    const ref = [{ bytes: character, contentType: "image/png" }];
    const run = (app: string, extra: Record<string, unknown> = {}) => InferenceShVideo.input("she waves", { ...base, still: undefined, model: `inference.sh/${app}`, character, durationSec: 6.2, ...extra });
    const sd = run("bytedance/seedance-2-5");
    expect(sd.input).toMatchObject({ reference_images: ref, ratio: "16:9", duration: 8 });
    expect(sd.input.image).toBeUndefined();
    expect(String(sd.input.prompt)).toMatch(/^@Image1 .*she waves$/s);
    const wan = run("alibaba/wan-2-7-i2v", { aspectRatio: "9:16" });
    expect(wan.app).toBe("alibaba/wan-2-7-r2v"); // Wan's reference version
    expect(wan.input).toMatchObject({ reference_images: ref, ratio: "9:16", resolution: "720P", duration: 7 });
    expect(wan.input.first_frame).toBeUndefined();
    expect(run("xai/grok-imagine-video-1-5", { resolution: "4k" }).input).toMatchObject({ reference_images: ref, resolution: "720p", aspect_ratio: "16:9" });
    expect(run("minimax/h3", { durationSec: 14 }).input).toMatchObject({ reference_images: ref, duration: 14, ratio: "16:9" });
    expect(run("falai/minimax-h3-max").input).toMatchObject({ reference_images: ref, aspect_ratio: "16:9" });
    expect(run("google/gemini-omni-flash").input).toMatchObject({ reference_images: ref, aspect_ratio: "16:9" });
    for (const app of ["klingai/video-v3", "bfl/flux-3-video", "klingai/avatar", "pruna/p-video", "pixverse/v6"]) expect(() => run(app)).toThrow(/only animates a scene picture/);
    expect(() => run("bytedance/seedance-2-5", { character: undefined })).toThrow(/no character picture/);
  });

  /** Fake inference.sh API: records calls; the task finishes on the second status poll. */
  function fakeApi(final: { status: number | string; output?: unknown; error?: string }) {
    const calls: { method: string; url: string; body?: unknown; auth?: string }[] = [];
    let polls = 0;
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    const impl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, auth });
      if (url.endsWith("/files")) return ok([{ uri: `https://cloud.inference.sh/u/${calls.length}.png`, upload_url: `https://upload.example/${calls.length}` }]);
      if (url.startsWith("https://upload.example/")) return new Response(null, { status: 200 });
      if (url.endsWith("/apps/run")) return ok({ id: "t1", status: 2 });
      if (url.endsWith("/tasks/t1/status")) return ok({ status: ++polls < 2 ? "running" : final.status });
      if (url.endsWith("/tasks/t1")) return ok(final);
      if (url === "https://cloud.inference.sh/v.mp4") return new Response(MP4);
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it("uploads the pictures, runs the app, polls, and downloads the video", async () => {
    const api = fakeApi({ status: 10, output: { video: "https://cloud.inference.sh/v.mp4" } });
    const v = new InferenceShVideo("inf_test", api.impl, { pollMs: 1, retryDelayMs: 1 });
    expect((await v.video("p", { ...base, character })).equals(MP4)).toBe(true);
    const run = api.calls.find((c) => c.url.endsWith("/apps/run"))!;
    expect(run.body).toMatchObject({ app: "bytedance/seedance-2-5", input: { reference_images: [expect.stringMatching(/^https:\/\/cloud\.inference\.sh\//), expect.stringMatching(/^https:\/\/cloud\.inference\.sh\//)] } });
    expect(api.calls.filter((c) => c.url.startsWith("https://api.inference.sh")).every((c) => c.auth === "Bearer inf_test")).toBe(true);
    expect(api.calls.find((c) => c.url.startsWith("https://upload.example/"))!.auth).toBeUndefined();
  });

  it("remembers the task, retries the download, and resumes a finished task instead of paying again", async () => {
    // Download fails twice (502), then works: retried without re-running the task.
    let downloads = 0;
    const api = fakeApi({ status: 10, output: { video: "https://cloud.inference.sh/v.mp4" } });
    const flaky = (async (url: string, init?: RequestInit) => {
      if (url === "https://cloud.inference.sh/v.mp4" && ++downloads <= 2) return new Response("bad gateway", { status: 502 });
      return api.impl(url, init);
    }) as unknown as typeof fetch;
    const started: string[] = [];
    const v = new InferenceShVideo("k", flaky, { pollMs: 1, retryDelayMs: 1 });
    const mp4 = await v.video("p", { ...base, onTaskStarted: (id) => void started.push(id) });
    expect(mp4.equals(MP4)).toBe(true);
    expect([started, downloads]).toEqual([["t1"], 3]);

    // Resume: a finished task is just downloaded; no upload, no new run.
    const again = fakeApi({ status: 10, output: { video: "https://cloud.inference.sh/v.mp4" } });
    const r = new InferenceShVideo("k", again.impl, { pollMs: 1, retryDelayMs: 1 });
    expect((await r.video("p", { ...base, resumeTaskId: "t1" })).equals(MP4)).toBe(true);
    expect(again.calls.some((c) => c.url.endsWith("/apps/run") || c.url.endsWith("/files"))).toBe(false);

    // A failed earlier task: start a new one.
    const fresh = fakeApi({ status: 10, output: { video: "https://cloud.inference.sh/v.mp4" } });
    let first = true;
    const prevFailed = (async (url: string, init?: RequestInit) => {
      if (first && url.endsWith("/tasks/old/status")) return (first = false), new Response(JSON.stringify({ data: { status: 11 } }));
      return fresh.impl(url, init);
    }) as unknown as typeof fetch;
    const n = new InferenceShVideo("k", prevFailed, { pollMs: 1, retryDelayMs: 1 });
    expect((await n.video("p", { ...base, resumeTaskId: "old" })).equals(MP4)).toBe(true);
    expect(fresh.calls.some((c) => c.url.endsWith("/apps/run"))).toBe(true);
  });

  it("surfaces failed tasks and HTTP errors with their status", async () => {
    const failed = new InferenceShVideo("k", fakeApi({ status: 11, error: "content rejected" }).impl, { pollMs: 1, retryDelayMs: 1 });
    await expect(failed.video("p", base)).rejects.toThrow(/task t1 failed: content rejected/);

    const limited = new InferenceShVideo("k", (async () => new Response(JSON.stringify({ detail: "slow down" }), { status: 429 })) as unknown as typeof fetch);
    await expect(limited.video("p", base)).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/slow down/) });
  });
});

describe("video resolution", () => {
  it("defaults to 1080p and validates VIDEO_RESOLUTION", () => {
    expect([videoResolution(""), videoResolution(" 4K "), videoResolution("720p")]).toEqual(["1080p", "4k", "720p"]);
    expect(() => videoResolution("8k")).toThrow(/VIDEO_RESOLUTION must be one of/);
    expect(minResolution("4k", "1080p")).toBe("1080p");
  });
  it("sizes the final video", () => {
    expect(formatFor("16:9", "4k")).toEqual({ width: 3840, height: 2160, fps: 25 });
    expect(formatFor("9:16", "1080p")).toEqual({ width: 1080, height: 1920, fps: 25 });
    expect(formatFor("16:9", "720p")).toMatchObject({ width: 1280, height: 720 });
  });
  it("caps each model at what it can make", () => {
    expect([maxVeoResolution("veo-3.1-fast-generate-preview"), maxVeoResolution("veo-3.1-lite-generate-preview"), maxVeoResolution("veo-3.0-generate-001")]).toEqual(["4k", "1080p", "720p"]);
    expect([supportsImageSize("gemini-3.1-flash-image"), supportsImageSize("gemini-3-pro-image"), supportsImageSize("gemini-2.5-flash-image")]).toEqual([true, true, false]);
    const sd = InferenceShVideo.input("p", { model: "inference.sh/bytedance/seedance-2-5", still: Buffer.from("s"), aspectRatio: "16:9", label: "x", mime: () => "image/png", resolution: "4k" });
    expect(sd.input.resolution).toBe("1080p");
  });
});


describe("waiting for per-minute quotas", () => {
  it("waits as long as the API asks, with extra tries for short waits", async () => {
    const quota = Object.assign(new Error('Quota exceeded for metric: generate_content_free_tier_requests, limit: 3, model: gemini-3.8-flash-tts\nPlease retry in 3.020031325s.'), { status: 429 });
    expect([retryHintMs(quota), retryHintMs(new Error('"retryDelay":"21595s"')), retryHintMs(new Error("nope"))]).toEqual([3021, 21_595_000, undefined]);
    const waits: number[] = [];
    let calls = 0;
    const out = await withRetry(async () => { if (++calls < 7) throw quota; return "ok"; }, { sleep: async (ms) => { waits.push(ms); } });
    expect([out, calls]).toEqual(["ok", 7]); // more than the usual 3 retries
    expect(waits.every((w) => w >= 3500 && w <= 4600)).toBe(true);
    // Hours away: not waited for here.
    const daily = Object.assign(new Error("Please retry in 21595s."), { status: 429 });
    let n = 0;
    await expect(withRetry(async () => { n++; throw daily; }, { sleep: async () => {} })).rejects.toBe(daily);
    expect(n).toBe(4);
  });
});
