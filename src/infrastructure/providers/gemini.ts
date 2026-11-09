import { isRunwayModel, RUNWAY_MODELS, RunwayVideo } from "./runway.js";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GoogleGenAI, VideoGenerationReferenceType } from "@google/genai";
import { z } from "zod";
import { pcmToWav, GEMINI_TTS_FORMAT } from "../media/wav.js";
import { ChannelDetailsSchema } from "../../domain/channel/channel.model.js";
import { PlanTextSchema } from "../../domain/plan/plan.model.js";
import { CharacterSchema, CastPlanSchema, minResolution, PoemSchema, PublishInfoSchema, ScenePlanSchema, StanzaSchema, type VideoResolution } from "../../domain/project/project.model.js";
import { log } from "../../util/log.js";
import { InferenceShVideo, inferenceShWorksWithoutPicture, isInferenceShModel } from "./inference-sh.js";
import { isTrebloModel, TREBLO_MODELS, TrebloMusic } from "./treblo.js";
import { isOpenAiModel, OPENAI_MODELS, OpenAiClient } from "./openai.js";
import { isBillingStop, isTransientError, sleep, withRetry } from "../../util/retry.js";
import { type AvailableModel, type GenContext, type Provider, type SongResult, type TextKind, type TextOutputs } from "../../domain/ports/generator.port.js";


const SCHEMAS: { [K in TextKind]: z.ZodType<TextOutputs[K]> } = { poem: PoemSchema, scenes: ScenePlanSchema, character: CharacterSchema, cast: CastPlanSchema, stanza: StanzaSchema, publish: PublishInfoSchema, channel: ChannelDetailsSchema, plan: PlanTextSchema };

type InlinePart = { inlineData?: { data?: string; mimeType?: string }; text?: string };

function firstInline(res: { candidates?: { content?: { parts?: InlinePart[] } }[] }, prefix: string): { data: Buffer; mimeType: string } {
  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    const d = part.inlineData;
    if (d?.data && (d.mimeType ?? "").startsWith(prefix)) return { data: Buffer.from(d.data, "base64"), mimeType: d.mimeType! };
  }
  throw new Error(`Gemini response contained no ${prefix}* data (possibly blocked by safety filters)`);
}

/** Highest Veo resolution per model: Veo 3.1 makes up to 4K, Lite up to 1080p, older models 720p. */
export function maxVeoResolution(model: string): VideoResolution {
  if (!/^veo-3\.1-/.test(model)) return "720p";
  return /lite/.test(model) ? "1080p" : "4k";
}

/**
 * Gemini Omni Flash video models (replaced Veo on the Gemini API). Unlike Veo, these are driven by the
 * Interactions API, not generateVideos — see omniVideo(). Clips up to 15 s with native audio; works from a
 * text prompt alone or from a first-frame picture.
 */
