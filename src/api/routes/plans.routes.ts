import type { PlanService } from "../../services/plan.service.js";
import { send, type Router } from "../http.js";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** Ideas & schedule endpoints (one set of monthly plans per channel): thin controllers over PlanService. */
export function planRoutes(router: Router, plans: PlanService): void {
  const base = "/api/channels/:channel/plans";
  router
    .get(base, ({ params }) => plans.list(params.channel!))
    .get(`${base}/last-input`, ({ params }) => plans.lastInput(params.channel!))
    .post(`${base}/:month/slots`, async ({ params, body }) => plans.slots(params.month!, (await body()).input))
    .get(`${base}/:month`, ({ params }) => plans.get(params.channel!, params.month!))
    .post(`${base}/:month/generate`, async ({ params, body }) => {
      const b = await body();
      return plans.generate(params.channel!, params.month!, b.input, { provider: str(b.provider) });
    })
    .put(`${base}/:month/ideas/:index`, async ({ params, body }) => plans.editIdea(params.channel!, params.month!, Number(params.index) - 1, (await body()).idea))
    .post(`${base}/:month/ideas/:index/regenerate`, async ({ params, body }) => {
      const b = await body();
      return plans.regenerateIdea(params.channel!, params.month!, Number(params.index) - 1, { provider: str(b.provider), hint: str(b.hint) });
    })
    .post(`${base}/:month/ideas/:index/make`, async ({ params, body }) => {
      const b = await body();
      return plans.makeVideo(params.channel!, params.month!, Number(params.index) - 1, { provider: str(b.provider), reviewMode: str(b.reviewMode) });
    }, 201)
    .get(`${base}/:month/calendar.ics`, async ({ res, params }) => {
      const ics = await plans.calendar(params.channel!, params.month!);
      send(res, 200, ics, "text/calendar; charset=utf-8", { "content-disposition": `attachment; filename="posting-plan-${params.month}.ics"` });
    });
}
