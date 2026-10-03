import path from "node:path";
import type { ChannelService } from "../../services/channel.service.js";
import { MAX_UPLOAD_BYTES } from "../../services/project.service.js";
import { HttpError, type Router } from "../http.js";
import { serveFile } from "./projects.routes.js";

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg" };
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
/** base64 grows the picture by ~4/3, plus room for the other fields. */
const UPLOAD_LIMIT = Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 64_000;

/** YouTube channel kit endpoints (Channel page): thin controllers over ChannelService. */
export function channelRoutes(router: Router, channels: ChannelService): void {
  router
    .get("/api/channels", () => channels.list())
    .post("/api/channels", async ({ body }) => channels.create(await body(UPLOAD_LIMIT)), 201)
    .get("/api/channels/:id", ({ params }) => channels.get(params.id!))
    .put("/api/channels/:id", async ({ params, body }) => channels.update(params.id!, await body(UPLOAD_LIMIT)))
    .del("/api/channels/:id", async ({ params, body }) => channels.delete(params.id!, { moveVideosTo: str((await body()).moveVideosTo) }))
    .put("/api/channels/:id/details", async ({ params, body }) => channels.editDetails(params.id!, (await body()).details))
    .post("/api/channels/:id/assets/:asset/generate", async ({ params, body }) => {
      const b = await body();
      return channels.generate(params.id!, params.asset!, { provider: str(b.provider), title: str(b.title) });
    })
    .get("/channel-media/:id/*", async ({ req, res, params }) => {
      const file = channels.mediaFile(params.id!, params["*"]!.split("/"));
      const type = file && IMAGE_TYPES[path.extname(file)];
      if (!file || !type) throw new HttpError(404, "not found");
      await serveFile(req, res, file, type);
    });
}
