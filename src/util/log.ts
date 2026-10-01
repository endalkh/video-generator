type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

let threshold: Level = (process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : "info";

export function setLogLevel(level: Level): void {
  threshold = level;
}

function emit(level: Level, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const tag = { debug: paint(90, "debug"), info: paint(36, "info "), warn: paint(33, "warn "), error: paint(31, "error") }[level];
  const line = `${paint(90, new Date().toISOString().slice(11, 19))} ${tag} ${msg}`;
  // All logs go to stderr so stdout stays clean for machine-readable output.
  if (extra !== undefined) console.error(line, extra);
  else console.error(line);
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
  step: (name: string, m: string) => emit("info", `${paint(35, `[${name}]`)} ${m}`),
};
