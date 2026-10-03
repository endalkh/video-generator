import { ConflictError, NotFoundError } from "../domain/errors.js";
import { KIDS_SYLLABLES_PER_SEC, LANGUAGE_NAMES, SONG_FRAME_SEC } from "../domain/ports/generator.port.js";
import { SECONDS_PER_SCENE, type ProjectInput, type Singer } from "../domain/project/project.model.js";
import { SCENE_TAIL_SEC } from "../infrastructure/media/ffmpeg.js";
import { DEFAULT_PROMPTS, promptDefinition } from "../domain/prompt/prompt.defaults.js";
import { Prompt, PromptSet, SHARED } from "../domain/prompt/prompt.entity.js";
import { PromptMapper, type PromptDto, type PromptRevisionDto } from "../domain/prompt/prompt.mapper.js";
import type { PromptRepository } from "../repositories/repositories.js";

/**
 * Use cases for the editable prompt library. Every channel uses the SHARED prompts unless it has its own copy:
 * editing a prompt for a channel creates that copy (versioned like any prompt); "use the shared prompt" deletes it.
 * Methods take `channel` (a channel id); without one they work on the shared prompts.
 */
export class PromptService {
  constructor(private readonly prompts: PromptRepository) {}

  /**
   * Insert built-in prompts that are missing (first run, or new prompts added in code), and upgrade shared prompts
   * that still hold an older built-in default (never edited by the user) to the current default.
   */
  async seedDefaults(): Promise<number> {
    let added = 0;
    for (const def of DEFAULT_PROMPTS) {
      const p = Prompt.fromDefault(def);
      if (await this.prompts.createIfMissing(p, p.initialRevision())) {
        added++;
        continue;
      }
      const stored = await this.prompts.findByKey(SHARED, def.key);
      if (stored && def.previousTemplates?.includes(stored.template)) {
        const previous = stored.version;
        const revision = stored.revise(def.template, "built-in default updated");
        if (revision) await this.prompts.saveRevision(stored, revision, previous).catch(() => {}); // another process got there first
      }
    }
    return added;
  }

  /** The prompts a channel uses, in pipeline order: its own copies, else the shared ones. */
  async list(channel?: string | null): Promise<PromptDto[]> {
    const map = await this.effective(channel);
    return DEFAULT_PROMPTS.flatMap((d) => (map.has(d.key) ? [PromptMapper.toDto(map.get(d.key)!)] : []));
  }

  async get(key: string, channel?: string | null): Promise<PromptDto> {
    return PromptMapper.toDto(await this.load(key, channel));
  }

