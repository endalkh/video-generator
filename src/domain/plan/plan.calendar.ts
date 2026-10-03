import { dayLabel, type PlanIdea } from "./plan.model.js";

/** Minutes the zone is ahead of UTC at a given instant. */
function offsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs) / 60_000;
}

/** A wall-clock date + time in `timeZone` as a UTC Date (handles DST). */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - offsetMinutes(guess, timeZone) * 60_000;
  const again = guess - offsetMinutes(utc, timeZone) * 60_000;
  if (again !== utc) utc = again;
  return new Date(utc);
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Fold lines to 75 octets (RFC 5545), never splitting a UTF-8 character. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** iCalendar file: one event per posting slot, with a reminder two days before to make the video. */
export function planToIcs(opts: { month: string; channelName?: string; timezone: string; ideas: PlanIdea[]; now?: Date }): string {
  const now = stamp(opts.now ?? new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kids Animation Studio//Ideas and schedule//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${escape(`${opts.channelName ?? "YouTube"} posting plan ${opts.month}`)}`];
  opts.ideas.forEach((idea, i) => {
    const start = zonedToUtc(idea.date, idea.time, opts.timezone);
    const end = new Date(start.getTime() + 30 * 60_000);
    const body = [
      `Post at ${idea.time} (${opts.timezone}), ${dayLabel(idea.date)}`,
      `Language: ${idea.language === "am" ? "Amharic" : "English"} · ${idea.audioMode} · ${idea.sceneCount} scenes`,
      `Topic for the app: ${idea.topic}`,
      `Lesson: ${idea.lesson}`,
      `Thumbnail title: ${idea.thumbnailTitle}`,
      "",
      idea.videoDescription,
      "",
      idea.tags.join(", "),
    ].join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${opts.month}-${i + 1}-${idea.date}@kids-animation-studio`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${escape(`📺 Post: ${idea.title}`)}`,
      `DESCRIPTION:${escape(body)}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escape(`Make the video "${idea.title}" (it's posted in 2 days)`)}`,
      "TRIGGER:-P2D",
      "END:VALARM",
      "END:VEVENT",
    );
  });
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
