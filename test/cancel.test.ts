import { afterEach, describe, expect, it } from "vitest";
import { abortable, PipelineCancelled } from "../src/services/pipeline.service.js";
import { makeTestContainer, mockProvider } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());

describe("Stop", () => {
  it("stops at once, even in the middle of a long video call", async () => {
    const mock = mockProvider();
    let calls = 0;
    // A video model that takes a minute per clip.
    mock.video = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 60_000));
      return Buffer.alloc(0);
    };
    c = await makeTestContainer({ provider: () => mock });
    const p = await c.projectService.create({ topic: "Washing hands", sceneCount: 2, reviewMode: "auto", videoMode: "veo" }, "mock");
    await c.projectService.start(p.id);
    while (calls === 0) await new Promise((r) => setTimeout(r, 20));

    const pressed = Date.now();
    expect(c.projectService.cancel(p.id)).toBe(true);
    await c.projectService.idle();
    expect(Date.now() - pressed).toBeLessThan(2_000);
    const stopped = await c.projectService.get(p.id);
    expect([stopped.status, stopped.running]).toEqual(["paused", false]);
  }, 30_000);

  it("abortable: passes results through, rejects on abort, and swallows a late failure", async () => {
    const ctl = new AbortController();
    await expect(abortable(Promise.resolve(1), ctl.signal)).resolves.toBe(1);
    let fail!: (e: Error) => void;
    const late = abortable(new Promise<number>((_, reject) => (fail = reject)), ctl.signal);
    ctl.abort();
    await expect(late).rejects.toBeInstanceOf(PipelineCancelled);
    fail(new Error("too late")); // no unhandled rejection
    await expect(abortable(Promise.resolve(2), ctl.signal)).rejects.toBeInstanceOf(PipelineCancelled);
  });
});
