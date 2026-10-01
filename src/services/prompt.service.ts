import { ConflictError, NotFoundError } from "../domain/errors.js";
import { LANGUAGE_NAMES } from "../domain/ports/generator.port.js";
import type { ProjectInput } from "../domain/project/project.model.js";
import { DEFAULT_PROMPTS, promptDefinition } from "../domain/prompt/prompt.defaults.js";
import { Prompt, PromptSet } from "../domain/prompt/prompt.entity.js";
import { PromptMapper, type PromptDto, type PromptRevisionDto } from "../domain/prompt/prompt.mapper.js";
import type { PromptRepository } from "../repositories/repositories.js";

/** Use cases for the editable prompt library. */
export class PromptService {
  constructor(private readonly prompts: PromptRepository) {}

  /** Insert built-in prompts that are missing (first run, or new prompts added in code). */
  async seedDefaults(): Promise<number> {
    let added = 0;
    for (const def of DEFAULT_PROMPTS) {
      const p = Prompt.fromDefault(def);
      if (await this.prompts.createIfMissing(p, p.initialRevision())) added++;
    }
    return added;
  }

  async list(): Promise<PromptDto[]> {
    const byKey = new Map((await this.prompts.list()).map((p) => [p.key, p]));
    // Keep pipeline order.
    return DEFAULT_PROMPTS.flatMap((d) => (byKey.has(d.key) ? [PromptMapper.toDto(byKey.get(d.key)!)] : []));
  }

  async get(key: string): Promise<PromptDto> {
    return PromptMapper.toDto(await this.load(key));
  }

  /** Save an edited template as a new version (validated; no-op if unchanged). */
  async update(key: string, template: string, opts: { note?: string; expectedVersion?: number } = {}): Promise<PromptDto> {
    const prompt = await this.load(key);
    const previous = prompt.version;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== previous) {
      throw new ConflictError(`Prompt "${key}" is now at v${previous} (you edited v${opts.expectedVersion}); reload to see the latest`);
    }
    const revision = prompt.revise(template, opts.note ?? null);
    if (revision) await this.prompts.saveRevision(prompt, revision, previous);
    return PromptMapper.toDto(prompt);
  }

  async reset(key: string): Promise<PromptDto> {
    const prompt = await this.load(key);
    const previous = prompt.version;
    const revision = prompt.resetToDefault();
    if (revision) await this.prompts.saveRevision(prompt, revision, previous);
    return PromptMapper.toDto(prompt);
  }

  /** Restore an older version (recorded as a new version, so it can be undone too). */
  async restore(key: string, version: number): Promise<PromptDto> {
    const old = (await this.prompts.history(key, 1000)).find((r) => r.version === version);
    if (!old) throw new NotFoundError(`Prompt "${key}" has no version ${version}`);
    return this.update(key, old.template, { note: `restored v${version}` });
  }

  async history(key: string): Promise<PromptRevisionDto[]> {
    promptDefinition(key);
    return (await this.prompts.history(key)).map(PromptMapper.revisionToDto);
  }

  /** Preview a (possibly unsaved) template with sample values, so editors see exactly what the model receives. */
  async preview(key: string, template: string | undefined, input: ProjectInput): Promise<string> {
    const current = await this.load(key);
    const map = new Map((await this.prompts.list()).map((p) => [p.key, p]));
    if (template !== undefined) {
      const draft = Prompt.restore(current.toProps());
      draft.revise(template);
      map.set(key, draft);
    }
    const set = PromptService.buildSet(map, input);
    return set.render(key, SAMPLE_VARS).text;
  }

  /** Snapshot every prompt for one run, bound to the project's shared variables. */
  async snapshotFor(input: ProjectInput, extra: { songSeconds?: number } = {}): Promise<PromptSet> {
    const map = new Map((await this.prompts.list()).map((p) => [p.key, p]));
    return PromptService.buildSet(map, input, extra);
  }

  private static buildSet(map: Map<string, Prompt>, input: ProjectInput, extra: { songSeconds?: number } = {}): PromptSet {
    return new PromptSet(
      map,
      {
        topic: input.topic,
        language_name: LANGUAGE_NAMES[input.language],
        age_range: input.ageRange,
        style: input.style,
        scene_count: input.sceneCount,
        character_hint: input.characterHint ?? "",
        song_seconds: extra.songSeconds ?? input.songSeconds,
      },
      {
        am: input.language === "am",
        en: input.language === "en",
        song: input.audioMode === "song",
        narration: input.audioMode === "narration",
        veo: input.videoMode === "veo",
        has_character_hint: Boolean(input.characterHint?.trim()),
      },
    );
  }

  private async load(key: string): Promise<Prompt> {
    promptDefinition(key);
    const p = await this.prompts.findByKey(key);
    if (!p) throw new NotFoundError(`Prompt "${key}" is not in the database yet`);
    return p;
  }
}

/** Placeholder values for step-specific variables in previews. */
const SAMPLE_VARS = {
  title: "Clean Hands, Happy Me",
  poem_json: '{ "title": "…", "stanzas": [ { "lines": ["…"] } ] }',
  stanza_count: 4,
  character_name: "Abeba",
  character_description: "a small goat with white fur, a red scarf and big friendly eyes",
  scene_number: 1,
  scene_text: "Wash, wash, wash your hands,\nbubbles big and small!",
  visual_prompt: "On a green hillside by a clay water jug, the character scrubs soapy hands as bubbles float up",
  timed_lyrics: "[0:00 - 0:09] Short instrumental intro, then verse 1:\nWash, wash, wash your hands…\n\n[0:09 - 0:16] Verse 2:\n…",
};
