import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GoogleGenAI, VideoGenerationReferenceType } from "@google/genai";
import { z } from "zod";
import { pcmToWav, GEMINI_TTS_FORMAT } from "../media/wav.js";
import { ChannelDetailsSchema } from "../../domain/channel/channel.model.js";
import { PlanTextSchema } from "../../domain/plan/plan.model.js";
import { CharacterSchema, PoemSchema, ScenePlanSchema, StanzaSchema } from "../../domain/project/project.model.js";
import { log } from "../../util/log.js";
import { isBillingStop, isTransientError, sleep, withRetry } from "../../util/retry.js";
import { type AvailableModel, type GenContext, type Provider, type SongResult, type TextKind, type TextOutputs } from "../../domain/ports/generator.port.js";


const SCHEMAS: { [K in TextKind]: z.ZodType<TextOutputs[K]> } = { poem: PoemSchema, scenes: ScenePlanSchema, character: CharacterSchema, stanza: StanzaSchema, channel: ChannelDetailsSchema, plan: PlanTextSchema };

type InlinePart = { inlineData?: { data?: string; mimeType?: string }; text?: string };

function firstInline(res: { candidates?: { content?: { parts?: InlinePart[] } }[] }, prefix: string): { data: Buffer; mimeType: string } {
  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    const d = part.inlineData;
    if (d?.data && (d.mimeType ?? "").startsWith(prefix)) return { data: Buffer.from(d.data, "base64"), mimeType: d.mimeType! };
  }
  throw new Error(`Gemini response contained no ${prefix}* data (possibly blocked by safety filters)`);
}

export function sniffImageMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/png";
}

export class GeminiProvider implements Provider {
  readonly name = "gemini";
  private readonly ai: GoogleGenAI;

  constructor(apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Add it to .env or your environment, or use the mock provider.");
    this.ai = new GoogleGenAI({ apiKey });
  }

  private modelsCache?: { at: number; models: AvailableModel[] };

  async listModels(): Promise<AvailableModel[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 5 * 60_000) return this.modelsCache.models;
    const models: AvailableModel[] = [];
    const pager = await this.ai.models.list({ config: { pageSize: 1000 } });
    for await (const m of pager) {
      const actions = m.supportedActions ?? [];
      if (!actions.some((a) => a === "generateContent" || a === "predictLongRunning")) continue;
      if (m.name) models.push({ id: m.name.replace(/^models\//, ""), displayName: m.displayName });
    }
    this.modelsCache = { at: Date.now(), models };
    return models;
  }

  async text<K extends TextKind>(kind: K, prompt: string, opts: { model: string; ctx: GenContext; images?: Buffer[] }): Promise<TextOutputs[K]> {
    const schema = SCHEMAS[kind];
    const contents = opts.images?.length
      ? [{ role: "user", parts: [...opts.images.map((b) => ({ inlineData: { data: b.toString("base64"), mimeType: sniffImageMime(b) } })), { text: prompt }] }]
      : prompt;
    return withRetry(
      async () => {
        const res = await this.ai.models.generateContent({
          model: opts.model,
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

  async image(prompt: string, opts: { model: string; aspectRatio: string; references?: Buffer[]; label: string }): Promise<Buffer> {
    return withRetry(
      async () => {
        const res = await this.ai.models.generateContent({
          model: opts.model,
          contents: [
            { role: "user", parts: [...(opts.references ?? []).map((r) => ({ inlineData: { data: r.toString("base64"), mimeType: sniffImageMime(r) } })), { text: prompt }] },
          ],
          config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: opts.aspectRatio } },
        });
        return firstInline(res, "image/").data;
      },
      { label: opts.label },
    );
  }

  async speech(prompt: string, opts: { model: string; voice: string; label: string }): Promise<Buffer> {
    return withRetry(
      async () => {
        const res = await this.ai.models.generateContent({
          model: opts.model,
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

  async song(prompt: string, opts: { model: string; label: string }): Promise<SongResult> {
    return withRetry(
      async () => {
        const res = await this.ai.models.generateContent({ model: opts.model, contents: prompt, config: { responseModalities: ["AUDIO", "TEXT"] } });
        const { data, mimeType } = firstInline(res, "audio/");
        const lyrics = (res.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("\n");
        const ext = /wav/.test(mimeType) || data.toString("ascii", 0, 4) === "RIFF" ? "wav" : "mp3";
        return { audio: data, ext, lyrics: lyrics || undefined };
      },
      { label: opts.label },
    );
  }

  async video(prompt: string, opts: { model: string; still: Buffer; aspectRatio: string; label: string; character?: Buffer }): Promise<Buffer> {
    const { label } = opts;
    const img = (b: Buffer) => ({ imageBytes: b.toString("base64"), mimeType: sniffImageMime(b) });
    // With a character sheet: character + scene picture as "asset" references keep the character consistent
    // across clips (Veo 3.1). References can't be combined with a first frame and need 8s clips.
    // Without one: animate the scene picture as the first frame. No silent fallback between the two.
    const request = opts.character
      ? {
          model: opts.model,
          source: { prompt },
          config: {
            numberOfVideos: 1,
            aspectRatio: opts.aspectRatio,
            durationSeconds: 8,
            referenceImages: [opts.character, opts.still].map((b) => ({ image: img(b), referenceType: VideoGenerationReferenceType.ASSET })),
          },
        }
      : { model: opts.model, source: { prompt, image: img(opts.still) }, config: { numberOfVideos: 1, aspectRatio: opts.aspectRatio } };
    // Veo has low per-minute request limits: on 429 wait long enough for the window to reset.
    let op = await withRetry(() => this.ai.models.generateVideos(request), {
      label,
      retries: 4,
      baseDelayMs: 30_000,
      maxDelayMs: 120_000,
      shouldRetry: (err) => !isBillingStop(err) && ((err as { status?: number }).status === 429 || isTransientError(err)),
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
}
