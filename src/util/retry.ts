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

/** Spend cap reached, a billing problem, or a model with no free tier on the free key: retrying can't help. */
export function isBillingStop(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return /spend(ing)? cap|prepay|credit balance|dunning/i.test(msg) || (/free_tier/i.test(msg) && /limit:\s*0\b/.test(msg));
}

/** Longest "retry in Ns" from the API that's worth waiting for inside one request (per-minute quotas). */
const MAX_HINTED_WAIT_MS = 90_000;
/** Extra tries allowed when the API says exactly how long to wait (e.g. free tier: 3 requests per minute). */
const HINTED_EXTRA_RETRIES = 6;

/** The wait the API asks for on a 429 ("Please retry in 3.02s" / RetryInfo "retryDelay":"3s"), in ms. */
export function retryHintMs(err: unknown): number | undefined {
  const msg = String((err as { message?: string })?.message ?? err);
  const m = /retry in ([\d.]+)\s*s\b/i.exec(msg) ?? /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(msg);
  if (!m) return undefined;
  const ms = Math.ceil(Number(m[1]) * 1000);
  return Number.isFinite(ms) ? ms : undefined;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, baseDelayMs = 1000, maxDelayMs = 30_000, label = "operation", shouldRetry = isTransientError } = opts;
  const doSleep = opts.sleep ?? sleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      // A spend cap or billing problem never clears by waiting, whatever the caller allows.
      if (isBillingStop(err) || !shouldRetry(err)) throw err;
      // A short "retry in Ns" (per-minute quota): wait exactly that long, a few more times than usual.
      const hint = retryHintMs(err);
      const hinted = hint !== undefined && hint <= MAX_HINTED_WAIT_MS;
      if (attempt >= retries + (hinted ? HINTED_EXTRA_RETRIES : 0)) throw err;
      const delay = hinted ? hint + 500 + Math.random() * 1000 : Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      log.warn(`${label} failed (attempt ${attempt + 1}/${retries + 1 + (hinted ? HINTED_EXTRA_RETRIES : 0)}): ${(err as Error)?.message ?? err}; retrying in ${Math.round(delay)}ms`);
      await doSleep(delay);
      attempt++;
    }
  }
}
