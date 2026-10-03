import { NotFoundError, ValidationError } from "../errors.js";
import { MONTH_RE, PlanIdeaPatchSchema, PlanIdeaSchema, PlanInputSchema, type PlanIdea, type PlanInput } from "./plan.model.js";

export interface ContentPlanProps {
  /** The channel this plan is for. */
  channelId: string;
  /** YYYY-MM; one plan per month. */
  month: string;
  input: PlanInput;
  theme: string | null;
  ideas: PlanIdea[];
  createdAt: Date;
  updatedAt: Date;
}

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }, what: string) => e.issues.map((i) => `${i.path.map(String).join(".") || what}: ${i.message}`);

export function parseMonth(month: string): string {
  if (!MONTH_RE.test(month)) throw new ValidationError(`"${month}" is not a month (use YYYY-MM)`);
  return month;
}

export function parsePlanInput(raw: unknown): PlanInput {
  const r = PlanInputSchema.safeParse(raw ?? {});
  if (!r.success) throw new ValidationError("Invalid plan settings", issues(r.error, "settings"));
  return r.data;
}

/** A month of video ideas, each with its posting date and time and the inputs for the Videos form. */
export class ContentPlan {
  private constructor(private props: ContentPlanProps) {}

  static create(channelId: string, month: string, input: PlanInput, theme: string, ideas: PlanIdea[], now = new Date()): ContentPlan {
    return new ContentPlan({ channelId, month: parseMonth(month), input, theme, ideas, createdAt: now, updatedAt: now });
  }

  static restore(props: ContentPlanProps): ContentPlan {
    return new ContentPlan(structuredClone(props));
  }

  get channelId() { return this.props.channelId; }
  get month() { return this.props.month; }
  get input() { return this.props.input; }
  get theme() { return this.props.theme; }
  get ideas(): readonly PlanIdea[] { return this.props.ideas; }
  get updatedAt() { return this.props.updatedAt; }

  /** Replace the whole plan (generated again). */
  replace(input: PlanInput, theme: string, ideas: PlanIdea[]): void {
    this.props.input = input;
    this.props.theme = theme;
    this.props.ideas = ideas;
    this.touch();
  }

  idea(index: number): PlanIdea {
    const idea = this.props.ideas[index];
    if (!Number.isInteger(index) || !idea) throw new NotFoundError(`Plan ${this.month} has no idea ${index + 1}`);
    return idea;
  }

  editIdea(index: number, raw: unknown): void {
    const current = this.idea(index);
    const patch = PlanIdeaPatchSchema.safeParse(raw ?? {});
    if (!patch.success) throw new ValidationError("Invalid idea", issues(patch.error, "idea"));
    const next = PlanIdeaSchema.safeParse({ ...current, ...patch.data, projectId: current.projectId });
    if (!next.success) throw new ValidationError("Invalid idea", issues(next.error, "idea"));
    if (!next.data.date.startsWith(this.month)) throw new ValidationError(`The date must be in ${this.month}`);
    this.props.ideas[index] = next.data;
    this.props.ideas.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    this.touch();
  }

  linkProject(index: number, projectId: string): void {
    this.idea(index).projectId = projectId;
    this.touch();
  }

  /** Swap in a newly generated idea; the date, time and language stay. */
  replaceIdea(index: number, idea: PlanIdea): void {
    const current = this.idea(index);
    this.props.ideas[index] = { ...idea, date: current.date, time: current.time, language: current.language, projectId: null };
    this.touch();
  }

  private touch(): void {
    this.props.updatedAt = new Date();
  }

  toProps(): ContentPlanProps {
    return structuredClone(this.props);
  }
}
