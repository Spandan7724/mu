import { AiError, isRetryableErrorKind } from "./errors.ts";

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

function abortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelayMs(error: AiError, retryIndex: number, maxDelayMs: number): number {
  if (error.retryAfterMs !== undefined && error.retryAfterMs > 0) {
    return Math.min(error.retryAfterMs, maxDelayMs);
  }
  const exponential = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
  return exponential * (1 - Math.random() * 0.25);
}

export interface RetryOpts {
  maxRetries?: number;
  maxRetryDelayMs?: number;
  signal?: AbortSignal;
}

// Retries the initial request on retryable AiErrors (rate limit / overload /
// network). Streams that fail mid-flight are not retried here. A server asking
// for a longer wait than the cap is not hammered early: the error surfaces with
// its retryAfterMs so the caller can wait the full time.
export async function withRetries<T>(request: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const maxDelayMs = opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  let remaining = maxRetries;
  for (;;) {
    try {
      return await request();
    } catch (error) {
      if (opts.signal?.aborted) throw abortError();
      if (remaining <= 0 || !(error instanceof AiError) || !error.retryable) throw error;
      if (error.retryAfterMs !== undefined && error.retryAfterMs > maxDelayMs) throw error;
      const retryIndex = maxRetries - remaining;
      remaining--;
      await sleep(retryDelayMs(error, retryIndex, maxDelayMs), opts.signal);
    }
  }
}

export const MAX_TURN_RETRIES = 4;
// The longest server-requested wait a turn sits out; asking for more (a usage
// limit that resets in hours) fails the turn instead.
export const MAX_TURN_RETRY_DELAY_MS = 10 * 60_000;

// Delay before re-running a turn whose stream failed with a transient error
// (after the request-level retries), or undefined when it should not retry.
export function turnRetryDelayMs(
  failure: { errorKind?: string; retryAfterMs?: number },
  attempt: number,
): number | undefined {
  if (!isRetryableErrorKind(failure.errorKind) || attempt >= MAX_TURN_RETRIES) return undefined;
  if (failure.retryAfterMs !== undefined && failure.retryAfterMs > 0) {
    return failure.retryAfterMs <= MAX_TURN_RETRY_DELAY_MS ? failure.retryAfterMs : undefined;
  }
  return Math.min(2_000 * 4 ** attempt, 60_000);
}
