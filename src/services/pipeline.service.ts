import { readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { GenContext, Provider } from "../domain/ports/generator.port.js";
import { MAX_SONG_PART_SEC, mmss, singableSeconds, songParts, songTimeline } from "../domain/ports/generator.port.js";
import type { Project } from "../domain/project/project.entity.js";
import { defaultVoice, STEP_NAMES, type Character, type Poem, type Scene, type StepName } from "../domain/project/project.model.js";
import { ValidationError } from "../domain/errors.js";
import type { PromptSet, RenderedPrompt } from "../domain/prompt/prompt.entity.js";
import { assertFfmpegAvailable, buildSrt, concatAudio, concatClips, mixVoiceOverMusic, formatFor, probeDuration, stillToClip, videoToClip } from "../infrastructure/media/ffmpeg.js";
import type { GenerationRepository, ProjectRepository } from "../repositories/repositories.js";
import { ensureDir, fileExists, writeFileAtomic } from "../util/fs.js";
import { log } from "../util/log.js";
import type { ModelSettingsService } from "./model-settings.service.js";
import type { PromptService } from "./prompt.service.js";
import type { ModelTask } from "../domain/model-setting/model-setting.entity.js";

export type PipelineEvent =
  | { type: "step-start"; step: StepName }
  | { type: "step-skip"; step: StepName }
  | { type: "step-done"; step: StepName }
  | { type: "progress"; step: StepName; done: number; total: number; message: string }
  | { type: "review"; step: StepName }
  | { type: "stopped"; step: StepName }
  | { type: "done"; output: string; duration: number }
  | { type: "error"; message: string };

/** Manual mode: the run stops so the user can review a finished step. */
class ReviewPause extends Error {
  constructor(readonly step: StepName) {
    super(`waiting for review of ${step}`);
  }
}

/** A single-step run (`until`) finished its step. */
class StopAfter extends Error {
  constructor(readonly step: StepName) {
    super(`stopped after ${step}`);
  }
}

export class PipelineCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "PipelineCancelled";
  }
}

/** Voice over music: music alone before the first line, pause after each line, music after the last one. */
const MUSIC_INTRO_SEC = 2;
/** "The character speaks": each Veo clip is ~8 s with her own voice. */
const CHARACTER_CLIP_SEC = 8;
const VOICE_GAP_SEC = 0.6;
const MUSIC_OUTRO_SEC = 2.5;

/** On-disk layout of a project's media (text artifacts live in Postgres). */
export function mediaPaths(dir: string) {
  const sceneDir = (i: number) => path.join(dir, "scenes", String(i + 1).padStart(2, "0"));
  return {
    dir,
    characterImage: path.join(dir, "character.png"),
    srt: path.join(dir, "subtitles.srt"),
    final: path.join(dir, "final.mp4"),
    /** YouTube thumbnail for the finished video (1280×720). */
    thumbnail: path.join(dir, "thumbnail.jpg"),
    song: (ext: string) => path.join(dir, `song.${ext}`),
    /** Voice over music: the instrumental music under the voice. */
    music: (ext: string) => path.join(dir, `music.${ext}`),
    /** Long songs: part j (0-based) before they're joined into song.wav. */
    songPart: (j: number, ext: string) => path.join(dir, `song-part-${String(j + 1).padStart(2, "0")}.${ext}`),
    sceneDir,
    sceneAudio: (i: number) => path.join(sceneDir(i), "audio.wav"),
    sceneImage: (i: number) => path.join(sceneDir(i), "image.png"),
    sceneVideo: (i: number) => path.join(sceneDir(i), "video.mp4"),
    sceneClip: (i: number) => path.join(sceneDir(i), "clip.mp4"),
  };
}
export type MediaPaths = ReturnType<typeof mediaPaths>;