  /**
   * Save an edited template as a new version (validated; no-op if unchanged). With a channel, only that
   * channel's copy changes (made from the shared prompt the first time); other channels are unaffected.
   */
  async update(key: string, template: string, opts: { note?: string; expectedVersion?: number; channel?: string | null } = {}): Promise<PromptDto> {
    const prompt = await this.load(key, opts.channel);
    const previous = prompt.version;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== previous) {
      throw new ConflictError(`Prompt "${key}" is now at v${previous} (you edited v${opts.expectedVersion}); reload to see the latest`);
    }
    if (opts.channel && prompt.channelId !== opts.channel) {
      // First edit for this channel: copy the shared prompt, then save the edit on top of the copy.
      const draft = Prompt.copyFor(opts.channel, prompt);
      const revision = draft.revise(template, opts.note ?? null); // validates
      if (!revision) return PromptMapper.toDto(prompt);
      const copy = Prompt.copyFor(opts.channel, prompt);
      await this.prompts.createIfMissing(copy, copy.initialRevision(`copied from the shared prompt v${prompt.version}`));
      await this.prompts.saveRevision(draft, revision, 1);
      return PromptMapper.toDto(draft);
    }
    const revision = prompt.revise(template, opts.note ?? null);
    if (revision) await this.prompts.saveRevision(prompt, revision, previous);
    return PromptMapper.toDto(prompt);
  }

  /**
   * Shared prompt: back to the built-in default (as a new version). Channel: drop the channel's own copy,
   * so it uses the shared prompt again.
   */
  async reset(key: string, channel?: string | null): Promise<PromptDto> {
    promptDefinition(key);
    if (channel) {
      await this.prompts.deleteChannelCopies(channel, key);
      return PromptMapper.toDto(await this.load(key));
    }
    const prompt = await this.load(key);
    const previous = prompt.version;
    const revision = prompt.resetToDefault();
    if (revision) await this.prompts.saveRevision(prompt, revision, previous);
    return PromptMapper.toDto(prompt);
  }

  /** Restore an older version of the prompt the channel uses (recorded as a new version, so it can be undone too). */
  async restore(key: string, version: number, channel?: string | null): Promise<PromptDto> {
    const current = await this.load(key, channel);
    const old = (await this.prompts.history(current.channelId, key, 1000)).find((r) => r.version === version);
    if (!old) throw new NotFoundError(`Prompt "${key}" has no version ${version}`);
    return this.update(key, old.template, { note: `restored v${version}`, channel });
  }

  /** History of the prompt the channel uses (its own copy, else the shared prompt). */
  async history(key: string, channel?: string | null): Promise<PromptRevisionDto[]> {
    const current = await this.load(key, channel);
    return (await this.prompts.history(current.channelId, key)).map(PromptMapper.revisionToDto);
  }

  /** Preview a (possibly unsaved) template with sample values, so editors see exactly what the model receives. */
  async preview(key: string, template: string | undefined, input: ProjectInput, channel?: string | null): Promise<string> {
    const current = await this.load(key, channel);
    const map = await this.effective(channel);
    if (template !== undefined) {
      const draft = Prompt.restore(current.toProps());
      draft.revise(template);
      map.set(key, draft);
    }
    const set = PromptService.buildSet(map, input);
    return set.render(key, SAMPLE_VARS).text;
  }

  /** Snapshot every prompt for one run (the channel's prompts), bound to the project's shared variables. */
  async snapshotFor(input: ProjectInput, extra: SnapshotExtras = {}): Promise<PromptSet> {
    return PromptService.buildSet(await this.effective(extra.channel), input, extra);
  }

  /** Give a channel its own copies of the shared prompts the user edited, and reset the shared ones to the defaults. */
  async moveSharedEditsTo(channel: string): Promise<number> {
    let moved = 0;
    for (const shared of await this.prompts.list(SHARED)) {
      if (shared.isDefault || (await this.prompts.findByKey(channel, shared.key))) continue;
      const copy = Prompt.copyFor(channel, shared);
      await this.prompts.createIfMissing(copy, copy.initialRevision(`your edit (shared v${shared.version}), moved to this channel`));
      await this.reset(shared.key);
      moved++;
    }
    return moved;
  }

  /** Forget a channel's own prompt copies (when the channel is deleted). */
  async deleteChannel(channel: string): Promise<number> {
    return this.prompts.deleteChannelCopies(channel);
  }

  private async effective(channel?: string | null): Promise<Map<string, Prompt>> {
    const map = new Map((await this.prompts.list(SHARED)).map((p) => [p.key, p]));
    if (channel) for (const p of await this.prompts.list(channel)) map.set(p.key, p);
    return map;
  }

  private static buildSet(map: Map<string, Prompt>, input: ProjectInput, extra: SnapshotExtras = {}): PromptSet {
    return new PromptSet(
      map,
      {
        topic: input.topic,
        language_name: extra.languageName ?? LANGUAGE_NAMES[input.language],
        age_range: input.ageRange,
        style: input.style,
        scene_count: input.sceneCount,
        character_hint: input.characterHint ?? "",
        song_seconds: extra.songSeconds ?? input.songSeconds,
        video_seconds: videoSeconds(input, extra.songSeconds),
        // Ge'ez: one letter (fidel) is ~0.8 syllable (see estimateSyllables), so a line can have a few more letters.
        letters_per_line: Math.round(syllablesPerLine(input, extra.songSeconds) / 0.8),
        singer: SINGER_TEXT[input.singer],
        voice_style: VOICE_STYLE[input.singer],
        audio_request: input.audioRequest ?? "",
        // Song: 2 lines per stanza sung at a clear kids' pace within the song length.
        // Narration: 4 lines per stanza read slowly, with a short pause after each scene.
        syllables_per_line: syllablesPerLine(input, extra.songSeconds),
      },
      {
        am: input.language === "am",
        en: input.language === "en",
        song: input.audioMode === "song",
        narration: input.audioMode === "narration",
        music_voice: input.audioMode === "music_voice",
        character_voice: input.audioMode === "character",
        has_audio_request: Boolean(input.audioRequest),
        veo: input.videoMode === "veo",
        has_character_hint: Boolean(input.characterHint?.trim()),
        has_reference: false,
        has_channel_name: false,
        has_title: false,
        ...extra.flags,
      },
    );
  }

  /** The prompt a channel uses: its own copy, else the shared one. */
  private async load(key: string, channel?: string | null): Promise<Prompt> {
    promptDefinition(key);
    const p = (channel ? await this.prompts.findByKey(channel, key) : undefined) ?? (await this.prompts.findByKey(SHARED, key));
    if (!p) throw new NotFoundError(`Prompt "${key}" is not in the database yet`);
    return p;
  }
}

