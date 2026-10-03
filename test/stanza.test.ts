import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "../src/domain/errors.js";
import { makeTestContainer, mockProvider } from "./helpers.js";

let c: Awaited<ReturnType<typeof makeTestContainer>>;
afterEach(async () => c?.cleanup());

describe("rewriting one stanza", () => {
  it("rewrites only that stanza, in context, using the wish; nothing is saved until the poem is saved", async () => {
    const mock = mockProvider();
    c = await makeTestContainer({ provider: () => mock });
    const p = await c.projectService.create({ topic: "Washing hands", sceneCount: 3, reviewMode: "manual" }, "mock");
    await expect(c.projectService.rewriteStanza(p.id, 0)).rejects.toBeInstanceOf(ConflictError); // no poem yet
    await c.projectService.start(p.id);
    await c.projectService.idle();
    const before = (await c.projectService.get(p.id)).poem!;

    // A draft with an unsaved edit in stanza 3: the rewrite sees it.
    const draft = { ...before, stanzas: before.stanzas.map((s, i) => (i === 2 ? { lines: ["My own unsaved line", "and another"] } : s)) };
    const r = await c.projectService.rewriteStanza(p.id, 0, { draft, hint: "mention the soap", provider: "mock" });
    expect(r).toEqual({ index: 0, lines: ["A brand new verse 1", "We sing it all day long"] });
    const prompt = mock.prompts.filter((x) => x.kind === "stanza").at(-1)!.prompt;
    expect(prompt).toContain("Write a new stanza 1 to replace:\n" + before.stanzas[0]!.lines.join("\n"));
    expect(prompt).toContain("My own unsaved line");
    expect(prompt).toContain("What the parent wants changed: mention the soap");
    expect(prompt).toContain(`Exactly ${before.stanzas[0]!.lines.length} short lines`);
    expect((await c.projectService.get(p.id)).poem).toEqual(before); // not saved

    const gens = await c.projectService.generationsOf(p.id);
    expect(gens.find((g) => g.promptKey === "poem_stanza")).toMatchObject({ step: "poem", sceneIndex: 0 });
    await expect(c.projectService.rewriteStanza(p.id, 7)).rejects.toBeInstanceOf(ValidationError);
  }, 60_000);
});
