import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/server.js";
import { runFfmpeg } from "../src/infrastructure/media/ffmpeg.js";
import { makeTestContainer } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
let server: http.Server;
let base: string;

beforeAll(async () => {
  c = await makeTestContainer();
  server = createApp(c);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await c.cleanup();
});

const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("HTTP API", () => {
  it("serves the UI shell", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toContain("Kids Animation Studio");
    const js = await fetch(`${base}/app.js`);
    expect([js.status, js.headers.get("content-type")]).toEqual([200, "text/javascript; charset=utf-8"]);
    expect((await fetch(`${base}/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/..%2F.env`)).status).toBe(404);
  });

  it("edits prompts with validation and history", async () => {
    const list = await (await fetch(`${base}/api/prompts`)).json();
    expect(list.map((p: { key: string }) => p.key)).toContain("song");

    const bad = await fetch(`${base}/api/prompts/poem`, json("PUT", { template: "{{oops}}" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).details[0]).toMatch(/unknown variable/);

    const ok = await (await fetch(`${base}/api/prompts/poem`, json("PUT", { template: "Poem about {{topic}}", note: "short", expectedVersion: 1 }))).json();
    expect(ok.version).toBe(2);
    const stale = await fetch(`${base}/api/prompts/poem`, json("PUT", { template: "again", expectedVersion: 1 }));
    expect(stale.status).toBe(409);

    const preview = await (await fetch(`${base}/api/prompts/poem/preview`, json("POST", { input: { reviewMode: "auto", topic: "Colors" } }))).json();
    expect(preview.text).toBe("Poem about Colors");
    const reset = await (await fetch(`${base}/api/prompts/poem/reset`, json("POST", {}))).json();
    expect(reset.isDefault).toBe(true);
    expect(await (await fetch(`${base}/api/prompts/nope`)).json()).toMatchObject({ error: expect.stringMatching(/Unknown prompt/) });
  });

  it("creates a project, runs it, and serves the video with range requests", async () => {
    const res = await fetch(`${base}/api/projects`, json("POST", { input: { reviewMode: "auto", topic: "Brushing teeth", sceneCount: 2 }, provider: "mock" }));
    expect(res.status).toBe(201);
    const { id } = await res.json();
    await c.projectService.idle();
    const p = await (await fetch(`${base}/api/projects/${id}`)).json();
    expect(p.status).toBe("done");
    expect(p.media.final).toBe("final.mp4");

    const part = await fetch(`${base}/media/${id}/final.mp4`, { headers: { range: "bytes=0-99" } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    expect((await fetch(`${base}/media/${id}/subtitles.vtt`)).headers.get("content-type")).toContain("text/vtt");
    expect((await fetch(`${base}/media/${id}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);

    const gens = await (await fetch(`${base}/api/projects/${id}/generations`)).json();
    expect(gens.some((g: { promptKey: string }) => g.promptKey === "scene_image")).toBe(true);
  }, 60_000);

  it("generates a single step via its own endpoint", async () => {
    const { id } = await (await fetch(`${base}/api/projects`, json("POST", { input: { topic: "Counting apples", sceneCount: 2, reviewMode: "manual" }, provider: "mock" }))).json();
    await c.projectService.idle(); // creation runs to the first review (poem)
    expect((await fetch(`${base}/api/projects/${id}/steps/clips/generate`, json("POST", {}))).status).toBe(409);
    expect((await fetch(`${base}/api/projects/${id}/steps/bogus/generate`, json("POST", {}))).status).toBe(400);
    const res = await fetch(`${base}/api/projects/${id}/steps/scenes/generate`, json("POST", { provider: "mock" }));
    expect(res.status).toBe(202);
    await c.projectService.idle();
    const p = await (await fetch(`${base}/api/projects/${id}`)).json();
    expect([p.completed, p.awaitingReview]).toEqual([["poem", "scenes"], "scenes"]);
  }, 60_000);

  it("uploads a large character picture over HTTP", async () => {
    const { id } = await (await fetch(`${base}/api/projects`, json("POST", { input: { topic: "Pebbles by the river", sceneCount: 2, reviewMode: "manual" }, provider: "mock" }))).json();
    await c.projectService.idle();
    await c.projectService.generateStep(id, "scenes");
    await c.projectService.idle();
    // ~1 MB noisy JPEG: well over the normal 200 kB JSON limit.
    const dir = await mkdtemp(path.join(os.tmpdir(), "kids-studio-up-"));
    await runFfmpeg(["-f", "lavfi", "-i", "nullsrc=s=1600x1600,geq=random(1)*255:128:128", "-frames:v", "1", "-q:v", "2", path.join(dir, "big.jpg")]);
    const jpg = await readFile(path.join(dir, "big.jpg"));
    await rm(dir, { recursive: true, force: true });
    expect(jpg.length).toBeGreaterThan(300_000);
    const res = await fetch(`${base}/api/projects/${id}/character/upload`, json("PUT", { image: `data:image/jpeg;base64,${jpg.toString("base64")}`, name: "Lulu", description: "a small grey pebble with a smile" }));
    expect(res.status).toBe(200);
    const p = await (await fetch(`${base}/api/projects/${id}`)).json();
    expect([p.character.name, p.media.characterImage, p.awaitingReview]).toEqual(["Lulu", "character.png", "character"]); // manual mode: check the upload before continuing
    const png = await fetch(`${base}/media/${id}/character.png`);
    expect(png.headers.get("content-type")).toBe("image/png");
  }, 60_000);

  it("reads and changes per-task models", async () => {
    const settings = await (await fetch(`${base}/api/models/settings`)).json();
    expect(settings.find((s: { task: string }) => s.task === "song").model).toBe("lyria-3.5");
    const ok = await fetch(`${base}/api/models/settings/scenes`, json("PUT", { model: "gemini-3.1-pro-preview" }));
    expect((await ok.json()).model).toBe("gemini-3.1-pro-preview");
    expect((await fetch(`${base}/api/models/settings/scenes`, json("PUT", { model: "veo-3.1-lite-generate-preview" }))).status).toBe(400);
    expect((await fetch(`${base}/api/models/settings/nope`, json("PUT", { model: "x1" }))).status).toBe(404);
    const avail = await (await fetch(`${base}/api/models/available?provider=mock`)).json();
    expect(avail.byCapability.text.length).toBeGreaterThan(0);
    await fetch(`${base}/api/models/settings/scenes/reset`, json("POST", {}));
  });

  it("rejects bad input, non-JSON writes, and foreign hosts/origins", async () => {
    expect((await fetch(`${base}/api/projects`, json("POST", { input: { reviewMode: "auto", topic: "x" }, provider: "mock" }))).status).toBe(400);
    expect((await fetch(`${base}/api/projects`, { method: "POST", body: "topic=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
    expect((await fetch(`${base}/api/projects`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
  });
});
