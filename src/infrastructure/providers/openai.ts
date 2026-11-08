import type { AvailableModel } from "../../domain/ports/generator.port.js";
import { log } from "../../util/log.js";
import { isTransientError, withRetry } from "../../util/retry.js";

/**
 * OpenAI as an extra backend for some tasks (character/scene/plan/channel text, and image painting with a
 * character reference). Used by picking an "openai/<model>" id on the Models page; GeminiProvider dispatches
 * those ids here (like it already does for inference.sh/Treblo). Plain REST over fetch — no SDK dependency.
 * Needs OPENAI_API_KEY.
 */
export const OPENAI_PREFIX = "openai/";
export const isOpenAiModel = (model: string) => model.startsWith(OPENAI_PREFIX);

/** Models offered on the Models page for OpenAI tasks (text + image). Any "openai/<id>" also works if typed. */
export const OPENAI_MODELS: readonly AvailableModel[] = [
  { id: "openai/gpt-4o", displayName: "OpenAI GPT-4o — text (character, scenes, ideas, channel)" },
  { id: "openai/gpt-4o-mini", displayName: "OpenAI GPT-4o mini — cheaper text" },
  { id: "openai/gpt-5", displayName: "OpenAI GPT-5 — text" },
  { id: "openai/gpt-image-1", displayName: "OpenAI gpt-image-1 — images (character sheets, scenes, channel art)" },
];

/** Does this openai/<model> id make images (vs. text)? */
export const isOpenAiImageModel = (model: string) => /image/.test(model.replace(OPENAI_PREFIX, ""));

export class OpenAiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Map the project's aspect ratio to the nearest size gpt-image-1 supports (square, portrait, landscape). */
function imageSize(aspectRatio: string): string {
  if (aspectRatio === "9:16") return "1024x1536";
  if (aspectRatio === "16:9") return "1536x1024";
  return "1024x1024";
}

export class OpenAiClient {
  private readonly apiKey: string;

  constructor(
    apiKey = process.env.OPENAI_API_KEY?.trim(),
    private readonly opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
  ) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set. Add it to .env to use "openai/…" models, or pick a Gemini model on the Models page.');
    this.apiKey = apiKey;
  }

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  private get baseUrl(): string {
    return this.opts.baseUrl ?? "https://api.openai.com/v1";
  }

  private modelId(model: string): string {
    return model.replace(OPENAI_PREFIX, "");
  }

  /** Structured JSON generation. Returns the parsed object (the caller validates it against the step schema). */
  async text(model: string, prompt: string, opts: { label: string; images?: Buffer[]; jsonSchema?: Record<string, unknown>; schemaName?: string }): Promise<unknown> {
    const content: unknown[] = [{ type: "text", text: prompt }];
    for (const b of opts.images ?? []) content.push({ type: "image_url", image_url: { url: `data:${sniffMime(b)};base64,${b.toString("base64")}` } });
    const body: Record<string, unknown> = {
      model: this.modelId(model),
      messages: [{ role: "user", content }],
      // Ask for strict JSON; a json_schema when we have one, else a plain JSON object.
      response_format: opts.jsonSchema
        ? { type: "json_schema", json_schema: { name: opts.schemaName ?? "output", schema: opts.jsonSchema, strict: false } }
        : { type: "json_object" },
    };
    return withRetry(
      async () => {
        const res = await this.api("POST", "/chat/completions", body, opts.label);
        const text = (res as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
        if (!text) throw new Error(`${opts.label}: OpenAI returned an empty response`);
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`${opts.label}: OpenAI did not return valid JSON`);
        }
      },
      { label: opts.label, shouldRetry: (err) => err instanceof OpenAiError ? (err.status === 429 || err.status >= 500) : isTransientError(err) },
    );
  }

  /** Image (PNG). With reference images, uses the edits endpoint (gpt-image-1 takes several inputs); else generations. */
  async image(model: string, prompt: string, opts: { label: string; aspectRatio: string; references?: Buffer[] }): Promise<Buffer> {
    const size = imageSize(opts.aspectRatio);
    const id = this.modelId(model);
    return withRetry(
      async () => {
        let json: unknown;
        if (opts.references?.length) {
          // Edit/compose from reference images (e.g. the character sheet first). multipart/form-data.
          const form = new FormData();
          form.set("model", id);
          form.set("prompt", prompt);
          form.set("size", size);
          opts.references.forEach((b, i) => form.append("image[]", new Blob([new Uint8Array(b)], { type: sniffMime(b) }), `ref${i}.png`));
          json = await this.apiForm("/images/edits", form, opts.label);
        } else {
          json = await this.api("POST", "/images/generations", { model: id, prompt, size }, opts.label);
        }
        const b64 = (json as { data?: { b64_json?: string; url?: string }[] }).data?.[0];
        if (b64?.b64_json) return Buffer.from(b64.b64_json, "base64");
        if (b64?.url) {
          const img = await this.fetchImpl(b64.url);
          if (!img.ok) throw new OpenAiError(img.status, `${opts.label}: couldn't download the image (HTTP ${img.status})`);
          return Buffer.from(await img.arrayBuffer());
        }
        throw new Error(`${opts.label}: OpenAI returned no image`);
      },
      { label: opts.label, shouldRetry: (err) => err instanceof OpenAiError ? (err.status === 429 || err.status >= 500) : isTransientError(err) },
    );
  }

  /** The text/image models the key can use (best-effort; falls back to the built-in list). */
  async listModels(): Promise<AvailableModel[]> {
    try {
      const res = await this.api("GET", "/models", undefined, "openai models");
      const ids = ((res as { data?: { id?: string }[] }).data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
      const useful = ids.filter((x) => /^(gpt-|o\d|chatgpt|gpt-image)/.test(x)).sort();
      if (useful.length) return useful.map((x) => ({ id: OPENAI_PREFIX + x, displayName: `OpenAI ${x}` }));
    } catch (err) {
      log.debug(`OpenAI listModels failed, using the built-in list: ${(err as Error).message}`);
    }
    return [...OPENAI_MODELS];
  }

  private async api(method: "GET" | "POST", endpoint: string, body: unknown, label: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return this.parse(res, method, endpoint, label);
  }

  private async apiForm(endpoint: string, form: FormData, label: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${endpoint}`, { method: "POST", headers: { Authorization: `Bearer ${this.apiKey}` }, body: form });
    return this.parse(res, "POST", endpoint, label);
  }

  private async parse(res: Response, method: string, endpoint: string, label: string): Promise<unknown> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const d = json as { error?: { message?: string } } | undefined;
      throw new OpenAiError(res.status, `${label}: OpenAI ${method} ${endpoint} failed (HTTP ${res.status}): ${d?.error?.message ?? text.slice(0, 300)}`);
    }
    return json;
  }
}

function sniffMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/png";
}
