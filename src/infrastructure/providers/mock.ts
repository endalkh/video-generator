import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stillToClip } from "../media/ffmpeg.js";
import { placeholderScenePng } from "../media/png.js";
import { toneWav } from "../media/wav.js";
import type { Scene } from "../../domain/project/project.model.js";
import { MODEL_TASKS } from "../../domain/model-setting/model-setting.entity.js";
import type { AvailableModel, GenContext, Provider, SongResult, TextKind, TextOutputs } from "../../domain/ports/generator.port.js";

const MOTIONS: Scene["motion"][] = ["zoom-in", "pan-right", "zoom-out", "pan-left"];

/** Offline provider: deterministic text, tones and placeholder art. Tests the whole pipeline without API keys. */
export class MockProvider implements Provider {
  readonly name = "mock";
  readonly songLengthSec: number;
  /** Every prompt received (with the model it was sent to), for tests. */
  readonly prompts: { kind: string; prompt: string; model?: string }[] = [];

  constructor(private readonly opts: { audioSecondsPerScene?: number; songLengthSec?: number; imageSize?: [number, number] } = {}) {
    this.songLengthSec = opts.songLengthSec ?? 8;
  }

  async listModels(): Promise<AvailableModel[]> {
    return [...new Set(MODEL_TASKS.map((t) => t.defaultModel))].map((id) => ({ id, displayName: `${id} (mock)` }));
  }

  async text<K extends TextKind>(kind: K, prompt: string, { model, ctx }: { model: string; ctx: GenContext }): Promise<TextOutputs[K]> {
    const { input, poem } = ctx;
    this.prompts.push({ kind, prompt, model });
    const out: { [P in TextKind]: () => TextOutputs[P] } = {
      poem: () => ({
        title: input.topic,
        stanzas: Array.from({ length: input.sceneCount }, (_, i) =>
          input.language === "am"
            ? { lines: [`${input.topic} — ክፍል ${i + 1}`, "እንማር እንጫወት በደስታ"] }
            : { lines: [`Verse ${i + 1} about ${input.topic}`, "Let's learn and play all day"] },
        ),
        moral: input.language === "am" ? "መማር ደስ ይላል" : "Learning is fun",
      }),
      scenes: () => ({
        scenes: (poem?.stanzas ?? []).map((s, i) => ({
          index: i,
          text: s.lines.join("\n"),
          visualPrompt: `Scene ${i + 1}: the character illustrates "${input.topic}"`,
          motion: MOTIONS[i % MOTIONS.length]!,
        })),
      }),
      character: () => ({ name: input.language === "am" ? "ቡቡ" : "Bubu", description: input.characterHint ?? "a round, friendly pink creature with big dark eyes" }),
    };
    return out[kind]();
  }

  async image(prompt: string, { ctx, model }: { ctx: GenContext; model: string }): Promise<Buffer> {
    this.prompts.push({ kind: "image", prompt, model });
    const [w, h] = this.opts.imageSize ?? (ctx.input.aspectRatio === "9:16" ? [360, 640] : [640, 360]);
    return placeholderScenePng(w, h, ctx.scene ? ctx.scene.index + 1 : 0);
  }

  async speech(prompt: string, { ctx, model }: { ctx: GenContext; model: string }): Promise<Buffer> {
    this.prompts.push({ kind: "speech", prompt, model });
    return toneWav(this.opts.audioSecondsPerScene ?? 2, ctx.scene?.index ?? 0);
  }

  async song(prompt: string, { durationSec, model }: { durationSec: number; model: string }): Promise<SongResult> {
    this.prompts.push({ kind: "song", prompt, model });
    return { audio: toneWav(durationSec, 3), ext: "wav", lyrics: "(mock song)" };
  }

  /** Short MP4 made from the still, standing in for Veo. */
  async video(prompt: string, { still, model }: { still: Buffer; model: string }): Promise<Buffer> {
    this.prompts.push({ kind: "video", prompt, model });
    const dir = await mkdtemp(path.join(os.tmpdir(), "mock-video-"));
    try {
      await writeFile(path.join(dir, "in.png"), still);
      await stillToClip({ image: path.join(dir, "in.png"), duration: 2, out: path.join(dir, "out.mp4"), motion: "zoom-in", fmt: { width: 320, height: 180, fps: 25 } });
      return await readFile(path.join(dir, "out.mp4"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