/**
 * Longest line that can still be sung / read clearly in the time: song = 2 lines per stanza at a kids' pace;
 * narration and rhyme over music = 4 lines per stanza with a short pause after each scene.
 */
function syllablesPerLine(input: ProjectInput, songSeconds?: number): number {
  return input.audioMode === "song"
    ? Math.max(4, Math.floor(((songSeconds ?? input.songSeconds) - SONG_FRAME_SEC) * KIDS_SYLLABLES_PER_SEC / (input.sceneCount * 2)))
    : Math.max(4, Math.min(14, Math.floor((videoSeconds(input) - input.sceneCount * SCENE_TAIL_SEC) * KIDS_SYLLABLES_PER_SEC / (input.sceneCount * (input.audioMode === "character" ? 2 : 4)))));
}

/** How the music prompt describes the singer (music models have no voice setting). */
const SINGER_TEXT: Record<Singer, string> = {
  auto: "one clear, warm, friendly vocalist",
  woman: "one clear, warm, friendly female vocalist (a young woman)",
  man: "one clear, warm, friendly male vocalist (a young man)",
  girl: "one young girl (about 8 years old) with a bright, sweet, natural child's voice",
  boy: "one young boy (about 8 years old) with a bright, cheerful, natural child's voice",
  kids: "a small, joyful children's choir singing together in unison",
};
/** How the speech prompt describes the voice (on top of the chosen prebuilt voice). */
const VOICE_STYLE: Record<Singer, string> = {
  auto: "a warm, friendly storyteller",
  woman: "a warm, friendly young woman",
  man: "a warm, friendly young man",
  girl: "a cheerful little girl, bright and childlike",
  boy: "a cheerful little boy, bright and childlike",
  kids: "a cheerful, playful child",
};

/** Target video length: the chosen length, else the song length (song) or ~12 s per scene (narration). */
function videoSeconds(input: ProjectInput, songSeconds?: number): number {
  return input.lengthSeconds ?? (input.audioMode === "song" ? (songSeconds ?? input.songSeconds) : input.sceneCount * SECONDS_PER_SCENE[input.audioMode]);
}

/** Extra inputs for a prompt snapshot: the song length, and the Channel page's language and flags. */
export interface SnapshotExtras {
  /** Use this channel's prompts (its own copies, else the shared ones). */
  channel?: string | null;
  songSeconds?: number;
  /** Overrides {{language_name}} (e.g. bilingual channel text). */
  languageName?: string;
  flags?: Partial<Record<"am" | "en" | "has_reference" | "has_channel_name" | "has_title", boolean>>;
}

/** Placeholder values for step-specific variables in previews. */
const SAMPLE_VARS = {
  channel_name: "Happy Little Learners",
  thumbnail_title: "Wash Your Hands!",
  part_note: "",
  poem_text: "1. Wash, wash, wash your hands,\n   bubbles big and small!\n2. …",
  stanza_number: 1,
  stanza_text: "Wash, wash, wash your hands,\nbubbles big and small!",
  line_count: 2,
  hint: "(nothing specific: make it better)",
  month_name: "November 2026",
  schedule: "1. Tue 3 Nov 2026, 16:00 (Amharic)\n2. Sat 7 Nov 2026, 09:00 (English)\n…",
  video_count: 12,
  notes: "(none)",
  previous_topics: "(none yet)",
  video_length: "about 5 minutes",
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
