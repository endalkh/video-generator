import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capabilityOf } from "../src/domain/model-setting/model-setting.entity.js";
import { RunwayVideo, WAN_MAX_AUDIO_SEC } from "../src/infrastructure/providers/runway.js";
import { videoConcurrency } from "../src/services/pipeline.service.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** A tiny real PNG, an MP3 of `sec` seconds and an MP4, made with ffmpeg. */
async function fixtures(sec: number) {
  dir = await mkdtemp(path.join(os.tmpdir(), "runway-test-"));
  const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a]);
  ff("-f", "lavfi", "-i", "color=c=pink:s=64x112", "-frames:v", "1", path.join(dir, "p.png"));
  ff("-f", "lavfi", "-i", `sine=f=440:d=${sec}`, "-c:a", "libmp3lame", path.join(dir, "a.mp3"));
  ff("-f", "lavfi", "-i", "color=c=blue:s=64x112:d=1", "-pix_fmt", "yuv420p", path.join(dir, "v.mp4"));
  return { png: await readFile(path.join(dir, "p.png")), mp3: await readFile(path.join(dir, "a.mp3")), mp4: await readFile(path.join(dir, "v.mp4")) };
}

function fakeRunway(mp4: Buffer) {
  const bodies: Record<string, unknown>[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/image_to_video")) {
      bodies.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ id: `t${bodies.length}` }), { status: 200 });
    }
    if (url.includes("/v1/tasks/")) return new Response(JSON.stringify({ status: "SUCCEEDED", output: ["https://dnznrvs05pmza.cloudfront.net/out.mp4"] }));
    if (url.endsWith("out.mp4")) return new Response(new Uint8Array(mp4));
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { bodies, impl };
}

describe("Runway Wan 3.0", () => {
  it("is a video model, one at a time", () => {
    expect([capabilityOf("runway/wan3"), capabilityOf("runway/wan3_prime"), capabilityOf("same")]).toEqual(["video", "video", "video"]);
    expect(videoConcurrency("runway/wan3", undefined, 4)).toBe(1);
  });

  it("song: sends the picture and the scene's song as references, so the character sings that song", async () => {
    const { png, mp3, mp4 } = await fixtures(6);
    const api = fakeRunway(mp4);
    const out = await new RunwayVideo("key_test", api.impl, { pollMs: 1 }).video("she sings in the forest", { model: "runway/wan3", still: png, audio: mp3, singAudio: true, aspectRatio: "9:16", label: "scene 1 video" });
    expect(out.length).toBeGreaterThan(100);
    expect(api.bodies).toHaveLength(1);
    const b = api.bodies[0]!;
    expect(b).toMatchObject({ model: "wan3", ratio: "720:1280", duration: 6, audio: true });
    expect((b.promptImage as { uri: string }[])[0]!.uri).toMatch(/^data:image\/jpeg;base64,/);
    expect((b.referenceAudio as { type: string; uri: string }[])[0]).toMatchObject({ type: "audio", uri: expect.stringMatching(/^data:audio\/mpeg;base64,/) });
    expect(String(b.promptText)).toMatch(/Audio 1/);
  });

  it(`a scene longer than ${WAN_MAX_AUDIO_SEC} s is made as several clips, each with its slice of the song`, async () => {
    const { png, mp3, mp4 } = await fixtures(20);
    const api = fakeRunway(mp4);
    await new RunwayVideo("key_test", api.impl, { pollMs: 1 }).video("p", { model: "runway/wan3", still: png, audio: mp3, singAudio: true, aspectRatio: "9:16", label: "scene 2 video" });
    expect(api.bodies).toHaveLength(2);
    for (const b of api.bodies) expect(b.duration as number).toBeLessThanOrEqual(WAN_MAX_AUDIO_SEC);
  });

  it("not a song: the picture is the first frame and no audio is sent", async () => {
    const { png, mp3, mp4 } = await fixtures(4);
    const api = fakeRunway(mp4);
    await new RunwayVideo("key_test", api.impl, { pollMs: 1 }).video("p", { model: "runway/wan3", still: png, audio: mp3, aspectRatio: "9:16", label: "x", durationSec: 5 });
    expect(api.bodies[0]).toMatchObject({ ratio: "auto_720p", duration: 5, audio: false });
    expect(api.bodies[0]!.referenceAudio).toBeUndefined();
    expect(typeof api.bodies[0]!.promptImage).toBe("string");
  });
});
