import { describe, expect, it } from "vitest";
import { buildSrt, zoompanFilter } from "../src/infrastructure/media/ffmpeg.js";
import { encodePng } from "../src/infrastructure/media/png.js";
import { pcmToWav, toneWav, wavDurationSeconds } from "../src/infrastructure/media/wav.js";
import { srtToVtt } from "../src/api/routes/projects.routes.js";
import { mapLimit } from "../src/services/pipeline.service.js";
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
});

describe("slugify length", () => {
  it("cuts long topics at a word boundary", () => {
    expect(slugify("Washing our hands with soap before we eat lunch")).toBe("washing-our-hands-with-soap-before-we");
  });
});
