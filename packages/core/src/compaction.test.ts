import { describe, expect, test } from "bun:test";
import {
  AUTO_COMPACT_THRESHOLD,
  applyCompaction,
  compact,
  contextState,
  estimateTokens,
  planCompaction,
  shouldCompact,
} from "./compaction.ts";
import { type AgentMessage, customMessage, userMessage } from "./messages.ts";
import { FakeProvider, fakeModel, type ScriptedTurn } from "./testing/fake-provider.ts";

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "fake/fake-1",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end",
    timestamp: 1,
  };
}

function toolResult(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

describe("token accounting", () => {
  test("estimates from message content", () => {
    expect(estimateTokens([userMessage("x".repeat(350))])).toBeGreaterThan(90);
    expect(estimateTokens([])).toBe(0);
  });

  test("images count as substantial context", () => {
    const withImage: AgentMessage = {
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "aWJvcg==" }],
      timestamp: 1,
    };
    expect(estimateTokens([withImage])).toBeGreaterThan(100);
  });

  test("reported usage wins over the estimate when it is larger", () => {
    const state = contextState(fakeModel, [userMessage("short")], {
      inputTokens: 50_000,
      outputTokens: 10,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 0,
    });
    expect(state.tokens).toBe(60_000);
    expect(state.percent).toBeCloseTo(60_000 / fakeModel.contextWindow, 5);
  });

  test("reported cache usage plus estimated growth drives the context state", () => {
    const baseline = [userMessage("short")];
    const grown = [...baseline, toolResult("x".repeat(350))];
    const state = contextState(
      fakeModel,
      grown,
      {
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 200,
      },
      estimateTokens(baseline),
    );
    expect(state.tokens).toBe(1_210 + estimateTokens(grown) - estimateTokens(baseline));
  });

  test("threshold fires at the documented level", () => {
    const under = { tokens: 10, limit: 100, percent: 0.1 };
    const over = { tokens: 90, limit: 100, percent: 0.9 };
    expect(shouldCompact(under)).toBe(false);
    expect(shouldCompact(over)).toBe(true);
    expect(AUTO_COMPACT_THRESHOLD).toBe(0.85);
  });
});

describe("planCompaction", () => {
  test("keeps a recent tail", () => {
    const messages = Array.from({ length: 20 }, (_, i) => userMessage(`m${i}`));
    const { keepFromIndex } = planCompaction(messages);
    expect(keepFromIndex).toBeGreaterThan(0);
    expect(keepFromIndex).toBeLessThan(messages.length);
  });

  test("short conversations are left alone", () => {
    const messages = [userMessage("a"), assistant("b")];
    expect(planCompaction(messages).keepFromIndex).toBe(messages.length);
  });

  test("never splits a tool call from its result", () => {
    const messages: AgentMessage[] = [
      ...Array.from({ length: 10 }, (_, i) => userMessage(`m${i}`)),
      assistant("calling"),
      toolResult("r1"),
      toolResult("r2"),
      userMessage("after"),
    ];
    const { keepFromIndex } = planCompaction(messages);
    expect(messages[keepFromIndex]?.role).not.toBe("toolResult");
  });
});

