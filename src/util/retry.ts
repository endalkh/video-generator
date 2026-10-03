import { log } from "./log.js";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  /** Return false to fail fast (e.g. auth / validation errors). */
  shouldRetry?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Heuristic: retry on rate limits, 5xx, network errors; not on 4xx client errors. */
export function isTransientError(err: unknown): boolean {
  const e = err as { status?: number; code?: string | number; message?: string };
  // A monthly spending cap or billing problem comes back as 429 too, but waiting won't fix it.
  if (isBillingStop(err)) return false;
  const status = typeof e?.status === "number" ? e.status : typeof e?.code === "number" ? e.code : undefined;
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  const msg = String(e?.message ?? err);
  if (/\b(400|401|403|404)\b/.test(msg) || /API key|permission|invalid argument/i.test(msg)) return false;
  return true;
}

/** Spend cap reached, or a billing problem: retrying can't help until the account is fixed. */
export function isBillingStop(err: unknown): boolean {
  return /spend(ing)? cap|prepay|credit balance|dunning/i.test(String((err as { message?: string })?.message ?? err));
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, baseDelayMs = 1000, maxDelayMs = 30_000, label = "operation", shouldRetry = isTransientError } = opts;
  const doSleep = opts.sleep ?? sleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      log.warn(`${label} failed (attempt ${attempt + 1}/${retries + 1}): ${(err as Error)?.message ?? err}; retrying in ${Math.round(delay)}ms`);
      await doSleep(delay);
      attempt++;
    }
  }
}
