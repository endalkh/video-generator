import { ProjectInputSchema } from "../../domain/project/project.model.js";
import type { PromptService } from "../../services/prompt.service.js";
import { HttpError, type Router } from "../http.js";

/** Prompt library endpoints: thin controllers that delegate to PromptService. */
export function promptRoutes(router: Router, prompts: PromptService): void {
  router
    .get("/api/prompts", () => prompts.list())
    .get("/api/prompts/:key", ({ params }) => prompts.get(params.key!))
    .get("/api/prompts/:key/history", ({ params }) => prompts.history(params.key!))
    .put("/api/prompts/:key", async ({ params, body }) => {
      const b = await body();
      if (typeof b.template !== "string") throw new HttpError(400, "template (string) is required");
      const expectedVersion = typeof b.expectedVersion === "number" ? b.expectedVersion : undefined;
      return prompts.update(params.key!, b.template, { note: typeof b.note === "string" ? b.note : undefined, expectedVersion });
    })
    .post("/api/prompts/:key/reset", ({ params }) => prompts.reset(params.key!))
    .post("/api/prompts/:key/restore", async ({ params, body }) => {
      const b = await body();
      if (typeof b.version !== "number") throw new HttpError(400, "version (number) is required");
      return prompts.restore(params.key!, b.version);
    })
    .post("/api/prompts/:key/preview", async ({ params, body }) => {
      const b = await body();
      const parsed = ProjectInputSchema.safeParse({ topic: "Washing hands before eating", ...(typeof b.input === "object" && b.input ? b.input : {}) });
      if (!parsed.success) throw new HttpError(400, "invalid sample input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
      const input = parsed.data;
      return { text: await prompts.preview(params.key!, typeof b.template === "string" ? b.template : undefined, input) };
    });
}
