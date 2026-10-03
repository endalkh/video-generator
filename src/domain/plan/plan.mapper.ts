import { Prisma, type ContentPlan as ContentPlanRow } from "../../generated/prisma/client.js";
import { ContentPlan } from "./plan.entity.js";
import { PlanIdeaSchema, PlanInputSchema, type PlanIdea, type PlanInput } from "./plan.model.js";

export interface ContentPlanDto {
  channelId: string;
  month: string;
  input: PlanInput;
  theme: string | null;
  ideas: PlanIdea[];
  updatedAt: string;
}

export const ContentPlanMapper = {
  /** JSON columns are validated on the way in, so a hand-edited row can't corrupt the domain. */
  toDomain(row: ContentPlanRow): ContentPlan {
    return ContentPlan.restore({
      channelId: row.channelId,
      month: row.month,
      input: PlanInputSchema.parse(row.input),
      theme: row.theme,
      ideas: PlanIdeaSchema.array().parse(row.ideas),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },

  toPersistence(plan: ContentPlan) {
    const p = plan.toProps();
    return { channelId: p.channelId, month: p.month, input: p.input as Prisma.InputJsonValue, theme: p.theme, ideas: p.ideas as unknown as Prisma.InputJsonValue, createdAt: p.createdAt };
  },

  toDto(plan: ContentPlan): ContentPlanDto {
    const p = plan.toProps();
    return { channelId: p.channelId, month: p.month, input: p.input, theme: p.theme, ideas: p.ideas, updatedAt: p.updatedAt.toISOString() };
  },
};
