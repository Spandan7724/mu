import { describe, expect, test } from "bun:test";
import type { LlmContext, Provider } from "@mu/ai";
import {
  CompactionError,
  compact,
  estimateTextTokens,
  serializeCompactionMessages,
} from "./compaction.ts";
import { type AgentMessage, userMessage } from "./messages.ts";
import { microcompact } from "./microcompaction.ts";
import { FakeProvider, fakeModel } from "./testing/fake-provider.ts";

const model = { ...fakeModel, contextWindow: 8_000 };
const observation = (text: string): AgentMessage => ({
  role: "toolResult",
  toolCallId: "c1",
  toolName: "inspect",
  content: [{ type: "text", text }],
  timestamp: 1,
  isError: false,
});

function prompt(request: LlmContext) {
  return request.messages
    .flatMap((message) =>
      message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    )
    .join("\n");
}

describe("task-aware evidence compaction", () => {
  test("every character of oversized evidence is processed with provenance within the request budget", async () => {
    const text = Array.from({ length: 6_000 }, (_, i) => `observation-${i}\n`).join("");
    const source = observation(text);
    const provider = new FakeProvider(
      Array.from({ length: 40 }, () => ({
        content: [
          {
            type: "text" as const,
            text: "## Evidence for the next decision\nRelevant observations retained.",
          },
        ],
      })),
    );
    const result = await compact([source], { provider, model });
    expect(provider.callCount).toBeGreaterThan(2);
    let reconstructed = "";
    provider.requests.forEach((request, index) => {
      const body = prompt(request);
      const sourceText = body.match(/<conversation>\n([\s\S]*?)\n<\/conversation>/)?.[1] ?? "";
      const match = sourceText.match(/^\[Source "message-0"; character offset (\d+)\]\n([\s\S]*)$/);
      expect(Number(match?.[1])).toBe(reconstructed.length);
      reconstructed += match?.[2] ?? "";
      const system =
        typeof request.systemPrompt === "string"
          ? request.systemPrompt
          : (request.systemPrompt?.map((section) => section.text).join("\n") ?? "");
      expect(
        estimateTextTokens(system + body) + (provider.streamOptions[index]?.maxTokens ?? 0),
      ).toBeLessThan(model.contextWindow);
    });
    expect(reconstructed).toBe(serializeCompactionMessages([source]));
    expect(result.usage.inputTokens).toBe(10 * provider.callCount);
    expect(result.usage.outputTokens).toBe(5 * provider.callCount);
    expect(new Set(provider.streamOptions.map((options) => options?.sessionId)).size).toBe(
      provider.callCount,
    );
  });

  test("recent context and the latest correction guide every chunk without becoming summarized source", async () => {
    const source = observation("old diagnostic\n".repeat(5_000));
    const recent = userMessage(
      "Correction: preserve callback order; investigate cancellation now.",
    );
    const provider = new FakeProvider(
      Array.from({ length: 20 }, () => ({
        content: [
          {
            type: "text" as const,
            text: "## Constraints and corrections\nPreserve callback order.",
          },
        ],
      })),
    );
    const result = await compact([source, recent], { provider, model, keepRecentTokens: 100 });
    expect(result.keptMessages).toEqual([recent]);
    for (const request of provider.requests) {
      expect(prompt(request)).toContain('recent-context reference-only="true"');
      expect(prompt(request)).toContain("investigate cancellation now");
      expect(
        prompt(request).match(/<conversation>\n([\s\S]*?)\n<\/conversation>/)?.[1],
      ).not.toContain("Correction:");
    }
  });

  test("overflow retries shrink the current chunk and later process its entire remainder", async () => {
    const provider = new FakeProvider([
      {
        content: [],
        stopReason: "error",
        errorMessage: "maximum context length exceeded",
        usage: { inputTokens: 20 },
      },
      ...Array.from({ length: 20 }, () => ({
        content: [{ type: "text" as const, text: "handoff" }],
      })),
    ]);
    const text = "x".repeat(22_000);
    const result = await compact([observation(text)], { provider, model });
    const chunks = provider.requests
      .slice(1)
      .map(
        (request) =>
          prompt(request).match(
            /<conversation>\n\[Source .*?\]\n([\s\S]*?)\n<\/conversation>/,
          )?.[1] ?? "",
      );
    expect(chunks.join("")).toBe(serializeCompactionMessages([observation(text)]));
    expect(result.usage.inputTokens).toBe(20 + 10 * (provider.callCount - 1));
  });

  test("failure in a later chunk reports usage from every paid call", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "partial handoff" }], usage: { costUsd: 0.2 } },
      { content: [], errorMessage: "provider unavailable", usage: { costUsd: 0.3 } },
    ]);
    try {
      await compact([observation("x".repeat(40_000))], { provider, model });
      throw new Error("Expected compaction to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CompactionError);
      expect((error as CompactionError).usage?.costUsd).toBe(0.5);
      expect((error as Error).message).toContain("provider unavailable");
    }
  });

  test("cancellation and budgets stop before another source chunk is sampled", async () => {
    for (const cancel of [true, false]) {
      const controller = new AbortController();
      const scripted = new FakeProvider([
        { content: [{ type: "text", text: "handoff" }], usage: { costUsd: 0.2 } },
      ]);
      const provider: Provider = {
        id: "fake",
        stream: (model, context, options) => {
          const stream = scripted.stream(model, context, options);
          if (cancel) void stream.result().then(() => controller.abort());
          return stream;
        },
      };
      await expect(
        compact([observation("x".repeat(40_000))], {
          provider,
          model,
          signal: controller.signal,
          canContinue: (usage) => (usage.costUsd ?? 0) < 0.1,
        }),
      ).rejects.toThrow("Compaction failed");
      expect(scripted.callCount).toBe(1);
    }
  });

  test("duplicate-only eviction leaves unique observations and one exact duplicate body", () => {
    const unique = observation("unique evidence ".repeat(100));
    const repeated = observation("repeated output ".repeat(100));
    const newest = { ...repeated, toolCallId: "latest" } as AgentMessage;
    const result = microcompact([unique, repeated, newest], {
      textPolicy: "duplicates",
      keepRecent: 1,
    });
    expect(result.messages[0]).toBe(unique);
    expect(result.messages[2]).toBe(newest);
    expect(JSON.stringify(result.messages[1])).toContain("tool result latest");
    expect(result.evicted).toBe(1);
  });
});
