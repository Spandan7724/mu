import { describe, expect, test } from "bun:test";
import { AiError } from "./errors.ts";
import { withRetries } from "./retry.ts";

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
