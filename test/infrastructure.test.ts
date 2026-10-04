import { describe, expect, it } from "vitest";
import { buildSrt, zoompanFilter } from "../src/infrastructure/media/ffmpeg.js";
import { encodePng } from "../src/infrastructure/media/png.js";
import { pcmToWav, toneWav, wavDurationSeconds } from "../src/infrastructure/media/wav.js";
import { srtToVtt } from "../src/api/routes/projects.routes.js";
import { mapLimit, videoConcurrency } from "../src/services/pipeline.service.js";
import { maxVeoResolution, supportsImageSize, supportsReferenceImages } from "../src/infrastructure/providers/gemini.js";
import { formatFor } from "../src/infrastructure/media/ffmpeg.js";
import { minResolution, videoResolution } from "../src/domain/project/project.model.js";
import { InferenceShVideo, isAudioDrivenModel } from "../src/infrastructure/providers/inference-sh.js";
import { slugify } from "../src/util/fs.js";
import { isTransientError, withRetry } from "../src/util/retry.js";

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
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError(new Error("API key not valid"))).toBe(false);
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
    expect(new InferenceShVideo("k").listModels().map((m) => m.id)).toEqual([model, "inference.sh/klingai/video-v3", "inference.sh/klingai/avatar", "inference.sh/klingai/avatar-pro"]);
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
  it("defaults to 4k and validates VIDEO_RESOLUTION", () => {
    expect([videoResolution(""), videoResolution(" 1080P "), videoResolution("720p")]).toEqual(["4k", "1080p", "720p"]);
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

