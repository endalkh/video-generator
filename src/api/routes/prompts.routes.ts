import { ProjectInputSchema } from "../../domain/project/project.model.js";
import type { PromptService } from "../../services/prompt.service.js";
import { HttpError, type Ctx, type Router } from "../http.js";

/** `?channel=<id>`: work on the prompts that channel uses (its own copies, else the shared ones). */
const channelOf = ({ url }: Ctx) => url.searchParams.get("channel") || undefined;

/** Prompt library endpoints: thin controllers that delegate to PromptService. */
export function promptRoutes(router: Router, prompts: PromptService): void {
  router
    .get("/api/prompts", (ctx) => prompts.list(channelOf(ctx)))
    .get("/api/prompts/:key", (ctx) => prompts.get(ctx.params.key!, channelOf(ctx)))
    .get("/api/prompts/:key/history", (ctx) => prompts.history(ctx.params.key!, channelOf(ctx)))
    .put("/api/prompts/:key", async (ctx) => {
      const b = await ctx.body();
      if (typeof b.template !== "string") throw new HttpError(400, "template (string) is required");
      const expectedVersion = typeof b.expectedVersion === "number" ? b.expectedVersion : undefined;
      return prompts.update(ctx.params.key!, b.template, { note: typeof b.note === "string" ? b.note : undefined, expectedVersion, channel: channelOf(ctx) });
    })
    .post("/api/prompts/:key/reset", (ctx) => prompts.reset(ctx.params.key!, channelOf(ctx)))
    .post("/api/prompts/:key/restore", async (ctx) => {
      const b = await ctx.body();
      if (typeof b.version !== "number") throw new HttpError(400, "version (number) is required");
      return prompts.restore(ctx.params.key!, b.version, channelOf(ctx));
    })
    .post("/api/prompts/:key/preview", async (ctx) => {
      const b = await ctx.body();
      const parsed = ProjectInputSchema.safeParse({ topic: "Washing hands before eating", ...(typeof b.input === "object" && b.input ? b.input : {}) });
      if (!parsed.success) throw new HttpError(400, "invalid sample input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
      return { text: await prompts.preview(ctx.params.key!, typeof b.template === "string" ? b.template : undefined, parsed.data, channelOf(ctx)) };
    });
}
