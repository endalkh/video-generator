import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "../src/domain/errors.js";
import { songTimeline, mmss } from "../src/domain/ports/generator.port.js";
import { Project } from "../src/domain/project/project.entity.js";
import { ProjectInputSchema } from "../src/domain/project/project.model.js";
import { DEFAULT_PROMPTS, PROMPT_FLAGS, allowedVars, promptDefinition } from "../src/domain/prompt/prompt.defaults.js";
import { Prompt } from "../src/domain/prompt/prompt.entity.js";
import { renderTemplate, validateTemplate } from "../src/domain/prompt/prompt.template.js";

const input = ProjectInputSchema.parse({ topic: "brushing teeth" });

describe("ProjectInput", () => {
  it("applies defaults", () => {
    expect(input).toMatchObject({ language: "en", audioMode: "song", videoMode: "still", sceneCount: 4, aspectRatio: "16:9" });
  });
  it("rejects bad scene counts", () => {
    expect(ProjectInputSchema.safeParse({ topic: "abc", sceneCount: 40 }).success).toBe(false);
  });
});

describe("Project entity", () => {
  it("enforces step order and invalidates later steps on redo", () => {
    const p = Project.create({ id: "brushing-teeth", input, provider: "mock" });
    expect(p.nextStep).toBe("poem");
    expect(() => p.completeStep("scenes")).toThrow(ConflictError);
    p.completeStep("poem");
    p.completeStep("scenes");
    p.completeStep("character");
    p.redoFrom("scenes");
    expect(p.completed).toEqual(["poem"]);
    expect(() => p.finish()).toThrow(ConflictError);
  });
  it("tracks run status", () => {
    const p = Project.create({ id: "x-1", input, provider: "mock" });
    p.start("gemini");
    expect(p.provider).toBe("gemini");
    expect(() => p.start("mock")).toThrow(ConflictError);
    p.fail("boom");
    expect([p.status, p.error]).toEqual(["failed", "boom"]);
  });
  it("validates id and input", () => {
    expect(() => Project.create({ id: "Bad Id!", input, provider: "mock" })).toThrow(ValidationError);
    expect(() => Project.create({ id: "ok", input: { topic: "x" } as never, provider: "mock" })).toThrow(ValidationError);
  });
  it("normalises scene indices", () => {
    const p = Project.create({ id: "s", input, provider: "mock" });
    p.setScenes({ scenes: [{ index: 5, text: "a", visualPrompt: "b", motion: "static" }, { index: 9, text: "c", visualPrompt: "d", motion: "zoom-in" }] });
    expect(p.scenes!.scenes.map((s) => s.index)).toEqual([0, 1]);
  });
});

describe("prompt templates", () => {
  it("renders variables and conditionals", () => {
    const t = "Hi {{name}}.{{#if am}} ሰላም{{else}} Hello{{/if}}!";
    expect(renderTemplate(t, { name: "Abeba" }, { am: true })).toBe("Hi Abeba. ሰላም!");
    expect(renderTemplate(t, { name: "Abeba" }, { am: false })).toBe("Hi Abeba. Hello!");
  });
  it("fails loudly on typos", () => {
    expect(() => renderTemplate("{{tpoic}}", { topic: "x" })).toThrow(/unknown variable/);
    expect(() => renderTemplate("{{#if amharic}}x{{/if}}", {}, { am: true })).toThrow(/unknown flag/);
    expect(validateTemplate("{{#if am}}x", ["topic"], ["am"])).toEqual([expect.stringMatching(/unbalanced/)]);
  });
  it("ships defaults that are all valid", () => {
    for (const d of DEFAULT_PROMPTS) expect(validateTemplate(d.template, allowedVars(d.key), PROMPT_FLAGS), d.key).toEqual([]);
  });
});

describe("Prompt entity", () => {
  it("versions edits and ignores no-op saves", () => {
    const p = Prompt.fromDefault(promptDefinition("poem"));
    expect(p.isDefault).toBe(true);
    expect(p.revise(p.template)).toBeNull();
    const rev = p.revise("Write about {{topic}} in {{language_name}}.", "shorter");
    expect(rev).toMatchObject({ version: 2, note: "shorter" });
    expect(p.isDefault).toBe(false);
    expect(p.resetToDefault()!.version).toBe(3);
    expect(p.isDefault).toBe(true);
  });
  it("rejects templates using variables the step doesn't provide", () => {
    const p = Prompt.fromDefault(promptDefinition("poem"));
    expect(() => p.revise("{{visual_prompt}}")).toThrow(ValidationError);
    expect(p.version).toBe(1);
  });
});

describe("songTimeline", () => {
  it("covers the whole song contiguously, weighted by lyric length", () => {
    const slots = songTimeline([{ text: "short" }, { text: "a much much longer verse" }, { text: "mid verse" }], 30);
    expect(slots[0]!.start).toBe(0);
    expect(slots.at(-1)!.end).toBe(30);
    for (let i = 1; i < slots.length; i++) expect(slots[i]!.start).toBeCloseTo(slots[i - 1]!.end);
    expect(slots[1]!.end - slots[1]!.start).toBeGreaterThan(slots[2]!.end - slots[2]!.start);
  });
  it("formats m:ss", () => expect(mmss(65.4)).toBe("1:05"));
});

describe("ModelSetting entity", () => {
  it("defaults from the task definition and validates changes", async () => {
    const { ModelSetting, capabilityOf } = await import("../src/domain/model-setting/model-setting.entity.js");
    const s = ModelSetting.default("scenes");
    expect([s.model, s.isDefault]).toEqual(["gemini-3.8-flash", true]);
    s.change("models/gemini-3.1-pro-preview");
    expect([s.model, s.isDefault]).toEqual(["gemini-3.1-pro-preview", false]);
    expect(() => s.change("veo-3.1-fast-generate-preview")).toThrow(/needs a text model/);
    expect(() => s.change("bad id!")).toThrow(ValidationError);
    expect(() => ModelSetting.default("nope")).toThrow(/Unknown model task/);
    expect([capabilityOf("lyria-3.5"), capabilityOf("gemini-3.8-flash-tts"), capabilityOf("gemini-3-pro-image"), capabilityOf("text-embedding-004")]).toEqual(["music", "tts", "image", undefined]);
  });
});