/** Delete on-disk media produced by `from` and every later step, so a redo can't reuse stale files. */
export async function wipeMediaFrom(p: MediaPaths, from: StepName): Promise<void> {
  const at = (s: StepName) => STEP_NAMES.indexOf(s) >= STEP_NAMES.indexOf(from);
  const files: string[] = [];
  const perScene: ((i: number) => string)[] = [];
  if (at("character")) files.push(p.characterImage, p.thumbnail), perScene.push(p.sceneImage, p.sceneVideo);
  if (at("audio")) files.push(p.song("mp3"), p.song("wav"), p.music("mp3"), p.music("wav")), perScene.push(p.sceneAudio);
  // Pictures and Veo videos don't depend on the audio: a new song only re-times (re-renders) the clips.
  if (at("clips")) perScene.push(p.sceneClip);
  if (from === "clips") perScene.push(p.sceneImage, p.sceneVideo);
  if (at("final")) files.push(p.final, p.srt);
  if (at("audio")) {
    const top = await readdir(p.dir).catch(() => [] as string[]);
    files.push(...top.filter((f) => /^song-part-\d+\.(mp3|wav)$/.test(f)).map((f) => path.join(p.dir, f)));
  }
  const dirs = await readdir(path.join(p.dir, "scenes")).catch(() => [] as string[]);
  for (const d of dirs) {
    const i = Number(d) - 1;
    if (Number.isInteger(i) && i >= 0) files.push(...perScene.map((f) => f(i)));
  }
  await Promise.all(files.map((f) => rm(f, { force: true })));
}

/** Delete rendered clips and the final video only (keeps pictures, song and Veo videos). */
export async function wipeRenders(p: MediaPaths): Promise<void> {
  const dirs = await readdir(path.join(p.dir, "scenes")).catch(() => [] as string[]);
  const files = [p.final, p.srt];
  for (const d of dirs) {
    const i = Number(d) - 1;
    if (Number.isInteger(i) && i >= 0) files.push(p.sceneClip(i));
  }
  await Promise.all(files.map((f) => rm(f, { force: true })));
}

/** Delete every scene's picture and Veo video (e.g. after new scenes were planned). */
export async function wipePictures(p: MediaPaths): Promise<void> {
  const dirs = await readdir(path.join(p.dir, "scenes")).catch(() => [] as string[]);
  const files: string[] = [];
  for (const d of dirs) {
    const i = Number(d) - 1;
    if (Number.isInteger(i) && i >= 0) files.push(p.sceneImage(i), p.sceneVideo(i));
  }
  await Promise.all(files.map((f) => rm(f, { force: true })));
}

/** Delete one scene's picture, video and clip (plus the final video) so only that scene is made again. */
export async function wipeScene(p: MediaPaths, i: number): Promise<void> {
  await Promise.all([p.sceneImage(i), p.sceneVideo(i), p.sceneClip(i), p.final, p.srt].map((f) => rm(f, { force: true })));
}

/** Run async tasks with bounded parallelism, preserving result order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export interface RunOptions {
  provider: Provider;
  from?: StepName;
  /** Stop after this step instead of running to the final video (generate one step on its own). */
  until?: StepName;
  concurrency?: number;
  signal?: AbortSignal;
  onEvent?: (e: PipelineEvent) => void;
}

/**
 * topic → poem → scenes → character → audio → clips → final.mp4
 *
 * Progress and text artifacts are saved to Postgres after every step; media is written to disk as it's produced.
 * A crashed or stopped run resumes where it left off, down to individual scenes.
 */
