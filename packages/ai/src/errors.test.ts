import { describe, expect, test } from "bun:test";
import {
  AiError,
  classifyHttpError,
  classifyStreamError,
  isContextTooLongMessage,
} from "./errors.ts";

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

describe("classifyStreamError", () => {
  test("a Codex mid-stream overload is retryable and carries the server's wait", () => {
    const raw = JSON.stringify({
      type: "error",
      error: {
        type: "service_unavailable_error",
        code: "server_is_overloaded",
        headers: { "x-retry-metadata": "NO_MORE_RETRY", "retry-after": "302" },
        message: "Our servers are currently overloaded. Please try again later.",
        param: null,
      },
      sequence_number: 167,
    });
    const error = classifyStreamError(raw, raw);
    expect(error.kind).toBe("overloaded");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(302_000);
    expect(error.message).toBe(
      "Our servers are currently overloaded. Please try again later. (server_is_overloaded)",
    );
  });

  test("flat OpenAI and Anthropic error payloads", () => {
    expect(
      classifyStreamError({ type: "error", code: "rate_limit_exceeded", message: "slow" }, "").kind,
    ).toBe("rate_limit");
    const anthropic = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    expect(classifyStreamError(anthropic, anthropic).kind).toBe("overloaded");
    expect(
      classifyStreamError({ code: "context_length_exceeded", message: "too long" }, "").kind,
    ).toBe("context_too_long");
    expect(classifyStreamError({ code: "server_error", message: "boom" }, "").kind).toBe("api");
    expect(classifyStreamError("not json", "not json").message).toBe("not json");
  });
});
