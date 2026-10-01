import type { ModelSettingsService } from "../../services/model-settings.service.js";
import { HttpError, type Router } from "../http.js";

/** Per-task model settings: thin controllers over ModelSettingsService. */
export function modelRoutes(router: Router, models: ModelSettingsService): void {
  router
    .get("/api/models/settings", () => models.list())
    .get("/api/models/available", ({ url }) => models.availableModels(url.searchParams.get("provider") ?? "gemini"))
    .put("/api/models/settings/:task", async ({ params, body }) => {
      const b = await body();
      if (typeof b.model !== "string" || !b.model.trim()) throw new HttpError(400, "model (string) is required");
      return models.update(params.task!, b.model);
    })
    .post("/api/models/settings/:task/reset", ({ params }) => models.reset(params.task!));
}