export const isOmniModel = (model: string) => /^gemini-omni/.test(model.replace(/^free\//, ""));
export const OMNI_MODELS: readonly AvailableModel[] = [
  { id: "gemini-omni-1.2-flash", displayName: "Gemini Omni 1.2 Flash — Google's video model (replaces Veo), up to 15 s with sound" },
];

/** Video models that only animate a scene picture, so "Skip scene pictures" can't be used with them. */
export function needsScenePicture(model: string): boolean {
  if (isInferenceShModel(model)) return !inferenceShWorksWithoutPicture(model);
  if (isOmniModel(model)) return false; // Omni makes a scene from the prompt (optionally a first-frame picture).
  return !supportsReferenceImages(model);
}

/** Nano Banana 2 / Pro (Gemini 3 image models) take an output size; older image models don't. */
export const supportsImageSize = (model: string) => /^gemini-3/.test(model) && /image/.test(model);

/** Veo 3.1 takes at most 3 "asset" reference pictures. */
const VEO_MAX_REFERENCES = 3;

/**
 * What Veo should avoid. Blur words go here rather than in the prompt: "no blur" inside a prompt still puts
 * blur in the model's mind, while the negative prompt steers away from it.
 */
export const VEO_NEGATIVE_PROMPT = "blurry background, bokeh, shallow depth of field, out-of-focus background, soft focus, defocused, rack focus, tilt-shift, haze, motion blur, low detail, text, captions, watermark";

/** Veo's 400 for a negative prompt it won't take: "Negative prompt is not supported in your use case." (Fast with
 * reference pictures) or "`negativePrompt` isn't supported by this model." (Lite). */
export function isNegativePromptRejected(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return (e?.status === 400 || /"code":\s*400|INVALID_ARGUMENT/.test(e?.message ?? "")) && /negative\s*prompt/i.test(e?.message ?? "");
}

/** Veo "asset" reference images are a Veo 3.1 feature, and not available on the Lite variant. */
export function supportsReferenceImages(model: string): boolean {
  return /^veo-3\.1-/.test(model) && !/lite/.test(model);
}

export function sniffImageMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/png";
}

/** Model id prefix: run this Gemini model on the free-tier key (GEMINI_TEXT_API_KEY). */
export const FREE_PREFIX = "free/";

export class GeminiProvider implements Provider {
  readonly name = "gemini";
  /** "model:mode" pairs where Veo rejected the negative prompt (remembered until the app restarts). */
  static readonly noNegativePrompt = new Set<string>();
  private readonly ai: GoogleGenAI;
  /** The free-tier key (GEMINI_TEXT_API_KEY), used for models chosen as "free/<model>" on the Models page. */
  private readonly freeAi?: GoogleGenAI;

  /** Video models named "inference.sh/…" (Seedance) run on inference.sh instead of Google (needs INFERENCE_API_KEY). */
  private inferenceSh?: InferenceShVideo;

  constructor(apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Add it to .env or your environment, or use the mock provider.");
    this.ai = new GoogleGenAI({ apiKey });
    const freeKey = process.env.GEMINI_TEXT_API_KEY?.trim();
    if (freeKey) this.freeAi = new GoogleGenAI({ apiKey: freeKey });
  }

  private inferenceShVideo(): InferenceShVideo {
    return (this.inferenceSh ??= new InferenceShVideo());
  }

  /** Video models named "runway/…" (Wan 3.0) run on Runway Dev (needs RUNWAYML_API_SECRET). */
  private runway?: RunwayVideo;
  private runwayVideo(): RunwayVideo {
    return (this.runway ??= new RunwayVideo());
  }

  /** Song models named "treblo/…" run on Treblo (Sonauto) instead of Google (needs TREBLO_API_KEY). */
  private trebloClient?: TrebloMusic;
  private treblo(): TrebloMusic {
    return (this.trebloClient ??= new TrebloMusic());
  }

  /** Text/image models named "openai/…" run on OpenAI instead of Google (needs OPENAI_API_KEY). */
  private openaiClient?: OpenAiClient;
  private openai(): OpenAiClient {
    return (this.openaiClient ??= new OpenAiClient());
  }

  /**
   * Which key a model runs on: "free/<model>" = the free-tier key (GEMINI_TEXT_API_KEY), anything else = the paid
   * GEMINI_API_KEY. Returns the client and the real model id.
   */
  private client(model: string): { ai: GoogleGenAI; model: string } {
    if (!model.startsWith(FREE_PREFIX)) return { ai: this.ai, model };
    if (!this.freeAi) throw new Error(`"${model}" runs on the free-tier key, but GEMINI_TEXT_API_KEY is not set. Add it to .env, or pick the model without "free/" on the Models page`);
    return { ai: this.freeAi, model: model.slice(FREE_PREFIX.length) };
  }

  private modelsCache?: { at: number; models: AvailableModel[] };

  async listModels(): Promise<AvailableModel[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 5 * 60_000) return this.modelsCache.models;
    const models: AvailableModel[] = [];
    const pager = await this.ai.models.list({ config: { pageSize: 1000 } });
    for await (const m of pager) {
      const actions = m.supportedActions ?? [];
      const id = m.name?.replace(/^models\//, "") ?? "";
      // Text/image use generateContent; Veo and other long-running media advertise predictLongRunning
      // and/or generateVideos — admit all of them so every Veo video model Google offers this key shows up.
      // Also admit anything named "veo*" in case a variant reports no (or an unexpected) action.
      const ok = actions.some((a) => a === "generateContent" || a === "predictLongRunning" || a === "generateVideos") || /^veo/.test(id);
      if (!ok) continue;
      if (m.name) models.push({ id, displayName: m.displayName });
    }
    // With a free-tier key: every text and speech model also as "free/<model>" (free tier: text and some speech models).
    if (this.freeAi) {
      for (const m of [...models]) {
        if (/tts/.test(m.id) || (/^(gemini|gemma)/.test(m.id) && !/image|embedding|live|native-audio|omni|-pro-preview/.test(m.id))) {
          models.push({ id: FREE_PREFIX + m.id, displayName: `${m.displayName ?? m.id} · free key` });
        }
      }
    }
    // Gemini Omni Flash video (the Gemini-API replacement for Veo). Offer it explicitly as a video suggestion
    // even if the key's live list labels it differently.
    const have = new Set(models.map((m) => m.id));
    for (const o of OMNI_MODELS) if (!have.has(o.id)) models.push(o);
    if (process.env.INFERENCE_API_KEY) models.push(...this.inferenceShVideo().listModels());
    if (process.env.TREBLO_API_KEY?.trim()) models.push(...TREBLO_MODELS);
    if (process.env.RUNWAYML_API_SECRET?.trim()) models.push(...RUNWAY_MODELS);
    if (process.env.OPENAI_API_KEY?.trim()) models.push(...(await this.openai().listModels().catch(() => [...OPENAI_MODELS])));
    this.modelsCache = { at: Date.now(), models };
    return models;
  }

  async text<K extends TextKind>(kind: K, prompt: string, opts: { model: string; ctx: GenContext; images?: Buffer[] }): Promise<TextOutputs[K]> {
    const schema = SCHEMAS[kind];
    if (isOpenAiModel(opts.model)) {
      const raw = await this.openai().text(opts.model, prompt, {
        label: kind,
        images: opts.images,
        jsonSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
        schemaName: kind,
      });
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new Error(`${kind}: OpenAI output failed validation: ${parsed.error.message}`);
      return parsed.data;
    }
    const contents = opts.images?.length
      ? [{ role: "user", parts: [...opts.images.map((b) => ({ inlineData: { data: b.toString("base64"), mimeType: sniffImageMime(b) } })), { text: prompt }] }]
      : prompt;
    return withRetry(
      async () => {
        const { ai, model } = this.client(opts.model);
        const res = await ai.models.generateContent({
          model,
          contents,
          config: { responseMimeType: "application/json", responseJsonSchema: z.toJSONSchema(schema, { io: "input" }), temperature: 0.9 },
        });
        if (!res.text) throw new Error(`${kind}: empty response`);
        const parsed = schema.safeParse(JSON.parse(res.text));
        if (!parsed.success) throw new Error(`${kind}: model output failed validation: ${parsed.error.message}`);
        return parsed.data;
      },
      // Validation failures are worth retrying: the model may do better next time.
      { label: kind, shouldRetry: () => true },
    );
  }

  async image(prompt: string, opts: { model: string; aspectRatio: string; references?: Buffer[]; label: string; size?: "1K" | "2K" | "4K" }): Promise<Buffer> {
    if (isOpenAiModel(opts.model)) return this.openai().image(opts.model, prompt, { label: opts.label, aspectRatio: opts.aspectRatio, references: opts.references });
    const imageSize = opts.size && supportsImageSize(opts.model) ? { imageSize: opts.size } : {};
    return withRetry(
      async () => {
        const { ai, model } = this.client(opts.model);
        const res = await ai.models.generateContent({
          model,
          contents: [
            { role: "user", parts: [...(opts.references ?? []).map((r) => ({ inlineData: { data: r.toString("base64"), mimeType: sniffImageMime(r) } })), { text: prompt }] },
          ],
          config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: opts.aspectRatio, ...imageSize } },
        });
        return firstInline(res, "image/").data;
      },
      { label: opts.label },
    );
  }

  async speech(prompt: string, opts: { model: string; voice: string; label: string }): Promise<Buffer> {
    return withRetry(
      async () => {
        const { ai, model } = this.client(opts.model);
        const res = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } } },
        });
        const { data, mimeType } = firstInline(res, "audio/");
        if (data.toString("ascii", 0, 4) === "RIFF") return data;
        const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1]) || GEMINI_TTS_FORMAT.sampleRate;
        return pcmToWav(data, { ...GEMINI_TTS_FORMAT, sampleRate: rate });
      },
      { label: opts.label },
    );
  }

  async song(prompt: string, opts: { model: string; label: string; durationSec: number; ctx: GenContext; lyrics?: string; instrumental?: boolean }): Promise<SongResult> {
    if (isTrebloModel(opts.model)) return this.treblo().song(prompt, opts);
    return withRetry(
      async () => {
        const { ai, model } = this.client(opts.model);
        const res = await ai.models.generateContent({ model, contents: prompt, config: { responseModalities: ["AUDIO", "TEXT"] } });
        const { data, mimeType } = firstInline(res, "audio/");
        const lyrics = (res.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("\n");
        const ext = /wav/.test(mimeType) || data.toString("ascii", 0, 4) === "RIFF" ? "wav" : "mp3";
        return { audio: data, ext, lyrics: lyrics || undefined };
      },
      { label: opts.label },
    );
  }

  async lipSync(opts: { model: string; video: Buffer; audio: Buffer; videoSec: number; audioSec: number; label: string }): Promise<Buffer> {
    if (!isInferenceShModel(opts.model)) throw new Error(`Lip-sync model "${opts.model}" isn't supported: pick Kling Lip Sync on the Models page, or "none"`);
    return this.inferenceShVideo().lipSync(opts);
  }

  async video(prompt: string, opts: { model: string; still?: Buffer; aspectRatio: string; label: string; character?: Buffer; cast?: Buffer[]; samples?: Buffer[]; audio?: Buffer; singAudio?: boolean; durationSec?: number; resolution?: VideoResolution; resumeTaskId?: string; onTaskStarted?: (taskId: string) => Promise<void> | void }): Promise<Buffer> {
    const { label } = opts;
    if (isInferenceShModel(opts.model)) return this.inferenceShVideo().video(prompt, { ...opts, mime: sniffImageMime });
    if (isRunwayModel(opts.model)) return this.runwayVideo().video(prompt, opts);
    if (isOmniModel(opts.model)) return this.omniVideo(prompt, opts);
    const img = (b: Buffer) => ({ imageBytes: b.toString("base64"), mimeType: sniffImageMime(b) });
    // With a character sheet on a model that supports it: character + scene picture as "asset" references keep
    // the character consistent across clips (Veo 3.1 standard/fast). References can't be combined with a first
    // frame and need 8s clips. Otherwise (no sheet, or a model without reference support such as Veo 3.1 Lite):
    // animate the scene picture as the first frame — that picture was itself drawn from the character sheet.
    const useReferences = !!opts.character && supportsReferenceImages(opts.model);
    if (opts.character && !useReferences) log.debug(`${label}: ${opts.model} doesn't take reference images; animating the scene picture as the first frame`);
    // No picture and no character (Character step skipped): Veo makes the scene from the words alone.
    const textOnly = !opts.still && !opts.character;
    if (!opts.still && !useReferences && !textOnly) {
      throw new Error(`${label}: ${opts.model} can't make a scene without a scene picture (it takes no character reference). Pick Veo 3.1 or Veo 3.1 Fast on the Models page, or turn scene pictures back on`);
    }
    // 1080p and 4K need 8 s clips, which is what the app makes anyway.
    const resolution = minResolution(opts.resolution ?? "720p", maxVeoResolution(opts.model));
    const base = { numberOfVideos: 1, aspectRatio: opts.aspectRatio, durationSeconds: 8, resolution };
    // The negative prompt keeps backgrounds sharp, but Veo rejects it in some modes (e.g. with reference
    // pictures): then send the request again without it, and stop sending it for that model and mode.
    const mode = `${opts.model}:${useReferences ? "references" : textOnly ? "text" : "first-frame"}`;
    const negative = GeminiProvider.noNegativePrompt.has(mode) ? {} : { negativePrompt: VEO_NEGATIVE_PROMPT };
    log.debug(`${label}: ${opts.model} at ${resolution}`);
    const request = useReferences && opts.character
      ? {
          model: opts.model,
          source: { prompt },
          config: {
            ...base,
            // No scene picture: the character alone, then the present cast (kept on-model), then sample pictures,
            // capped at Veo's 3 references (main character always first). Veo makes the scene from the prompt.
            referenceImages: [opts.character, ...(opts.cast ?? []), ...(opts.still ? [opts.still] : (opts.samples ?? []))].slice(0, VEO_MAX_REFERENCES).map((b) => ({ image: img(b), referenceType: VideoGenerationReferenceType.ASSET })),
          },
        }
      : textOnly ? { model: opts.model, source: { prompt }, config: base }
      : { model: opts.model, source: { prompt, image: img(opts.still!) }, config: base };
    const send = (withNegative: boolean) => {
      const config = withNegative ? { ...request.config, ...negative } : request.config;
      // Veo has low per-minute request limits: on 429 wait long enough for the window to reset.
      return withRetry(() => this.ai.models.generateVideos({ ...request, config }), {
        label,
        retries: 4,
        baseDelayMs: 30_000,
        maxDelayMs: 120_000,
        shouldRetry: (err) => !isBillingStop(err) && ((err as { status?: number }).status === 429 || isTransientError(err)),
      });
    };
    let op = await send("negativePrompt" in negative).catch((err: unknown) => {
      if (!("negativePrompt" in negative) || !isNegativePromptRejected(err)) throw err;
      GeminiProvider.noNegativePrompt.add(mode);
      log.info(`${label}: ${opts.model} doesn't take a negative prompt here (${mode.split(":")[1]}); sending it without one`);
      return send(false);
    });
    const started = Date.now();
    while (!op.done) {
      if (Date.now() - started > 10 * 60_000) throw new Error(`${label}: timed out after 10 minutes`);
      log.debug(`${label}: waiting for Veo…`);
      await sleep(10_000);
      op = await withRetry(() => this.ai.operations.getVideosOperation({ operation: op }), { label: `${label} poll` });
    }
    if (op.error) throw new Error(`${label}: ${JSON.stringify(op.error)}`);
    const video = op.response?.generatedVideos?.[0]?.video;
    if (!video) throw new Error(`${label}: Veo returned no video (blocked by safety filter: ${op.response?.raiMediaFilteredReasons?.join("; ") ?? "unknown"})`);
    if (video.videoBytes) return Buffer.from(video.videoBytes, "base64");
    const tmp = path.join(os.tmpdir(), `kids-studio-${process.pid}-${Date.now()}.mp4`);
    try {
      await withRetry(() => this.ai.files.download({ file: video, downloadPath: tmp }), { label: `${label} download` });
      return await readFile(tmp);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /**
   * Gemini Omni Flash video via the Interactions API (the Gemini-API replacement for Veo). Omni rejects
   * generateContent and isn't a generateVideos model, so it uses ai.interactions.create. It animates a
   * first-frame picture when one is given (the scene picture, itself drawn from the character sheet), else
   * makes the scene from the prompt alone. The clip comes back as base64 video in a "model_output" step.
   *
   * Audio references are allowlisted by Google (without access Omni answers "Audio input modality is not enabled
   * for this model"), so the scene's audio is sent only with OMNI_AUDIO_REFERENCE=1; the final video lays the real
   * soundtrack over the clip either way.
   */
  private async omniVideo(prompt: string, opts: { model: string; still?: Buffer; character?: Buffer; aspectRatio: string; label: string; durationSec?: number; audio?: Buffer }): Promise<Buffer> {
    const { label } = opts;
    const model = opts.model.replace(/^free\//, "");
    // Omni makes the scene from the words, optionally starting from a first-frame picture. It takes no
    // separate character "reference" like Veo, so animate the scene picture (drawn from the character sheet).
    const first = opts.still ?? opts.character;
    const seconds = Math.min(15, Math.max(4, Math.ceil(opts.durationSec ?? 8)));
    // Audio references are allowlisted by Google: only sent when OMNI_AUDIO_REFERENCE=1 (the account has access).
    const audio = process.env.OMNI_AUDIO_REFERENCE === "1" ? opts.audio : undefined;
    const audioNote = audio
      ? " The attached audio is this scene's soundtrack (the characters' voices / the song): the characters say or sing exactly those words, with their mouths and timing matched to that audio (lip-sync), in those same voices."
      : "";
    const fullPrompt = `${prompt}\n\nMake a ${seconds}-second ${opts.aspectRatio} video clip with lively, expressive, child-friendly motion.${audioNote}`;
    const imagePart = first ? [{ type: "image" as const, data: first.toString("base64"), mime_type: sniffImageMime(first) }] : [];
    const audioPart = audio ? [{ type: "audio" as const, data: audio.toString("base64"), mime_type: "audio/mpeg" as const }] : [];
    const textPart = { type: "text" as const, text: fullPrompt };
    // A bare string is fine when there's only a text part; otherwise send the content blocks (image/audio/text).
    const payload = first || audio ? [...imagePart, ...audioPart, textPart] : fullPrompt;
    return withRetry(
      async () => {
        const interaction = await this.ai.interactions.create({ model, input: payload, response_modalities: ["video", "audio"] });
        for (const step of interaction.steps ?? []) {
          if ((step as { type?: string }).type !== "model_output") continue;
          for (const block of (step as { content?: { type?: string; data?: string; mime_type?: string }[] }).content ?? []) {
            if (block.type === "video" && block.data) return Buffer.from(block.data, "base64");
          }
        }
        throw new Error(`${label}: Gemini Omni returned no video (possibly blocked by a safety filter)`);
      },
      { label, retries: 4, baseDelayMs: 30_000, maxDelayMs: 120_000, shouldRetry: (err) => !isBillingStop(err) && ((err as { status?: number }).status === 429 || isTransientError(err)) },
    );
  }
}
