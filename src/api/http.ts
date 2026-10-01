import type http from "node:http";
import { ConflictError, DomainError, NotFoundError, ValidationError } from "../domain/errors.js";
import { log } from "../util/log.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  url: URL;
  body: () => Promise<Record<string, unknown>>;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

/** Minimal router: `/api/projects/:id/resume`. Handlers return a value (sent as JSON) or write the response themselves. */
export class Router {
  private routes: { method: string; parts: string[]; handler: Handler; status: number }[] = [];

  on(method: string, pattern: string, handler: Handler, status = 200): this {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler, status });
    return this;
  }
  get = (p: string, h: Handler) => this.on("GET", p, h);
  post = (p: string, h: Handler, status = 200) => this.on("POST", p, h, status);
  put = (p: string, h: Handler) => this.on("PUT", p, h);

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string>; status: number } | undefined {
    const segs = pathname.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const wildcard = r.parts.at(-1) === "*";
      if (wildcard ? segs.length < r.parts.length : segs.length !== r.parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.parts.length && ok; i++) {
        const part = r.parts[i]!;
        if (part === "*") params["*"] = segs.slice(i).map(decodeURIComponent).join("/");
        else if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(segs[i]!);
        else ok = part === segs[i];
      }
      if (ok) return { handler: r.handler, params, status: r.status };
    }
    return undefined;
  }
}

export async function readJsonBody(req: http.IncomingMessage, limit = 200_000): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; img-src 'self' blob:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
};

export function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...SECURITY_HEADERS, ...extra });
  if (res.req?.method === "HEAD") return void res.end();
  res.end(body);
}

export const sendJson = (res: http.ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body ?? null), "application/json; charset=utf-8");

/** Map domain errors to HTTP. */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ValidationError) return new HttpError(400, err.message, err.details);
  if (err instanceof NotFoundError) return new HttpError(404, err.message);
  if (err instanceof ConflictError) return new HttpError(409, err.message);
  if (err instanceof DomainError) return new HttpError(400, err.message);
  log.error(`API: ${(err as Error)?.stack ?? err}`);
  return new HttpError(500, "Internal error; see server logs");
}

/**
 * The UI has no login, so it must only be reachable from this machine: reject non-localhost Host headers
 * (DNS rebinding) and cross-site Origins, and require JSON for writes (blocks simple-form CSRF).
 */
export function guardLocal(req: http.IncomingMessage): void {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new HttpError(403, "forbidden host");
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) throw new HttpError(403, "forbidden origin");
  if (["POST", "PUT", "DELETE"].includes(req.method ?? "") && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "expected application/json");
  }
}
