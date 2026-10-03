import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/server.js";
import { DomainError, ValidationError } from "../src/domain/errors.js";
import { planToIcs, zonedToUtc } from "../src/domain/plan/plan.calendar.js";
import { planSlots, PlanInputSchema } from "../src/domain/plan/plan.model.js";
import { MockProvider } from "../src/infrastructure/providers/mock.js";
import { makeTestContainer } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());
const newChannel = async (name = "Milcah's World") => (await c.channelService.create({ input: { name }, provider: "mock" })).id;

const settings = { channelName: "Milcah's World", about: "Animated songs for little kids", mainCharacter: "Milcah (ሚልካ), a cheerful little girl", language: "both", postDays: [2, 4, 6], timezone: "Africa/Addis_Ababa" };
const before = new Date("2026-10-01T00:00:00Z");

describe("posting slots", () => {
  it("lists the chosen weekdays at weekday/weekend times, alternating languages", () => {
    const slots = planSlots("2026-11", PlanInputSchema.parse(settings), before);
    // November 2026 starts on a Sunday: 4 Tuesdays + 4 Thursdays + 4 Saturdays.
    expect(slots).toHaveLength(12);
    expect(slots.slice(0, 3)).toEqual([
      { date: "2026-11-03", time: "16:00", language: "am" },
      { date: "2026-11-05", time: "16:00", language: "en" },
      { date: "2026-11-07", time: "09:00", language: "am" },
    ]);
  });
  it("skips days already past", () => {
    const slots = planSlots("2026-11", PlanInputSchema.parse({ ...settings, language: "en" }), new Date("2026-11-20T12:00:00Z"));
    expect(slots[0]).toEqual({ date: "2026-11-21", time: "09:00", language: "en" });
  });
  it("validates the settings", () => {
    expect(PlanInputSchema.safeParse({ ...settings, postDays: [] }).success).toBe(false);
    expect(PlanInputSchema.safeParse({ ...settings, timezone: "Mars/Base" }).success).toBe(false);
    expect(PlanInputSchema.safeParse({ ...settings, weekdayTime: "25:00" }).success).toBe(false);
  });
});

