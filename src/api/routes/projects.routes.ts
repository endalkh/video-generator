import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_UPLOAD_BYTES, type ProjectService } from "../../services/project.service.js";
import type { PipelineEvent } from "../../services/pipeline.service.js";
import { HttpError, send, type Router } from "../http.js";

const MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".srt": "text/plain; charset=utf-8",
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** Project endpoints: thin controllers that delegate to ProjectService. */
export function projectRoutes(router: Router, projects: ProjectService): void {
  router
    .get("/api/projects", ({ url }) => projects.list(url.searchParams.get("channel") || undefined))
    .post(
      "/api/projects",
      async ({ body }) => {
        const b = await body();
        const project = await projects.create(b.input, str(b.provider) ?? "gemini", { channelId: str(b.channelId) });
        await projects.start(project.id);
        return project;
      },
      201,
    )
    .get("/api/projects/:id", ({ params }) => projects.get(params.id!))
    .del("/api/projects/:id", async ({ params }) => {
      await projects.delete(params.id!);
      return { deleted: params.id };
    })
    .put("/api/projects/:id/channel", async ({ params, body }) => {
      const channelId = str((await body()).channelId);
      if (!channelId) throw new HttpError(400, "channelId is required");
      return projects.moveToChannel(params.id!, channelId);
    })
    .get("/api/projects/:id/generations", ({ params }) => projects.generationsOf(params.id!))
    .post(
      "/api/projects/:id/resume",
      async ({ params, body }) => {
        const b = await body();
        await projects.start(params.id!, { provider: str(b.provider), from: str(b.from) });
        return { id: params.id };
      },
      202,
    )
    .post(
      "/api/projects/:id/visuals",
      async ({ params, body }) => {
        const b = await body();
        if (typeof b.videoMode !== "string") throw new HttpError(400, "videoMode is required (still or veo)");
        return projects.changeVisuals(params.id!, b.videoMode);
      },
      202,
    )
    .post("/api/projects/:id/approve", async ({ params, body }) => {
      const b = await body();
      await projects.approve(params.id!, String(b.step ?? ""));
      return { id: params.id };
    }, 202)
    .post("/api/projects/:id/regenerate", async ({ params, body }) => {
      const b = await body();
      await projects.regenerate(params.id!, String(b.step ?? ""), { provider: str(b.provider), keepVisuals: b.keepVisuals === true });
      return { id: params.id };
    }, 202)
    .post("/api/projects/:id/steps/:step/generate", async ({ params, body }) => {
      const b = await body();
      await projects.generateStep(params.id!, params.step!, { provider: str(b.provider), keepVisuals: b.keepVisuals === true });
      return { id: params.id, step: params.step };
    }, 202)
    .post("/api/projects/:id/scenes/:index/redo", async ({ params }) => {
      await projects.redoScene(params.id!, Number(params.index) - 1);
      return { id: params.id };
    }, 202)
    .put("/api/projects/:id/subtitles", async ({ params, body }) => projects.setSubtitles(params.id!, (await body()).on))
    .put("/api/projects/:id/settings", async ({ params, body }) => {
      const b = await body();
      return projects.changeSettings(params.id!, b.settings, { keepPoem: b.keepPoem === true });
    })
    .put("/api/projects/:id/review-mode", async ({ params, body }) => projects.setReviewMode(params.id!, String((await body()).mode ?? "")))
    .put("/api/projects/:id/poem", async ({ params, body }) => {
      const b = await body();
      return projects.editPoem(params.id!, b.poem, { keepVisuals: b.keepVisuals === true });
    })
    .post("/api/projects/:id/poem/stanzas/:n/rewrite", async ({ params, body }) => {
      const b = await body();
      return projects.rewriteStanza(params.id!, Number(params.n) - 1, { draft: b.poem, hint: str(b.hint), provider: str(b.provider) });
    })
    .put("/api/projects/:id/scenes", async ({ params, body }) => projects.editScenes(params.id!, (await body()).scenes))
    .put("/api/projects/:id/character/upload", async ({ params, body }) => {
      // base64 grows the picture by ~4/3, plus room for the name/description.
      const b = await body(Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 64_000);
      return projects.uploadCharacter(params.id!, b, { provider: str(b.provider) });
    })
    .put("/api/projects/:id/character", async ({ params, body }) => projects.editCharacter(params.id!, (await body()).character))
    .post("/api/projects/:id/cancel", ({ params }) => ({ cancelled: projects.cancel(params.id!) }), 202)
    .get("/api/projects/:id/events", async ({ req, res, params }) => {
      await projects.get(params.id!); // 404 for unknown projects
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      const unsubscribe = projects.subscribe(params.id!, (e: PipelineEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
    })
    .get("/media/:id/*", async ({ req, res, params }) => {
      const rel = params["*"]!.split("/");
      if (rel.at(-1) === "subtitles.vtt") {
        // Browsers don't render the MP4's embedded mov_text track, so serve the SRT as WebVTT for <track>.
        const srtFile = projects.mediaFile(params.id!, ["subtitles.srt"]);
        const srt = srtFile ? await readFile(srtFile, "utf8").catch(() => undefined) : undefined;
        if (srt === undefined) throw new HttpError(404, "not found");
        return send(res, 200, srtToVtt(srt), "text/vtt; charset=utf-8");
      }
      const file = projects.mediaFile(params.id!, rel);
      const type = file && MEDIA_TYPES[path.extname(file)];
      if (!file || !type) throw new HttpError(404, "not found");
      await serveFile(req, res, file, type);
    });
}

export function srtToVtt(srt: string): string {
  return "WEBVTT\n\n" + srt.replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}

/** Static file with HTTP Range support so <video> can seek. */
export async function serveFile(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, file: string, type: string) {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new HttpError(404, "not found");
  const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache", "x-content-type-options": "nosniff" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, info.size - 1);
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${info.size}` });
      return void res.end();
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": String(end - start + 1) });
    return void createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-length": String(info.size) });
  createReadStream(file).pipe(res);
}
