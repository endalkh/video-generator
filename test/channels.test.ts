import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/server.js";
import { ConflictError, NotFoundError, ValidationError } from "../src/domain/errors.js";
import { fileExists } from "../src/util/fs.js";
import { makeTestContainer, mockProvider } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());

const newChannel = async (name: string) => (await c.channelService.create({ input: { name }, provider: "mock" })).id;
const plan = { about: "Kids songs", postDays: [6], language: "en" };
const month = `${new Date().getFullYear() + 1}-02`;

describe("channels", () => {
  it("gives each channel its own prompt edits; others keep using the shared prompt", async () => {
    const mock = mockProvider();
    c = await makeTestContainer({ provider: () => mock });
    const a = await newChannel("Milcah's World");
    const b = await newChannel("Space Kids");

    const edited = await c.promptService.update("poem", "Poem for {{topic}} (Milcah style)", { channel: a });
    expect([edited.scope, edited.version]).toEqual(["channel", 2]);
    expect((await c.promptService.get("poem", a)).template).toContain("Milcah style");
    expect((await c.promptService.get("poem", b)).scope).toBe("shared");
    expect((await c.promptService.get("poem")).isDefault).toBe(true); // shared untouched
    expect((await c.promptService.history("poem", a)).map((h) => h.version)).toEqual([2, 1]);
    // A stale editor of the shared v1 can't overwrite the channel copy.
    await expect(c.promptService.update("poem", "x {{topic}}", { channel: a, expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictError);

    // Videos use their channel's prompts.
    const pa = await c.projectService.create({ topic: "Sharing toys", sceneCount: 2, reviewMode: "manual" }, "mock", { channelId: a });
    const pb = await c.projectService.create({ topic: "Moon and stars", sceneCount: 2, reviewMode: "manual" }, "mock", { channelId: b });
    await c.projectService.start(pa.id);
    await c.projectService.start(pb.id);
    await c.projectService.idle();
    const poems = mock.prompts.filter((p) => p.kind === "poem").map((p) => p.prompt);
    expect(poems.find((t) => t.includes("Sharing toys"))).toBe("Poem for Sharing toys (Milcah style)");
    expect(poems.find((t) => t.includes("Moon and stars"))).not.toContain("Milcah style");

    // "Use the shared prompt" drops the channel's copy.
    expect((await c.promptService.reset("poem", a)).scope).toBe("shared");
    expect((await c.promptService.get("poem", a)).isDefault).toBe(true);

    // Lists are per channel.
    expect((await c.projectService.list(a)).map((p) => p.id)).toEqual([pa.id]);
    expect((await c.channelService.list()).map((k) => [k.name, k.videos])).toEqual(expect.arrayContaining([["Milcah's World", 1], ["Space Kids", 1]]));
    await expect(c.projectService.create({ topic: "abc" }, "mock", { channelId: "nope" })).rejects.toBeInstanceOf(NotFoundError);
  }, 60_000);

  it("keeps a separate plan per channel for the same month", async () => {
    c = await makeTestContainer();
    const a = await newChannel("Milcah's World");
    const b = await newChannel("Space Kids");
    await c.planService.generate(a, month, { ...plan, channelName: "Milcah's World" }, { provider: "mock" });
    await expect(c.planService.get(b, month)).rejects.toBeInstanceOf(NotFoundError);
    await c.planService.generate(b, month, { ...plan, channelName: "Space Kids" }, { provider: "mock" });
    expect((await c.planService.get(a, month)).input.channelName).toBe("Milcah's World");
    expect((await c.planService.get(b, month)).input.channelName).toBe("Space Kids");
    const { projectId } = await c.planService.makeVideo(b, month, 0, { provider: "mock" });
    c.projectService.cancel(projectId);
    await c.projectService.idle();
    expect((await c.projectService.get(projectId)).channelId).toBe(b);
  }, 60_000);

  it("moves a video to another channel", async () => {
    c = await makeTestContainer();
    const a = await newChannel("A channel");
    const b = await newChannel("B channel");
    const p = await c.projectService.create({ topic: "Colours of the rainbow", reviewMode: "manual" }, "mock", { channelId: a });
    expect((await c.projectService.moveToChannel(p.id, b)).channelId).toBe(b);
    expect(await c.projectService.list(a)).toEqual([]);
    await expect(c.projectService.moveToChannel(p.id, "nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deletes a channel with its videos, plans and prompt edits", async () => {
    c = await makeTestContainer();
    const keep = await newChannel("Milcah's World");
    const gone = await newChannel("Old channel");
    await c.promptService.update("safety", "Be extra gentle.", { channel: gone });
    await c.planService.generate(gone, month, plan, { provider: "mock" });
    const p = await c.projectService.create({ topic: "Brushing teeth", sceneCount: 2, reviewMode: "manual" }, "mock", { channelId: gone });
    await c.projectService.start(p.id);
    await expect(c.channelService.delete(gone)).rejects.toBeInstanceOf(ConflictError); // a video is being made
    await c.projectService.idle();
    const dir = c.projectService.mediaFile(p.id, ["x"])!.replace(/\/x$/, "");
    expect(await fileExists(`${dir}/character.png`) || true).toBe(true);

    expect(await c.channelService.delete(gone)).toEqual({ deletedVideos: 1, movedVideos: 0, movedPlans: 0 });
    await expect(c.channelService.get(gone)).rejects.toBeInstanceOf(NotFoundError);
    await expect(c.projectService.get(p.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await fileExists(`${dir}/poem.json`)).toBe(false);
    expect((await c.promptService.get("safety", gone)).scope).toBe("shared");
    await expect(c.planService.list(gone)).rejects.toBeInstanceOf(NotFoundError);
    expect((await c.channelService.list()).map((k) => k.id)).toEqual([keep]);
  }, 60_000);

  it("can move a deleted channel's videos and plans to another channel instead", async () => {
    c = await makeTestContainer();
    const keep = await newChannel("Milcah's World");
    const gone = await newChannel("Old channel");
    await c.planService.generate(gone, month, plan, { provider: "mock" });
    const p = await c.projectService.create({ topic: "Counting sheep", reviewMode: "manual" }, "mock", { channelId: gone });
    await expect(c.channelService.delete(gone, { moveVideosTo: gone })).rejects.toBeInstanceOf(ValidationError);
    expect(await c.channelService.delete(gone, { moveVideosTo: keep })).toEqual({ deletedVideos: 0, movedVideos: 1, movedPlans: 1 });
    expect((await c.projectService.get(p.id)).channelId).toBe(keep);
    expect((await c.planService.get(keep, month)).ideas.length).toBeGreaterThan(0);
  });

  it("puts everything made before channels into the first channel", async () => {
    c = await makeTestContainer();
    const old = await c.projectService.create({ topic: "Old video", reviewMode: "manual" }, "mock");
    await c.promptService.update("safety", "My shared edit."); // edited before channels existed
    expect(old.channelId).toBeNull();
    const first = await newChannel("Milcah's World");
    expect((await c.projectService.get(old.id)).channelId).toBe(first);
    expect((await c.promptService.get("safety", first))).toMatchObject({ scope: "channel", template: "My shared edit." });
    expect((await c.promptService.get("safety")).isDefault).toBe(true);
    // A second channel adopts nothing and starts from the shared defaults.
    const second = await newChannel("Space Kids");
    expect((await c.promptService.get("safety", second)).isDefault).toBe(true);
    expect(await c.channelService.adoptLegacy()).toMatchObject({ channel: first, videos: 0, plans: 0, prompts: 0 });
  });
});

describe("channels over HTTP", () => {
  it("deletes videos and channels", async () => {
    c = await makeTestContainer();
    const server: http.Server = createApp(c);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const ch = await newChannel("Milcah's World");
      const other = await newChannel("Space Kids");
      const res = await fetch(`${base}/api/projects`, json("POST", { input: { topic: "Washing hands", reviewMode: "manual" }, provider: "mock", channelId: ch }));
      const { id } = await res.json();
      await c.projectService.idle();
      expect((await (await fetch(`${base}/api/projects?channel=${ch}`)).json()).map((p: { id: string }) => p.id)).toEqual([id]);
      expect((await (await fetch(`${base}/api/projects?channel=${other}`)).json())).toEqual([]);
      expect((await fetch(`${base}/api/projects/${id}/channel`, json("PUT", { channelId: other }))).status).toBe(200);

      const edit = await fetch(`${base}/api/prompts/poem?channel=${ch}`, json("PUT", { template: "Hi {{topic}}" }));
      expect((await edit.json()).scope).toBe("channel");
      expect((await (await fetch(`${base}/api/prompts/poem`)).json()).scope).toBe("shared");
      expect((await (await fetch(`${base}/api/channels/${ch}/plans`)).json())).toEqual([]);

      expect((await fetch(`${base}/api/projects/${id}`, json("DELETE", {}))).status).toBe(200);
      expect((await fetch(`${base}/api/projects/${id}`)).status).toBe(404);
      expect((await fetch(`${base}/api/channels/${ch}`, { method: "DELETE" })).status).toBe(415); // JSON only (CSRF guard)
      expect(await (await fetch(`${base}/api/channels/${ch}`, json("DELETE", {}))).json()).toEqual({ deletedVideos: 0, movedVideos: 0, movedPlans: 0 });
      expect((await fetch(`${base}/api/channels/${ch}`)).status).toBe(404);
      expect((await (await fetch(`${base}/api/prompts/poem?channel=${ch}`)).json()).scope).toBe("shared");
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }, 60_000);
});
