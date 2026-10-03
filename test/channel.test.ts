import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/server.js";
import { normalizeChannelDetails } from "../src/domain/channel/channel.model.js";
import { ConflictError, ValidationError } from "../src/domain/errors.js";
import { probeStreams, runFfmpeg } from "../src/infrastructure/media/ffmpeg.js";
import { MockProvider } from "../src/infrastructure/providers/mock.js";
import { makeTestContainer } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());

/** Width × height of a picture, via ffprobe. */
async function size(file: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) =>
    execFile(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", file], (err, out) => (err ? reject(err) : resolve(out.trim()))),
  );
}

async function samplePhotoDataUrl(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kids-studio-photo-"));
  try {
    await runFfmpeg(["-f", "lavfi", "-i", "color=c=orange:s=300x400", "-frames:v", "1", path.join(dir, "p.jpg")]);
    return `data:image/jpeg;base64,${(await readFile(path.join(dir, "p.jpg"))).toString("base64")}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("channel details", () => {
  it("clamps text to YouTube's limits", () => {
    const d = normalizeChannelDetails({ name: "  Happy   Kids ", handle: "@Happy Kids TV!", description: "x".repeat(1200), keywords: ["songs", "Songs", ...Array.from({ length: 80 }, (_, i) => `keyword number ${i}`)] });
    expect(d.name).toBe("Happy Kids");
    expect(d.handle).toBe("HappyKidsTV");
    expect(d.description).toHaveLength(1000);
    expect(d.keywords.filter((k) => k.toLowerCase() === "songs")).toHaveLength(1);
    expect(d.keywords.join(",").length).toBeLessThanOrEqual(500);
    expect(normalizeChannelDetails({ name: "ልጆች", handle: "", description: "d", keywords: [] }).handle).toMatch(/^[\w.-]{3,30}$/);
  });
});

describe("ChannelService", () => {
  it("needs a photo, a prompt or a name", async () => {
    c = await makeTestContainer();
    await expect(c.channelService.create({ input: {}, provider: "mock" })).rejects.toBeInstanceOf(ValidationError);
    await expect(c.channelService.create({ input: { brief: "x".repeat(3000) }, provider: "mock" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("makes the whole kit from a prompt, at YouTube's exact sizes", async () => {
    const mock = new MockProvider({ imageSize: [320, 180] });
    c = await makeTestContainer({ provider: () => mock });
    const kit = await c.channelService.create({ input: { brief: "Songs about animals for toddlers" }, provider: "mock" });
    expect(kit.id).toBe("songs-about-animals-for-toddlers");
    await expect(c.channelService.generate(kit.id, "watermark")).rejects.toBeInstanceOf(ConflictError); // needs the logo
    await expect(c.channelService.generate(kit.id, "poster")).rejects.toBeInstanceOf(ValidationError);

    const withText = await c.channelService.generate(kit.id, "details");
    expect(withText.details).toMatchObject({ name: "Happy Kids TV", handle: "happykidstv" });
    await c.channelService.generate(kit.id, "logo");
    await Promise.all([c.channelService.generate(kit.id, "banner"), c.channelService.generate(kit.id, "thumbnail", { title: "Moo!" })]);
    const done = await c.channelService.generate(kit.id, "watermark");

    const dir = c.channelService.mediaDir(kit.id);
    expect(await size(path.join(dir, "logo.png"))).toBe("800x800");
    expect(await size(path.join(dir, "banner.jpg"))).toBe("2560x1440");
    expect(await size(path.join(dir, "watermark.png"))).toBe("150x150");
    expect(await size(path.join(dir, "thumbnail.jpg"))).toBe("1280x720");
    expect(done.media.banner!.bytes).toBeLessThan(6 * 1024 * 1024);
    expect(done.busy).toEqual([]);

    // Prompts use the generated name, the thumbnail title, and the channel models.
    const banner = mock.prompts.find((p) => p.prompt.includes("channel banner"))!;
    expect(banner.prompt).toContain('called "Happy Kids TV"');
    expect(banner.model).toBe("gemini-3.1-flash-image");
    expect(done.prompts.thumbnail).toContain('"Moo!"');
    expect(mock.prompts.find((p) => p.kind === "channel")!.prompt).toContain("Songs about animals for toddlers");
    expect((await c.channelService.list()).map((k) => k.name)).toEqual(["Happy Kids TV"]);
  }, 60_000);

  it("uses the sample photo as a reference and keeps the user's name", async () => {
    const mock = new MockProvider({ imageSize: [320, 180] });
    const seen: number[] = [];
    const image = mock.image.bind(mock) as (prompt: string, opts: Parameters<MockProvider["image"]>[1] & { references?: Buffer[] }) => Promise<Buffer>;
    mock.image = async (prompt, opts: Parameters<typeof image>[1]) => (seen.push(opts.references?.length ?? 0), image(prompt, opts));
    c = await makeTestContainer({ provider: () => mock });
    const kit = await c.channelService.create({ input: { name: "Abeba's Songs", language: "am" }, provider: "mock", image: await samplePhotoDataUrl() });
    expect(kit.media.photo).not.toBeNull();
    expect((await c.channelService.generate(kit.id, "details")).details!.name).toBe("Abeba's Songs");
    await c.channelService.generate(kit.id, "logo");
    await c.channelService.generate(kit.id, "banner");
    expect(seen).toEqual([1, 2]); // logo: photo; banner: photo + logo
    expect(mock.prompts.find((p) => p.prompt.includes("profile picture"))!.prompt).toContain("Base it on the attached sample photo");

    const edited = await c.channelService.editDetails(kit.id, { name: "Abeba", handle: "abeba songs", description: "Songs.", keywords: ["a", "b"] });
    expect(edited.details).toMatchObject({ name: "Abeba", handle: "abebasongs" });
    const updated = await c.channelService.update(kit.id, { input: { brief: "Amharic alphabet songs" }, removePhoto: true });
    expect([updated.input.brief, updated.input.name, updated.media.photo, updated.media.logo !== null]).toEqual(["Amharic alphabet songs", "Abeba's Songs", null, true]);
  }, 60_000);

  it("writes bilingual (Amharic + English) channel text", async () => {
    const mock = new MockProvider({ imageSize: [320, 180] });
    c = await makeTestContainer({ provider: () => mock });
    const kit = await c.channelService.create({ input: { brief: "Kids songs made with this app", language: "both" }, provider: "mock" });
    expect(kit.input.language).toBe("both");
    await c.channelService.generate(kit.id, "details");
    const prompt = mock.prompts.find((p) => p.kind === "channel")!.prompt;
    expect(prompt).toContain("both Amharic (Ge'ez script) and English");
    expect(prompt).toContain("plus a few in English"); // the {{#if am}} keyword hint
    await expect(c.channelService.create({ input: { brief: "x y z", language: "fr" }, provider: "mock" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("channel HTTP API", () => {
  it("creates a kit, makes a picture, and serves it", async () => {
    c = await makeTestContainer();
    const server: http.Server = createApp(c);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const res = await fetch(`${base}/api/channels`, json("POST", { input: { brief: "Counting with colourful fish" }, provider: "mock", image: await samplePhotoDataUrl() }));
      expect(res.status).toBe(201);
      const { id } = await res.json();
      const made = await (await fetch(`${base}/api/channels/${id}/assets/logo/generate`, json("POST", { provider: "mock" }))).json();
      expect(made.media.logo.file).toBe("logo.png");
      const png = await fetch(`${base}/channel-media/${id}/logo.png?v=${made.media.logo.version}`);
      expect([png.status, png.headers.get("content-type")]).toEqual([200, "image/png"]);
      const tmp = path.join(c.mediaRoot, "check.png");
      await writeFile(tmp, Buffer.from(await png.arrayBuffer()));
      expect(await probeStreams(tmp)).toEqual(["video"]);
      expect((await fetch(`${base}/channel-media/${id}/logo.prompt.txt`)).status).toBe(404);
      expect((await fetch(`${base}/channel-media/${id}/..%2F..%2Fpackage.json`)).status).toBe(404);
      expect((await fetch(`${base}/api/channels/${id}/details`, json("PUT", { details: { name: "" } }))).status).toBe(400);
      expect((await fetch(`${base}/api/channels/nope`)).status).toBe(404);
      const list = await (await fetch(`${base}/api/channels`)).json();
      expect(list[0]).toMatchObject({ id, logo: { file: "logo.png" } });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }, 60_000);
});