describe("compact", () => {
  const longHistory = (): AgentMessage[] => [
    userMessage("Please refactor the client."),
    assistant("Looking at it."),
    toolResult("file contents here"),
    assistant("Found the issue."),
    userMessage("Also add retries."),
    assistant("Added."),
    toolResult("tests pass"),
    assistant("Done."),
    userMessage("Now document it."),
    assistant("Documenting."),
  ];

  test("summarizes the head and keeps the tail verbatim", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "The user asked for a refactor; retries were added." }] },
    ]);
    const result = await compact(longHistory(), { provider, model: fakeModel });

    expect(result.summary).toContain("retries were added");
    expect(result.keptMessages.length).toBeGreaterThan(0);
    expect(result.keptMessages.length).toBeLessThan(10);
    expect(result.tokensFreed).toBeGreaterThan(0);
  });

  test("the summarization request carries the enumerated instructions", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "summary" }] }]);
    await compact(longHistory(), { provider, model: fakeModel });

    const prompt = provider.requests[0]?.systemPrompt?.[0]?.text ?? "";
    expect(prompt).toContain("Decisions taken and why");
    expect(prompt).toContain("Current task state");
  });

  test("profile carryover is captured", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "summary" }] }]);
    const result = await compact(longHistory(), {
      provider,
      model: fakeModel,
      carryoverExtractor: () => ({ modifiedFiles: ["src/client.ts"], readFiles: ["src/api.ts"] }),
    });
    expect(result.carryover).toEqual({
      modifiedFiles: ["src/client.ts"],
      readFiles: ["src/api.ts"],
    });
  });

  test("a failed summarization throws rather than silently losing history", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "" }], errorMessage: "provider down" },
    ]);
    await expect(compact(longHistory(), { provider, model: fakeModel })).rejects.toThrow(
      "Compaction failed",
    );
  });

  const unusableSummaries: { name: string; turn: ScriptedTurn }[] = [
    {
      name: "empty text",
      turn: { content: [{ type: "text" as const, text: "" }] },
    },
    {
      name: "whitespace text",
      turn: { content: [{ type: "text" as const, text: " \n " }] },
    },
    {
      name: "thinking only",
      turn: { content: [{ type: "thinking" as const, thinking: "draft" }] },
    },
    {
      name: "tool call only",
      turn: {
        content: [{ type: "toolCall" as const, id: "c", name: "noop", arguments: {} }],
        stopReason: "toolUse" as const,
      },
    },
    {
      name: "length-truncated",
      turn: {
        content: [{ type: "text" as const, text: "partial summary" }],
        stopReason: "length" as const,
      },
    },
  ];

  test.each(unusableSummaries)("rejects an unusable $name summary", async ({ turn }) => {
    const provider = new FakeProvider([turn]);
    await expect(compact(longHistory(), { provider, model: fakeModel })).rejects.toThrow(
      "Compaction failed",
    );
  });

  test("returns compactor usage and subtracts summary plus carryover from tokens freed", async () => {
    const messages = longHistory();
    const provider = new FakeProvider([
      {
        content: [{ type: "text", text: "A deliberately substantial retained summary." }],
        usage: { inputTokens: 321, outputTokens: 45, costUsd: 0.25 },
      },
    ]);
    const result = await compact(messages, {
      provider,
      model: fakeModel,
      carryoverExtractor: () => ({ files: ["a.ts", "b.ts"] }),
    });
    expect(result.usage.inputTokens).toBe(321);
    expect(result.usage.costUsd).toBe(0.25);
    expect(result.tokensFreed).toBe(
      Math.max(0, estimateTokens(messages) - estimateTokens(applyCompaction(result))),
    );
    expect(result.tokensFreed).toBeLessThan(estimateTokens(messages.slice(0, 7)));
  });
});

describe("applyCompaction", () => {
  test("produces a summary message followed by the tail", () => {
    const kept = [userMessage("recent")];
    const messages = applyCompaction({
      summary: "Earlier: did the thing.",
      keptMessages: kept,
      tokensFreed: 100,
    });

    expect(messages.length).toBe(2);
    expect(messages[0]?.role).toBe("custom");
    if (messages[0]?.role === "custom") {
      expect(messages[0].customType).toBe("compaction-summary");
      expect(messages[0].content[0]?.type === "text" && messages[0].content[0].text).toContain(
        "did the thing",
      );
    }
    expect(messages[1]).toBe(kept[0] as AgentMessage);
  });

  test("carryover is rendered into the summary message", () => {
    const messages = applyCompaction({
      summary: "s",
      carryover: { modifiedFiles: ["a.ts", "b.ts"], readFiles: [] },
      keptMessages: [],
      tokensFreed: 0,
    });
    const text =
      messages[0]?.role === "custom" && messages[0].content[0]?.type === "text"
        ? messages[0].content[0].text
        : "";
    expect(text).toContain('"modifiedFiles"');
    expect(text).toContain('"a.ts"');
    expect(text).toContain('"readFiles": []');
  });

  test("structured carryover is deterministic and preserves nested values", () => {
    const carryover = {
      todos: [
        { status: "done", content: "handle commas, and\nnewlines" },
        { content: "next", status: "pending" },
      ],
      metadata: { z: true, a: null },
    };
    const first = applyCompaction({
      summary: "s",
      carryover,
      keptMessages: [],
      tokensFreed: 0,
    });
    const second = applyCompaction({
      summary: "s",
      carryover: {
        metadata: { a: null, z: true },
        todos: carryover.todos,
      },
      keptMessages: [],
      tokensFreed: 0,
    });
    expect(first[0]?.content).toEqual(second[0]?.content);
    expect(JSON.stringify(first)).not.toContain("[object Object]");
  });

  test("an empty summary leaves the transcript untouched", () => {
    const kept = [userMessage("only")];
    expect(applyCompaction({ summary: "", keptMessages: kept, tokensFreed: 0 })).toBe(kept);
  });

  test("the compacted transcript is what the model would receive next", () => {
    const messages = applyCompaction({
      summary: "prior work",
      carryover: { modifiedFiles: ["x.ts"] },
      keptMessages: [userMessage("continue")],
      tokensFreed: 500,
    });
    // Summary + carryover + tail only — none of the summarized history.
    expect(messages.length).toBe(2);
    expect(estimateTokens(messages)).toBeLessThan(200);
  });
});

describe("custom message hygiene", () => {
  test("the summary is a typed message, never a system-prompt edit", () => {
    const messages = applyCompaction({
      summary: "s",
      keptMessages: [],
      tokensFreed: 0,
    });
    expect(messages[0]?.role).toBe("custom");
    expect(messages.every((m) => m.role !== "assistant")).toBe(true);
  });

  test("a compaction summary round-trips as a custom message", () => {
    const message = customMessage("compaction-summary", "text");
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });
});
