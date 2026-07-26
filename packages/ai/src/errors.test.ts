import { describe, expect, test } from "bun:test";
import { AiError, classifyHttpError, isContextTooLongMessage } from "./errors.ts";

describe("classifyHttpError", () => {
  const h = (extra: Record<string, string> = {}) => new Headers(extra);

  test("auth for 401/403", () => {
    expect(classifyHttpError(401, "", h()).kind).toBe("auth");
    expect(classifyHttpError(403, "", h()).kind).toBe("auth");
  });

  test("rate limit for 429 with retry-after", () => {
    const err = classifyHttpError(429, "slow down", h({ "retry-after": "2" }));
    expect(err.kind).toBe("rate_limit");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
  });

  test("retry-after-ms takes precedence", () => {
    const err = classifyHttpError(429, "", h({ "retry-after-ms": "150", "retry-after": "9" }));
    expect(err.retryAfterMs).toBe(150);
  });

  test("overloaded for 529/503", () => {
    expect(classifyHttpError(529, "", h()).kind).toBe("overloaded");
    expect(classifyHttpError(503, "", h()).kind).toBe("overloaded");
    expect(classifyHttpError(529, "", h()).retryable).toBe(true);
  });

  test("api for other 5xx", () => {
    expect(classifyHttpError(500, "", h()).kind).toBe("api");
  });

  test("context_too_long for 400 with known messages", () => {
    for (const msg of [
      "prompt is too long: 250000 tokens > 200000 maximum",
      "This model's maximum context window was exceeded",
      "error code context_length_exceeded",
      "The input token count (2000000) exceeds the maximum",
    ]) {
      expect(classifyHttpError(400, msg, h()).kind).toBe("context_too_long");
    }
  });

  test("bad_request for other 400s, not retryable", () => {
    const err = classifyHttpError(400, "missing field", h());
    expect(err.kind).toBe("bad_request");
    expect(err.retryable).toBe(false);
  });
});

describe("isContextTooLongMessage", () => {
  test("negative case", () => {
    expect(isContextTooLongMessage("invalid api key")).toBe(false);
  });
});

describe("AiError", () => {
  test("network is retryable", () => {
    expect(new AiError("network", "boom").retryable).toBe(true);
  });
});
