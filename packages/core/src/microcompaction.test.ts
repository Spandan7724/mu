import { describe, expect, test } from "bun:test";
import { AiError } from "@mu/ai";
import { estimateTokens } from "./compaction.ts";
import { type AgentMessage, userMessage } from "./messages.ts";
import { IMAGE_TOMBSTONE, microcompact, TOMBSTONE } from "./microcompaction.ts";
import { isContextTooLongError, isContextTooLongResult, withContextRecovery } from "./recovery.ts";

function toolResult(text: string, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
    ...overrides,
  } as AgentMessage;
}

function imageResult(): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "capture_image",
    content: [{ type: "image", mimeType: "image/png", data: "x".repeat(2000) }],
    isError: false,
    timestamp: 1,
  };
}

describe("microcompaction", () => {
  test("evicts old tool results and leaves a re-runnable tombstone", () => {
    const messages: AgentMessage[] = [
      ...Array.from({ length: 10 }, () => toolResult("a lot of file content ".repeat(20))),
      userMessage("recent"),
    ];
    const result = microcompact(messages, { keepRecent: 2 });

    expect(result.evicted).toBeGreaterThan(0);
    expect(result.tokensFreed).toBeGreaterThan(0);
    const first = result.messages[0];
    expect(first?.role === "toolResult" && first.evicted).toBe(true);
    expect(
      first?.role === "toolResult" && first.content[0]?.type === "text" && first.content[0].text,
    ).toBe(TOMBSTONE);
    // The tombstone tells the model how to recover.
    expect(TOMBSTONE).toContain("re-run the tool");
  });

  test("images are evicted before text", () => {
    const messages: AgentMessage[] = [
      imageResult(),
      toolResult("short text"),
      userMessage("recent"),
    ];
    // A target that only needs the image gone.
    const result = microcompact(messages, { keepRecent: 1, targetTokens: 60 });

    const image = result.messages[0];
    expect(
      image?.role === "toolResult" && image.content[0]?.type === "text" && image.content[0].text,
    ).toBe(IMAGE_TOMBSTONE);
  });

  test("an image pinned with evictable:false is kept", () => {
    const pinned: AgentMessage = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "capture_image",
      content: [{ type: "image", mimeType: "image/png", data: "x".repeat(2000), evictable: false }],
      isError: false,
      timestamp: 1,
    };
    const result = microcompact([pinned, userMessage("recent")], { keepRecent: 1 });
    const kept = result.messages[0];
    expect(kept?.role === "toolResult" && kept.content[0]?.type).toBe("image");
  });

  test("recent messages are never touched", () => {
    const messages: AgentMessage[] = [
      toolResult("old content ".repeat(50)),
      toolResult("recent content ".repeat(50)),
    ];
    const result = microcompact(messages, { keepRecent: 1 });
    const recent = result.messages[1];
    expect(recent?.role === "toolResult" && recent.evicted).toBeUndefined();
  });

  test("user and assistant messages are never evicted", () => {
    const messages: AgentMessage[] = [
      userMessage("the original request ".repeat(30)),
      {
        role: "assistant",
        content: [{ type: "text", text: "reasoning ".repeat(30) }],
        model: "fake/fake-1",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end",
        timestamp: 1,
      },
      userMessage("recent"),
    ];
    const result = microcompact(messages, { keepRecent: 0, targetTokens: 1 });
    expect(result.evicted).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  test("error results are kept so failures are not retried blindly", () => {
    const messages: AgentMessage[] = [
      toolResult("command not found: fooo ".repeat(20), { isError: true }),
      userMessage("recent"),
    ];
    const result = microcompact(messages, { keepRecent: 0, targetTokens: 1 });
    const error = result.messages[0];
    expect(error?.role === "toolResult" && error.evicted).toBeUndefined();
  });

  test("stops once the target is reached", () => {
    const messages: AgentMessage[] = Array.from({ length: 20 }, () =>
      toolResult("content ".repeat(40)),
    );
    const target = Math.floor(estimateTokens(messages) / 2);
    const result = microcompact(messages, { keepRecent: 0, targetTokens: target });

    expect(estimateTokens(result.messages)).toBeLessThanOrEqual(target + 100);
    // It did not evict everything — it stopped when it had done enough.
    expect(result.evicted).toBeLessThan(messages.length);
  });

  test("an already-evicted message is not evicted twice", () => {
    const evicted = toolResult(TOMBSTONE, { evicted: true });
    const result = microcompact([evicted, userMessage("recent")], { keepRecent: 0 });
    expect(result.evicted).toBe(0);
  });
});

describe("reactive recovery", () => {
  test("recognizes a typed context-too-long error", () => {
    expect(isContextTooLongError(new AiError("context_too_long", "prompt is too long"))).toBe(true);
    expect(isContextTooLongError(new AiError("rate_limit", "429"))).toBe(false);
  });

  test("recognizes it from a message when untyped", () => {
    expect(isContextTooLongError(new Error("prompt is too long: 300000 tokens"))).toBe(true);
    expect(isContextTooLongError(new Error("connection reset"))).toBe(false);
  });

  test("recognizes it from a failed assistant turn", () => {
    expect(
      isContextTooLongResult({
        stopReason: "error",
        errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
      }),
    ).toBe(true);
    expect(isContextTooLongResult({ stopReason: "error", errorMessage: "auth failed" })).toBe(
      false,
    );
    expect(isContextTooLongResult({ stopReason: "end" })).toBe(false);
  });

  test("compacts once and retries", async () => {
    let attempts = 0;
    let recovered = 0;
    const result = await withContextRecovery({
      run: async () => {
        attempts++;
        return attempts === 1 ? "too long" : "ok";
      },
      recover: async () => {
        recovered++;
      },
      isRecoverable: (value) => value === "too long",
    });

    expect(result.value).toBe("ok");
    expect(result.recovered).toBe(true);
    expect(attempts).toBe(2);
    expect(recovered).toBe(1);
  });

  test("retries exactly once — a persistent failure surfaces", async () => {
    let attempts = 0;
    const result = await withContextRecovery({
      run: async () => {
        attempts++;
        return "too long";
      },
      recover: async () => {},
      isRecoverable: (value) => value === "too long",
    });

    expect(attempts).toBe(2);
    expect(result.value).toBe("too long"); // the real failure is not hidden
  });

  test("a successful call does not compact", async () => {
    let recovered = 0;
    const result = await withContextRecovery({
      run: async () => "ok",
      recover: async () => {
        recovered++;
      },
      isRecoverable: () => false,
    });
    expect(recovered).toBe(0);
    expect(result.recovered).toBe(false);
  });
});
