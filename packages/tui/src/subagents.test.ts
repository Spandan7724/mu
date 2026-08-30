import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@mu/core";
import { subagentRenderers } from "./registry.ts";
import { stripAnsi } from "./style.ts";

const result: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "search-1",
  toolName: "search",
  content: [{ type: "text", text: "The parser is owned by packages/parser.ts:10-40." }],
  details: {
    type: "subagent",
    kind: "search",
    description: "Trace parser ownership",
    model: "openai-codex/gpt-5.6-terra",
    thinkingLevel: "low",
    durationMs: 1234,
    reason: "done",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: { path: "packages/parser.ts", offset: 10, limit: 31 },
          },
          {
            type: "toolCall",
            id: "bash-1",
            name: "bash",
            arguments: { command: "rg -n 'parse' packages" },
          },
        ],
        model: "openai-codex/gpt-5.6-terra",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "source" }],
        isError: false,
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "bash-1",
        toolName: "bash",
        content: [{ type: "text", text: "match" }],
        isError: false,
        timestamp: 3,
      },
    ],
  },
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  isError: false,
  timestamp: 4,
};

describe("subagent transcript rendering", () => {
  test("uses a compact disclosure summary and a clean indented activity trace", () => {
    const renderer = subagentRenderers.search;
    if (!renderer) throw new Error("missing search renderer");
    const compact = renderer(
      { toolName: "search", args: { query: "Trace parser ownership" }, result },
      { width: 100, depth: "none" },
    ).map(stripAnsi);
    const expanded = renderer(
      { toolName: "search", args: { query: "Trace parser ownership" }, result, expanded: true },
      { width: 100, depth: "none" },
    ).map(stripAnsi);

    expect(compact).toHaveLength(1);
    expect(compact[0]).toContain("searched codebase Trace parser ownership");
    expect(compact[0]).toContain("gpt-5.6-terra");
    expect(expanded).toContain("    · read packages/parser.ts L10-40");
    expect(expanded).toContain("    · $ rg -n 'parse' packages");
    expect(expanded).toContain("    result");
    expect(expanded.join("\n")).toContain("packages/parser.ts:10-40");
    expect(expanded.some((line) => line.includes("│ │"))).toBe(false);
  });
});