export class PipelineService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly generations: GenerationRepository,
    private readonly promptService: PromptService,
    private readonly modelSettings: ModelSettingsService,
    private readonly mediaRoot: string,
  ) {}

  /** Set by the container: make the YouTube upload info after the final video. */
  afterFinal?: (project: Project, provider: Provider) => Promise<void>;

  mediaDir(projectId: string): string {
    return path.join(this.mediaRoot, projectId);
  }

  /** Ask the character model to name and describe an uploaded character picture (logged like any other prompt). */
  async describeCharacter(project: Project, picture: Buffer, provider: Provider, name?: string): Promise<Character> {
    const [models, prompts] = await Promise.all([this.modelSettings.snapshot(), this.promptService.snapshotFor(project.input, { channel: project.channelId })]);
    const r = prompts.render("character_from_image", { character_name: name || "(none given)" });
    await this.generations.add({ projectId: project.id, step: "character", sceneIndex: null, promptKey: r.key, promptVersion: r.version, prompt: r.text, provider: provider.name, model: models.character });
    const out = await provider.text("character", r.text, { model: models.character, images: [picture], ctx: { input: project.input, poem: project.poem ?? undefined } });
    return name ? { ...out, name } : out;
  }

  /**
   * Write one stanza (= one scene's words) again, keeping the rest of the poem. `poem` may be an unsaved draft
   * from the editor. Returns the new lines; nothing is saved (the user checks them and saves the poem).
   */
  async rewriteStanza(project: Project, poem: Poem, index: number, provider: Provider, hint?: string): Promise<string[]> {
    const stanza = poem.stanzas[index];
    if (!stanza) throw new ValidationError(`The poem has no stanza ${index + 1}`);
    const [models, prompts] = await Promise.all([this.modelSettings.snapshot(), this.promptService.snapshotFor(project.input, { channel: project.channelId })]);
    const r = prompts.render("poem_stanza", {
      title: poem.title,
      poem_text: poem.stanzas.map((s, i) => `${i + 1}. ${s.lines.join("\n   ")}`).join("\n"),
      stanza_number: index + 1,
      stanza_text: stanza.lines.join("\n"),
      line_count: stanza.lines.length,
      hint: hint?.trim() ? hint.trim().slice(0, 500) : "(nothing specific: write a fresh, better version)",
    });
    await this.generations.add({ projectId: project.id, step: "poem", sceneIndex: index, promptKey: r.key, promptVersion: r.version, prompt: r.text, provider: provider.name, model: models.poem });
    const out = await provider.text("stanza", r.text, { model: models.poem, ctx: { input: project.input, poem, stanzaIndex: index } });
    const lines = out.lines.map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error("The AI returned an empty stanza; try again");
    return lines;
  }

  /** Returns the final video path, or null when the run stopped for a review or after `until`. */
  async run(project: Project, opts: RunOptions): Promise<string | null> {
    const { provider, signal } = opts;
    const emit = opts.onEvent ?? (() => {});
    const concurrency = opts.concurrency ?? 2;
    const p = mediaPaths(this.mediaDir(project.id));
    const input = project.input;
    const checkCancel = () => {
      if (signal?.aborted) throw new PipelineCancelled();
    };
    const save = () => this.projects.save(project);

    project.start(provider.name);
    if (opts.from) project.redoFrom(opts.from);
    // An explicit redo from the poem or scenes means "plan new scenes", not "re-word the old ones".
    if (opts.from && STEP_NAMES.indexOf(opts.from) <= STEP_NAMES.indexOf("scenes")) project.forgetScenes();
    await save();

    try {
      await ensureDir(p.dir);
      if (opts.from) await wipeMediaFrom(p, opts.from);
      await assertFfmpegAvailable();
      // One prompt snapshot per run: edits made in the UI mid-run apply to the next run.
      // Same for models: the Settings page choices at the moment the run starts.
      const models = await this.modelSettings.snapshot();
      // Lyria 3 Clip (and the offline mock) always make a fixed length; Lyria 3 Pro / 3.5 follow the prompt.
      const fixedSongLength = provider.songLengthSec ?? (/^lyria-3(\.\d+)?-clip/.test(models.song) ? 30 : undefined);
      // With a chosen video length, long songs are made in parts; without one, a fixed-length model sets it.
      const songSeconds = input.lengthSeconds ?? fixedSongLength ?? input.songSeconds;
      const prompts: PromptSet = await this.promptService.snapshotFor(input, { songSeconds, channel: project.channelId });

      /** Render a prompt for a model task and record exactly what was sent to which model. */
      const prompt = async (
        step: StepName,
        key: string,
        task: ModelTask,
        vars: Record<string, string | number | undefined> = {},
        sceneIndex?: number,
      ): Promise<RenderedPrompt & { model: string }> => {
        const r = prompts.render(key, vars);
        const model = models[task];
        await this.generations.add({ projectId: project.id, step, sceneIndex: sceneIndex ?? null, promptKey: r.key, promptVersion: r.version, prompt: r.text, provider: provider.name, model });
        log.debug(`[${step}] prompt ${key} v${r.version} → ${model}:\n${r.text}`);
        return { ...r, model };
      };

      /** Runs a step unless it's checkpointed and its outputs still exist. */
      const step = async (name: StepName, outputsOk: () => Promise<boolean>, produce: () => Promise<void>) => {
        checkCancel();
        if (project.isStepDone(name) && (await outputsOk())) {
          emit({ type: "step-skip", step: name });
          log.step(name, "checkpoint found, skipping");
          if (project.needsReview(name)) throw new ReviewPause(name);
          if (name === opts.until) throw new StopAfter(name);
          return;
        }
        project.redoFrom(name); // redoing a step invalidates everything after it
        emit({ type: "step-start", step: name });
        log.step(name, "running…");
        await produce();
        project.completeStep(name);
        await save();
        emit({ type: "step-done", step: name });
        if (project.needsReview(name)) throw new ReviewPause(name);
        if (name === opts.until) throw new StopAfter(name);
      };
      const allExist = (files: string[]) => async () => (await Promise.all(files.map(fileExists))).every(Boolean);
      const ctx = (extra: Partial<GenContext> = {}): GenContext => ({ input, poem: project.poem ?? undefined, ...extra });

      await step("poem", async () => project.poem !== null, async () => {
        const r = await prompt("poem", "poem", "poem");
        // One stanza per scene. Models sometimes miscount, so ask up to 3 times, then show a clear error.
        let poem = await provider.text("poem", r.text, { model: r.model, ctx: ctx() });
        for (let attempt = 1; poem.stanzas.length !== input.sceneCount && attempt < 3; attempt++) {
          log.warn(`poem has ${poem.stanzas.length} stanzas, expected ${input.sceneCount}; asking again`);
          poem = await provider.text("poem", r.text, { model: r.model, ctx: ctx() });
        }
        if (poem.stanzas.length !== input.sceneCount) {
          throw new Error(`The poem has ${poem.stanzas.length} stanzas but the video has ${input.sceneCount} scenes. Check that the Poem prompt asks for exactly {{scene_count}} stanzas and doesn't name a fixed number.`);
        }
        project.setPoem(poem);
        log.step("poem", `"${project.poem!.title}" (${project.poem!.stanzas.length} stanzas)`);
      });

      await step("scenes", async () => project.scenes !== null, async () => {
        const poem = project.poem!;
        // New words, same pictures: scenes kept on purpose get the new stanzas; no AI call, no new pictures.
        if (project.scenes?.scenes.length === poem.stanzas.length) {
          project.rewordScenes();
          log.step("scenes", "kept the scenes, put the new words in");
          return;
        }
        const r = await prompt("scenes", "scenes", "scenes", { poem_json: JSON.stringify(poem, null, 2), stanza_count: poem.stanzas.length });
        project.setScenes(await provider.text("scenes", r.text, { model: r.model, ctx: ctx() }));
        log.step("scenes", `${project.scenes!.scenes.length} scenes planned`);
      });
      const scenes = project.scenes!.scenes;

      await step("character", async () => project.character !== null && (await fileExists(p.characterImage)), async () => {
        // Reuse a character the user edited (or kept); only generate one when there is none.
        let character = project.character;
        if (!character) {
          const r = await prompt("character", "character", "character", { title: project.poem!.title });
          character = await provider.text("character", r.text, { model: r.model, ctx: ctx() });
          project.setCharacter(character);
          await save();
        }
        checkCancel();
        if (!(await fileExists(p.characterImage))) {
          const ri = await prompt("character", "character_image", "character_image", { character_name: character.name, character_description: character.description });
          await writeFileAtomic(p.characterImage, await provider.image(ri.text, { model: ri.model, aspectRatio: "1:1", label: "character image", ctx: ctx() }));
        }
        log.step("character", `${character.name}: ${character.description}`);
      });
      const character = project.character!;

      /** Per-scene work: skip any scene whose artifact already exists (fine-grained resume). */
      const perScene = async (name: StepName, file: (i: number) => string, verb: string, make: (s: Scene) => Promise<void>) => {
        let done = 0;
        const report = (message: string) => emit({ type: "progress", step: name, done, total: scenes.length, message });
        report("starting");
        // Veo allows only a few requests per minute, so make clips one at a time.
        const limit = name === "clips" && input.videoMode === "veo" ? 1 : concurrency;
        await mapLimit(scenes, limit, async (s) => {
          checkCancel();
          if (!(await fileExists(file(s.index)))) {
            await ensureDir(p.sceneDir(s.index));
            await make(s);
          }
          done++;
          log.step(name, `scene ${s.index + 1}/${scenes.length} ${verb}`);
          report(`scene ${s.index + 1} ${verb}`);
        });
      };

      const songMode = input.audioMode === "song" && typeof provider.song === "function";
      if (input.audioMode === "song" && !songMode) log.warn(`Provider "${provider.name}" has no song model; singing each scene with TTS`);

      // A song file (sung, voice over music, or your own uploaded recording) counts as the audio when it exists.
      const songFileOk = async () => project.song !== null && (await fileExists(path.join(p.dir, project.song.file)));
      const voice = input.voice ?? defaultVoice(input.singer, input.audioMode);
      const voiceScenes = () => perScene("audio", p.sceneAudio, "voiced", async (s) => {
        const r = await prompt("audio", "scene_speech", "narration", { scene_number: s.index + 1, scene_text: s.text }, s.index);
        await writeFileAtomic(p.sceneAudio(s.index), await provider.speech(r.text, { model: r.model, voice, label: `scene ${s.index + 1} audio`, ctx: ctx({ scene: s }) }));
      });

      const musicFile = async () => (await Promise.all(["mp3", "wav"].map(async (ext) => ((await fileExists(p.music(ext))) ? p.music(ext) : null)))).find(Boolean) ?? undefined;
      if (input.audioMode === "character") {
        // Her voice is made by Veo in each clip (lip-sync). Here: only soft background music, if the provider can make music.
        await step("audio", async () => typeof provider.song !== "function" || Boolean(await musicFile()), async () => {
          project.setSong(null);
          if (typeof provider.song !== "function" || (await musicFile())) return;
          const seconds = Math.min(fixedSongLength ?? MAX_SONG_PART_SEC, scenes.length * CHARACTER_CLIP_SEC + 2);
          emit({ type: "progress", step: "audio", done: 0, total: 1, message: "composing soft background music" });
          const r = await prompt("audio", "music_bed", "song", { title: project.poem!.title, song_seconds: seconds });
          const music = await provider.song(r.text, { model: r.model, label: "background music", durationSec: seconds, ctx: ctx() });
          await writeFileAtomic(p.music(music.ext), music.audio);
          log.step("audio", "background music ready (the character's voice is made with each Veo clip)");
        });
      } else if (project.song?.source === "upload") {
        // Your own recording: nothing to generate (re-check it's still there).
        await step("audio", songFileOk, async () => {
          throw new Error("The uploaded recording is missing; upload it again on the Audio page");
        });
      } else if (input.audioMode === "music_voice") {
        await step("audio", songFileOk, async () => {
          if (typeof provider.song !== "function") throw new Error(`Provider "${provider.name}" can't make music; choose Narrated story or another provider`);
          // 1. The voice: each scene's rhyme, chanted clearly by the speech model.
          await voiceScenes();
          checkCancel();
          const durations = await Promise.all(scenes.map((s) => probeDuration(p.sceneAudio(s.index))));
          const slots: { start: number; end: number }[] = [];
          let t = MUSIC_INTRO_SEC;
          durations.forEach((d, i) => {
            slots.push({ start: i === 0 ? 0 : t, end: t + d + VOICE_GAP_SEC });
            t += d + VOICE_GAP_SEC;
          });
          const total = t + MUSIC_OUTRO_SEC;
          slots[slots.length - 1]!.end = total;
          // 2. The music: one instrumental piece (any length the model makes), looped under the voice.
          const bedLength = Math.min(fixedSongLength ?? MAX_SONG_PART_SEC, Math.ceil(total));
          let bed = (await Promise.all(["mp3", "wav"].map(async (ext) => ((await fileExists(p.music(ext))) ? p.music(ext) : null)))).find(Boolean);
          if (!bed) {
            emit({ type: "progress", step: "audio", done: 0, total: 1, message: "composing the music" });
            const r = await prompt("audio", "music_bed", "song", { title: project.poem!.title, song_seconds: bedLength });
            const music = await provider.song!(r.text, { model: r.model, label: "music", durationSec: bedLength, ctx: ctx() });
            bed = p.music(music.ext);
            await writeFileAtomic(bed, music.audio);
          }
          // 3. Mix: voice on top, music quieter underneath.
          emit({ type: "progress", step: "audio", done: 0, total: 1, message: "mixing the voice over the music" });
          await mixVoiceOverMusic({ voices: scenes.map((s) => p.sceneAudio(s.index)), starts: slots.map((sl, i) => (i === 0 ? MUSIC_INTRO_SEC : sl.start)), music: bed, total, out: `${p.song("wav")}.part` });
          await rename(`${p.song("wav")}.part`, p.song("wav"));
          project.setSong({ file: "song.wav", duration: total, slots, source: "music_voice" });
          log.step("audio", `voice over music ${total.toFixed(1)}s (voice ${voice})`);
        });
      } else if (songMode) {
        await step("audio", songFileOk, async () => {
          // Too many words for the length makes the singer rush and slur (worst in Amharic). Give the
          // words the time they need when the model can make longer songs; otherwise warn.
          const needed = singableSeconds(scenes.map((s) => s.text));
          let length = songSeconds;
          if (needed > songSeconds && fixedSongLength === undefined && !input.lengthSeconds) {
            length = Math.min(MAX_SONG_PART_SEC, needed);
            log.warn(`the lyrics need ~${needed}s to be sung clearly; making a ${length}s song instead of ${songSeconds}s`);
            emit({ type: "progress", step: "audio", done: 0, total: 1, message: `lyrics need ~${needed}s to be sung clearly, so the song is ${length}s` });
          } else if (needed > songSeconds) {
            log.warn(`the lyrics need ~${needed}s to be sung clearly but the song is ${songSeconds}s; expect rushed singing`);
            emit({ type: "progress", step: "audio", done: 0, total: 1, message: `lyrics need ~${needed}s but the song is only ${songSeconds}s: the singing will be rushed` });
          }
          const parts = songParts(scenes, length, { fixedLength: fixedSongLength });
          const title = project.poem!.title;
          const timedLyrics = (idx: number[], seconds: number, first: boolean) => {
            const planned = songTimeline(idx.map((i) => scenes[i]!), seconds, first ? 2 : 1);
            return idx
              .map((i, n) => `[${mmss(planned[n]!.start)} - ${mmss(planned[n]!.end)}] ${first && n === 0 ? "Short instrumental intro, then verse" : "Verse"} ${i + 1}:\n${scenes[i]!.text}`)
              .join("\n\n");
          };

          if (parts.length === 1) {
            emit({ type: "progress", step: "audio", done: 0, total: 1, message: "composing song" });
            const r = await prompt("audio", "song", "song", { title, timed_lyrics: timedLyrics(parts[0]!.scenes, length, true), song_seconds: length, part_note: "" });
            const song = await provider.song!(r.text, { model: r.model, label: "song", durationSec: length, ctx: ctx() });
            const file = p.song(song.ext);
            await writeFileAtomic(file, song.audio);
            // Re-fit the timeline to the real length the model returned.
            const duration = await probeDuration(file);
            project.setSong({ file: path.basename(file), duration, slots: songTimeline(scenes, duration), lyrics: song.lyrics });
            emit({ type: "progress", step: "audio", done: 1, total: 1, message: `song ready (${duration.toFixed(1)}s)` });
            log.step("audio", `song ${path.basename(file)} ${duration.toFixed(1)}s`);
            return;
          }

          // Longer than one request allows: make the song in parts (kept on disk, so a stopped run resumes), then join them.
          const files: string[] = [];
          const lyrics: string[] = [];
          for (const [j, part] of parts.entries()) {
            checkCancel();
            const cached = (await Promise.all(["mp3", "wav"].map(async (ext) => ((await fileExists(p.songPart(j, ext))) ? p.songPart(j, ext) : null)))).find(Boolean);
            if (cached) {
              files.push(cached);
              continue;
            }
            emit({ type: "progress", step: "audio", done: j, total: parts.length, message: `composing song part ${j + 1} of ${parts.length}` });
            const first = j === 0, last = j === parts.length - 1;
            const note = `This is part ${j + 1} of ${parts.length} of one long song; the parts are joined back to back. `
              + (first ? "Start with a short instrumental intro and set a catchy melody and chorus." : "Continue the same song: exactly the same melody, chorus, tempo, key, instruments and singer as before, with no intro.")
              + (last ? " End with a happy, clear ending." : " Do not end or fade out: stop on the beat, ready for the next part.");
            const r = await prompt("audio", "song", "song", { title, timed_lyrics: timedLyrics(part.scenes, part.seconds, first), song_seconds: part.seconds, part_note: note });
            const song = await provider.song!(r.text, { model: r.model, label: `song part ${j + 1}`, durationSec: part.seconds, ctx: ctx() });
            await writeFileAtomic(p.songPart(j, song.ext), song.audio);
            files.push(p.songPart(j, song.ext));
            if (song.lyrics) lyrics.push(song.lyrics);
          }
          const durations = await Promise.all(files.map(probeDuration));
          await concatAudio(files, `${p.song("wav")}.part`);
          await rename(`${p.song("wav")}.part`, p.song("wav"));
          let offset = 0;
          const slots = parts.flatMap((part, j) => {
            const local = songTimeline(part.scenes.map((i) => scenes[i]!), durations[j]!, j === 0 ? 2 : 1).map((s) => ({ start: s.start + offset, end: s.end + offset }));
            offset += durations[j]!;
            return local;
          });
          const duration = await probeDuration(p.song("wav"));
          slots[slots.length - 1]!.end = duration;
          project.setSong({ file: "song.wav", duration, slots, lyrics: lyrics.join("\n\n") || undefined });
          emit({ type: "progress", step: "audio", done: parts.length, total: parts.length, message: `song ready (${parts.length} parts, ${duration.toFixed(1)}s)` });
          log.step("audio", `song.wav ${duration.toFixed(1)}s from ${parts.length} parts`);
        });
      } else {
        await step("audio", allExist(scenes.map((s) => p.sceneAudio(s.index))), async () => {
          project.setSong(null);
          await voiceScenes();
        });
      }
      const timeline = project.song;

      const fmt = formatFor(input.aspectRatio);
      const useVeo = input.videoMode === "veo";
      if (useVeo && typeof provider.video !== "function") throw new Error(`Provider "${provider.name}" can't generate video clips; choose Visuals = Animated pictures or another provider`);
      const timing = (i: number) => {
        const slot = timeline?.slots[i];
        return slot ? { duration: slot.end - slot.start } : { audio: p.sceneAudio(i) };
      };

      await step("clips", allExist(scenes.map((s) => p.sceneClip(s.index))), async () => {
        const reference = await readFile(p.characterImage);
        await perScene("clips", p.sceneClip, "rendered", async (s) => {
          const i = s.index;
          const vars = { scene_number: i + 1, scene_text: s.text, visual_prompt: s.visualPrompt, character_name: character.name, character_description: character.description };
          if (!(await fileExists(p.sceneImage(i)))) {
            const r = await prompt("clips", "scene_image", "scene_image", vars, i);
            await writeFileAtomic(p.sceneImage(i), await provider.image(r.text, { model: r.model, aspectRatio: input.aspectRatio, references: [reference], label: `scene ${i + 1} image`, ctx: ctx({ scene: s }) }));
          }
          checkCancel();
          if (useVeo && !(await fileExists(p.sceneVideo(i)))) {
            const r = await prompt("clips", "scene_video", "scene_video", vars, i);
            try {
              const mp4 = await provider.video!(r.text, { model: r.model, character: reference, still: await readFile(p.sceneImage(i)), aspectRatio: input.aspectRatio, label: `scene ${i + 1} video`, ctx: ctx({ scene: s }) });
              await writeFileAtomic(p.sceneVideo(i), mp4);
            } catch (err) {
              // No fallback to pictures: surface the error so it can be fixed and retried.
              const hint = (err as { status?: number }).status === 429
                ? ` — Google's request limit for ${r.model} on your account was reached. Finished clips are kept: wait a few minutes (or until tomorrow for a daily limit), then click "Make the clips" on the Clips page. A cheaper Veo model (fast or lite, on the Models page) has higher limits.`
                : "";
              throw new Error(`Scene ${i + 1} video (${r.model}) failed: ${(err as Error).message}${hint}`);
            }
          }
          const tmpClip = `${p.sceneClip(i)}.part.mp4`;
          if (input.audioMode === "character") {
            await videoToClip({ video: p.sceneVideo(i), out: tmpClip, fmt, keepAudio: true });
          } else if (useVeo) {
            await videoToClip({ ...timing(i), video: p.sceneVideo(i), out: tmpClip, fmt });
          } else {
            await stillToClip({ ...timing(i), image: p.sceneImage(i), out: tmpClip, motion: s.motion, fmt });
          }
          await rename(tmpClip, p.sceneClip(i));
        });
      });

      await step("final", allExist([p.final]), async () => {
        const clips = scenes.map((s) => p.sceneClip(s.index));
        const durations = await Promise.all(clips.map(probeDuration));
        // The .srt is always written (handy for uploading to YouTube); it's only put in the video when asked for.
        await writeFileAtomic(p.srt, buildSrt(scenes.map((s, i) => ({ text: s.text, duration: durations[i]! }))));
        const tmp = `${p.final}.part.mp4`;
        const bed = input.audioMode === "character" ? await musicFile() : undefined;
        await concatClips({ clips, out: tmp, workDir: p.dir, srt: input.subtitles ? p.srt : undefined, language: input.language, audio: timeline ? path.join(p.dir, timeline.file) : undefined, bed });
        await rename(tmp, p.final);
        await rm(path.join(p.dir, "concat.txt"), { force: true });
      });

      // YouTube title, description, tags and thumbnail (only what's missing; never fails the video).
      if (this.afterFinal && (!project.publish || !(await fileExists(p.thumbnail)))) {
        emit({ type: "progress", step: "final", done: 1, total: 1, message: "writing the YouTube title, description, tags and thumbnail" });
        await this.afterFinal(project, provider);
      }
      project.finish();
      await save();
      const duration = await probeDuration(p.final);
      emit({ type: "done", output: p.final, duration });
      log.info(`Done: ${p.final} (${duration.toFixed(1)}s)`);
      return p.final;
    } catch (err) {
      if (err instanceof ReviewPause) {
        project.awaitReview();
        await save();
        emit({ type: "review", step: err.step });
        log.step(err.step, "ready for review");
        return null;
      }
      if (err instanceof StopAfter) {
        project.pause(null);
        await save();
        emit({ type: "stopped", step: err.step });
        log.step(err.step, "done (single step)");
        return null;
      }
      const cancelled = err instanceof PipelineCancelled;
      const message = cancelled ? "Cancelled" : (err as Error).message;
      if (cancelled) project.pause("cancelled");
      else project.fail(message);
      await save().catch((e) => log.error(`could not save project state: ${(e as Error).message}`));
      emit({ type: "error", message });
      throw err;
    }
  }
}

