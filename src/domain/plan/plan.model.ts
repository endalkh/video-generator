import { z } from "zod";

const tidy = (v: string) => v.replace(/\s+/g, " ").trim();
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Days of the week, 0 = Sunday … 6 = Saturday (like Date.getDay()). */
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Monthly plan settings (Ideas & schedule page). */
export const PlanInputSchema = z.object({
  channelName: z.string().transform(tidy).pipe(z.string().max(100)).optional().transform((v) => v || undefined),
  /** What the channel is about. */
  about: z.string().transform(tidy).pipe(z.string().min(3, "describe the channel in a few words").max(2000)),
  /** Used as the character for every video, so the channel has one recurring star. */
  mainCharacter: z.string().transform(tidy).pipe(z.string().max(300)).optional().transform((v) => v || undefined),
  /** "both" alternates Amharic and English videos. */
  language: z.enum(["en", "am", "both"]).default("both"),
  ageRange: z.string().transform(tidy).default("3-6"),
  /** Length of every video this month, in minutes (½–10). Leave out for 30-second songs. */
  videoMinutes: z.number().min(0.5).max(10).multipleOf(0.5).optional(),
  /** Days to post on (0 = Sunday). */
  postDays: z.array(z.number().int().min(0).max(6)).min(1, "pick at least one posting day").max(7).transform((d) => [...new Set(d)].sort()),
  weekdayTime: z.string().regex(TIME, "use HH:MM").default("16:00"),
  weekendTime: z.string().regex(TIME, "use HH:MM").default("09:00"),
  timezone: z.string().refine(isTimeZone, "unknown time zone").default("Africa/Addis_Ababa"),
  /** Anything special this month: holidays, themes, series. */
  notes: z.string().transform(tidy).pipe(z.string().max(2000)).optional().transform((v) => v || undefined),
});
export type PlanInput = z.infer<typeof PlanInputSchema>;

/** One idea as written by the model (the slot's date, time and language come from the schedule). */
export const PlanIdeaTextSchema = z.object({
  title: z.string().min(1),
  /** Exactly what goes in the Videos form's "What is the video about?" field. */
  topic: z.string().min(3),
  /** The one lesson or habit the video teaches. */
  lesson: z.string(),
  audioMode: z.enum(["song", "narration"]),
  sceneCount: z.number().int().min(2).max(12),
  thumbnailTitle: z.string(),
  /** YouTube video description. */
  videoDescription: z.string(),
  tags: z.array(z.string()),
});
export type PlanIdeaText = z.infer<typeof PlanIdeaTextSchema>;

/** The model's answer for a month. */
export const PlanTextSchema = z.object({
  /** Theme of the month, e.g. "Meskel and spring colours". */
  theme: z.string(),
  ideas: z.array(PlanIdeaTextSchema),
});
export type PlanText = z.infer<typeof PlanTextSchema>;

export interface PlanSlot {
  /** YYYY-MM-DD in the plan's time zone. */
  date: string;
  /** HH:MM in the plan's time zone. */
  time: string;
  language: "en" | "am";
}

export const PlanIdeaSchema = PlanIdeaTextSchema.extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(TIME),
  language: z.enum(["en", "am"]),
  /** The video project made from this idea, once "Make this video" was clicked. */
  projectId: z.string().nullable().default(null),
});
export type PlanIdea = z.infer<typeof PlanIdeaSchema>;

/** Fields of an idea the user can edit. */
export const PlanIdeaPatchSchema = PlanIdeaSchema.omit({ projectId: true }).partial();

/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Posting slots for a month: every chosen weekday, at the weekday or weekend time, skipping days already past.
 * With language "both", videos alternate Amharic / English.
 */
export function planSlots(month: string, input: Pick<PlanInput, "postDays" | "weekdayTime" | "weekendTime" | "timezone" | "language">, now = new Date()): PlanSlot[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = todayIn(input.timezone, now);
  const slots: PlanSlot[] = [];
  for (let d = 1; d <= days; d++) {
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (!input.postDays.includes(weekday)) continue;
    const date = `${month}-${String(d).padStart(2, "0")}`;
    if (date < today) continue;
    const language = input.language === "both" ? (slots.length % 2 === 0 ? "am" : "en") : input.language;
    slots.push({ date, time: weekday === 0 || weekday === 6 ? input.weekendTime : input.weekdayTime, language });
  }
  return slots;
}

export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "Tue 4 Nov 2026" */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