describe("calendar export", () => {
  it("converts local posting times to UTC and writes valid iCalendar", () => {
    expect(zonedToUtc("2026-11-03", "16:00", "Africa/Addis_Ababa").toISOString()).toBe("2026-11-03T13:00:00.000Z");
    expect(zonedToUtc("2026-07-01", "09:00", "Europe/London").toISOString()).toBe("2026-07-01T08:00:00.000Z"); // BST
    const ics = planToIcs({ month: "2026-11", channelName: "ሚልካ ዓለም", timezone: "Africa/Addis_Ababa", now: before, ideas: [
      { date: "2026-11-03", time: "16:00", language: "am", title: "እጅ እንታጠብ, ጓደኞች; ና", topic: "t".repeat(200), lesson: "l", audioMode: "song", sceneCount: 4, thumbnailTitle: "x", videoDescription: "line1\nline2", tags: ["a", "b"], projectId: null },
    ] });
    expect(ics).toContain("DTSTART:20261103T130000Z");
    expect(ics).toContain("SUMMARY:📺 Post: እጅ እንታጠብ\\, ጓደኞች\\; ና");
    expect(ics).toContain("TRIGGER:-P2D");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
});

describe("PlanService", () => {
  it("plans a month, edits an idea, makes a video from it, and keeps made ideas when planning again", async () => {
    const mock = new MockProvider({ audioSecondsPerScene: 1, songLengthSec: 4, imageSize: [320, 180] });
    c = await makeTestContainer({ provider: () => mock });
    const ch = await newChannel();
    const month = `${new Date().getFullYear() + 1}-02`;
    const plan = await c.planService.generate(ch, month, settings, { provider: "mock" });
    expect(plan.ideas.length).toBeGreaterThanOrEqual(12);
    expect(plan.ideas.map((i) => i.language).slice(0, 2)).toEqual(["am", "en"]);
    const prompt = mock.prompts.find((p) => p.kind === "plan")!.prompt;
    expect(prompt).toContain(`Plan exactly ${plan.ideas.length} videos`);
    expect(prompt).toContain("Every video stars the same main character: Milcah (ሚልካ)");
    expect(prompt).toContain('called "Milcah\'s World"');
    expect(prompt).toContain("Ethiopian holidays");

    const edited = await c.planService.editIdea(ch, month, 0, { title: "Wash your hands", topic: "Washing hands before eating", time: "17:30" });
    expect(edited.ideas[0]).toMatchObject({ title: "Wash your hands", time: "17:30" });
    await expect(c.planService.editIdea(ch, month, 0, { date: "2020-01-01" })).rejects.toBeInstanceOf(ValidationError);

    const { projectId } = await c.planService.makeVideo(ch, month, 0, { provider: "mock" });
    await c.projectService.idle();
    const project = await c.projectService.get(projectId);
    expect(project.input).toMatchObject({ topic: "Washing hands before eating", language: "am", characterHint: "Milcah (ሚልካ), a cheerful little girl", reviewMode: "manual" });
    expect(project.completed).toEqual(["poem"]); // manual: stops for review
    await expect(c.planService.makeVideo(ch, month, 0, { provider: "mock" })).rejects.toThrow(/already made/);

    const again = await c.planService.generate(ch, month, { ...settings, notes: "Back to school" }, { provider: "mock" });
    expect(again.ideas[0]).toMatchObject({ title: "Wash your hands", projectId });
    expect(again.ideas).toHaveLength(plan.ideas.length);
    expect(mock.prompts.filter((p) => p.kind === "plan").at(-1)!.prompt).toContain("Wash your hands"); // don't repeat it
    expect(await c.planService.list(ch)).toEqual([{ month, theme: "Good habits", videos: plan.ideas.length, made: 1 }]);
  }, 60_000);

  it("replaces one idea you don't like, keeping its date, time and language", async () => {
    const mock = new MockProvider();
    c = await makeTestContainer({ provider: () => mock });
    const ch = await newChannel();
    const month = `${new Date().getFullYear() + 1}-06`;
    const plan = await c.planService.generate(ch, month, settings, { provider: "mock" });
    await c.planService.editIdea(ch, month, 1, { title: "Boring title" });
    const before = (await c.planService.get(ch, month)).ideas;

    const after = (await c.planService.regenerateIdea(ch, month, 1, { provider: "mock", hint: "about baby goats" })).ideas;
    expect(after).toHaveLength(plan.ideas.length);
    expect(after[1]).toMatchObject({ date: before[1]!.date, time: before[1]!.time, language: before[1]!.language, projectId: null });
    expect(after[1]!.title).not.toBe("Boring title");
    expect(after.filter((_, i) => i !== 1)).toEqual(before.filter((_, i) => i !== 1)); // the others are untouched

    const prompt = mock.prompts.filter((p) => p.kind === "plan").at(-1)!.prompt;
    expect(prompt).toContain("Plan exactly 1 videos");
    expect(prompt).toContain('didn\'t like: "Boring title"');
    expect(prompt).toContain("What they want instead: about baby goats");
    expect(prompt).toContain(before[0]!.title); // don't repeat the rest of the month

    const { projectId } = await c.planService.makeVideo(ch, month, 0, { provider: "mock" });
    await c.projectService.cancel(projectId);
    await c.projectService.idle();
    await expect(c.planService.regenerateIdea(ch, month, 0, { provider: "mock" })).rejects.toThrow(/already made/);
  });

  it("gives every video in the month the chosen length", async () => {
    const mock = new MockProvider({ audioSecondsPerScene: 1, songLengthSec: 4, imageSize: [320, 180] });
    c = await makeTestContainer({ provider: () => mock });
    const ch = await newChannel();
    const month = `${new Date().getFullYear() + 1}-05`;
    await c.planService.generate(ch, month, { ...settings, videoMinutes: 5 }, { provider: "mock" });
    expect(mock.prompts.find((p) => p.kind === "plan")!.prompt).toContain("Each video is about 5 minutes long");
    const { projectId } = await c.planService.makeVideo(ch, month, 0, { provider: "mock" });
    await c.projectService.cancel(projectId);
    await c.projectService.idle();
    expect((await c.projectService.get(projectId)).input).toMatchObject({ lengthSeconds: 300, sceneCount: 30, songSeconds: 300 });
  });

  it("fails clearly when the AI plans too few videos", async () => {
    const mock = new MockProvider();
    const text = mock.text.bind(mock);
    mock.text = (async (kind: string, prompt: string, opts: Parameters<MockProvider["text"]>[2]) => {
      const out = await text(kind as "plan", prompt, opts);
      return kind === "plan" ? { ...out, ideas: out.ideas.slice(0, 2) } : out;
    }) as MockProvider["text"];
    c = await makeTestContainer({ provider: () => mock });
    const ch = await newChannel();
    await expect(c.planService.generate(ch, `${new Date().getFullYear() + 1}-03`, settings, { provider: "mock" })).rejects.toBeInstanceOf(DomainError);
  });
});

describe("plan HTTP API", () => {
  it("previews slots, generates, and downloads the calendar", async () => {
    c = await makeTestContainer();
    const ch = await newChannel();
    const server: http.Server = createApp(c);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const month = `${new Date().getFullYear() + 1}-04`;
    try {
      const slots = await (await fetch(`${base}/api/channels/${ch}/plans/${month}/slots`, json("POST", { input: { postDays: [6] } }))).json();
      expect(slots.every((s: { time: string }) => s.time === "09:00")).toBe(true);
      expect((await fetch(`${base}/api/channels/${ch}/plans/2026-13/slots`, json("POST", { input: { postDays: [6] } }))).status).toBe(400);
      expect((await fetch(`${base}/api/channels/${ch}/plans/${month}`)).status).toBe(404);
      const plan = await (await fetch(`${base}/api/channels/${ch}/plans/${month}/generate`, json("POST", { input: settings, provider: "mock" }))).json();
      expect(plan.ideas.length).toBeGreaterThan(10);
      const ics = await fetch(`${base}/api/channels/${ch}/plans/${month}/calendar.ics`);
      expect(ics.headers.get("content-type")).toContain("text/calendar");
      expect(ics.headers.get("content-disposition")).toContain(`posting-plan-${month}.ics`);
      expect((await ics.text()).match(/BEGIN:VEVENT/g)).toHaveLength(plan.ideas.length);
      expect(await (await fetch(`${base}/api/channels/${ch}/plans/last-input`)).json()).toMatchObject({ channelName: "Milcah's World", postDays: [2, 4, 6] });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }, 60_000);
});
