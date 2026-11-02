import { describe, expect, test } from "bun:test";
import { AiError } from "./errors.ts";
import {
  MAX_TURN_RETRIES,
  MAX_TURN_RETRY_DELAY_MS,
  turnRetryDelayMs,
  withRetries,
} from "./retry.ts";

describe("withRetries", () => {
  test("retries retryable errors then succeeds", async () => {
    let attempts = 0;
    const result = await withRetries(
      async () => {
        attempts++;
        if (attempts < 3) throw new AiError("rate_limit", "429", { retryAfterMs: 1 });
        return "ok";
      },
      { maxRetries: 3 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("does not retry non-retryable errors", async () => {
    let attempts = 0;
    await expect(
      withRetries(
        async () => {
          attempts++;
          throw new AiError("auth", "401");
        },
        { maxRetries: 3 },
      ),
    ).rejects.toThrow("401");
    expect(attempts).toBe(1);
  });

  test("gives up after maxRetries", async () => {
    let attempts = 0;
    await expect(
      withRetries(
        async () => {
          attempts++;
          throw new AiError("overloaded", "529", { retryAfterMs: 1 });
        },
        { maxRetries: 2 },
      ),
    ).rejects.toThrow("529");
    expect(attempts).toBe(3);
  });

  test("abort interrupts the backoff sleep", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(
      withRetries(
        async () => {
          throw new AiError("rate_limit", "429", { retryAfterMs: 10_000 });
        },
        { maxRetries: 1, signal: controller.signal },
      ),
    ).rejects.toThrow("aborted");
  });
});

describe("withRetries and long server waits", () => {
  test("a retry-after beyond the cap surfaces at once instead of retrying early", async () => {
    let attempts = 0;
    const failure = await withRetries(
      async () => {
        attempts++;
        throw new AiError("overloaded", "503", { retryAfterMs: 302_000 });
      },
      { maxRetries: 2, maxRetryDelayMs: 60_000 },
    ).catch((error) => error);
    expect(attempts).toBe(1);
    expect((failure as AiError).retryAfterMs).toBe(302_000);
  });
});

describe("turnRetryDelayMs", () => {
  test("honours the server's wait up to the cap", () => {
    expect(turnRetryDelayMs({ errorKind: "overloaded", retryAfterMs: 302_000 }, 0)).toBe(302_000);
    expect(
      turnRetryDelayMs({ errorKind: "rate_limit", retryAfterMs: MAX_TURN_RETRY_DELAY_MS + 1 }, 0),
    ).toBeUndefined();
  });

  test("backs off without a server wait, and stops after the last attempt", () => {
    expect(turnRetryDelayMs({ errorKind: "network" }, 0)).toBe(2_000);
    expect(turnRetryDelayMs({ errorKind: "network" }, 1)).toBe(8_000);
    expect(turnRetryDelayMs({ errorKind: "network" }, 3)).toBe(60_000);
    expect(turnRetryDelayMs({ errorKind: "network" }, MAX_TURN_RETRIES)).toBeUndefined();
  });

  test("permanent failures do not retry", () => {
    for (const errorKind of ["auth", "bad_request", "context_too_long", "api", undefined]) {
      expect(turnRetryDelayMs({ ...(errorKind ? { errorKind } : {}) }, 0)).toBeUndefined();
    }
  });
});
