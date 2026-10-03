import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_NAMES, type Container } from "../container.js";
import { STEP_NAMES } from "../domain/project/project.model.js";
import { log } from "../util/log.js";
import { guardLocal, readJsonBody, Router, send, sendJson, toHttpError } from "./http.js";
import { projectRoutes } from "./routes/projects.routes.js";
import { promptRoutes } from "./routes/prompts.routes.js";
import { modelRoutes } from "./routes/models.routes.js";
import { channelRoutes } from "./routes/channels.routes.js";
import { planRoutes } from "./routes/plans.routes.js";

/** public/ sits at the package root, both for src/api (tsx) and dist/api (build). */
export const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Resolve a URL path to a file inside public/ (generated Tailwind CSS, JS, images…), or undefined. */
function staticFile(pathname: string): string | undefined {
  if (pathname.startsWith("/api/") || pathname.startsWith("/media/") || pathname.startsWith("/channel-media/")) return undefined;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return undefined;
  }
  const file = path.resolve(PUBLIC_DIR, "." + rel);
  return file.startsWith(PUBLIC_DIR + path.sep) && STATIC_TYPES[path.extname(file)] ? file : undefined;
}

export function createApp(c: Container): http.Server {
  const router = new Router();
  router.get("/api/config", () => ({
    providers: PROVIDER_NAMES,
    hasApiKey: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    steps: STEP_NAMES,
  }));
  projectRoutes(router, c.projectService);
  promptRoutes(router, c.promptService);
  modelRoutes(router, c.modelSettingsService);
  channelRoutes(router, c.channelService);
  planRoutes(router, c.planService);
  router
    .post("/api/projects/:id/publish/:what", async ({ params, body }) => {
      const b = await body();
      return c.publishService.generate(params.id!, params.what!, { provider: typeof b.provider === "string" ? b.provider : undefined, title: typeof b.title === "string" ? b.title : undefined });
    })
    .put("/api/projects/:id/publish", async ({ params, body }) => c.publishService.edit(params.id!, (await body()).publish));

  return http.createServer(async (req, res) => {
    try {
      guardLocal(req);
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      const asset = method === "GET" || method === "HEAD" ? staticFile(url.pathname) : undefined;
      if (asset) {
        const body = await readFile(asset).catch(() => undefined);
        const type = STATIC_TYPES[path.extname(asset)]!;
        if (body) return send(res, 200, body, type, { "cache-control": "no-cache" });
        if (path.basename(asset) === "app.css") return send(res, 200, "/* run `npm run ui:css` to build the Tailwind styles */", type);
      }

      const route = router.match(method, url.pathname);
      if (!route) return sendJson(res, 404, { error: "not found" });
      let bodyPromise: Promise<Record<string, unknown>> | undefined;
      const result = await route.handler({ req, res, url, params: route.params, body: (limit?: number) => (bodyPromise ??= readJsonBody(req, limit)) });
      if (!res.headersSent && !res.writableEnded) sendJson(res, route.status, result);
    } catch (err) {
      const e = toHttpError(err);
      if (!res.headersSent) sendJson(res, e.status, { error: e.message, details: e.details });
      else res.end();
    }
  });
}

/**
 * Local-only web UI; there is no authentication. Binds to 127.0.0.1 by default. In Docker, HOST=0.0.0.0 is
 * needed inside the container, and docker-compose publishes the port on the host's 127.0.0.1 only.
 */
export async function startServer(c: Container, opts: { port?: number; host?: string } = {}): Promise<http.Server> {
  const port = opts.port ?? (Number(process.env.PORT) || 5178);
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
  const server = createApp(c);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  log.info(`Kids Animation Studio: http://localhost:${typeof addr === "object" && addr ? addr.port : port}  (local only · Ctrl+C to stop)`);
  return server;
}
