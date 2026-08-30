import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@mu/core";
import { subagentRenderers } from "./registry.ts";
import { stripAnsi } from "./style.ts";

const result: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "search-1",
  toolName: "search",
  content: [
    {
      type: "text",
      text: "## Ownership\n\nThe parser is owned by `packages/parser.ts:10-40`.\n\n- Keep this boundary.",
    },
  ],
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
  test("shows the full prompt, grouped activity, and an indented Markdown result", () => {
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
    expect(compact[0]).toContain("✓");
    expect(compact[0]).toContain("gpt-5.6-terra");
    expect(expanded[0]).not.toContain("Trace parser ownership");
    expect(expanded).toContain("    prompt");
    expect(expanded).toContain("      Trace parser ownership");
    expect(expanded).toContain("    activity · 2 actions");
    expect(expanded).toContain("      files");
    expect(expanded).toContain("      · read packages/parser.ts L10-40");
    expect(expanded).toContain("      commands");
    expect(expanded).toContain("      · $ rg -n 'parse' packages");
    expect(expanded).toContain("    result");
    expect(expanded).toContain("      Ownership");
    expect(expanded).toContain("      • Keep this boundary.");
    expect(expanded.join("\n")).toContain("packages/parser.ts:10-40");
    for (const line of expanded.slice(1)) {
      if (line.length > 0) expect(line.startsWith("    ")).toBe(true);
    }
    expect(expanded.some((line) => line.includes("│ │"))).toBe(false);
  });

  test("dims the complete prompt instead of only retaining its compact prefix", () => {
    const renderer = subagentRenderers.counsel;
    if (!renderer) throw new Error("missing counsel renderer");
    const prompt =
      "Review the current design end to end.\nReturn the decisive evidence and reversal condition.";
    const colored = renderer(
      {
        toolName: "counsel",
        args: { question: prompt },
        result: {
          ...result,
          toolCallId: "counsel-1",
          toolName: "counsel",
          details: { ...(result.details as object), kind: "counsel", description: prompt },
        },
        expanded: true,
      },
      { width: 100, depth: "truecolor" },
    );

    expect(colored.join("\n")).toContain("\u001b[2mReview the current design end to end.");
    expect(colored.join("\n")).toContain(
      "\u001b[2mReturn the decisive evidence and reversal condition.",
    );
    expect(colored[0]).toContain("38;2;230;195;132m");
    const ansi256 = renderer(
      { toolName: "counsel", args: { question: prompt }, running: true },
      { width: 100, depth: "ansi256" },
    );
    const ansi16 = renderer(
      { toolName: "counsel", args: { question: prompt }, running: true },
      { width: 100, depth: "ansi16" },
    );
    expect(ansi256[0]).toContain("38;5;180m");
    expect(ansi16[0]).toContain("93m");
  });

  test("animates running specialist rows with Braille and elapsed time", () => {
    const renderer = subagentRenderers.search;
    if (!renderer) throw new Error("missing search renderer");
    const info = {
      toolName: "search",
      args: { query: "Trace parser ownership" },
      running: true,
    };

    const first = renderer(
      { ...info, elapsedMs: 0 },
      { width: 100, depth: "none", spinnerFrame: 0 },
    );
    const second = renderer(
      { ...info, elapsedMs: 12_000 },
      { width: 100, depth: "none", spinnerFrame: 1 },
    );

    expect(first[0]).toContain("⠋ searching codebase Trace parser ownership · 0ms");
    expect(second[0]).toContain("⠙ searching codebase Trace parser ownership · 12s");
    expect(second[0]).not.toContain("running");
  });

  test("task expansion shows its complete delegated brief and formatted result", () => {
    const renderer = subagentRenderers.task;
    if (!renderer) throw new Error("missing task renderer");
    const expanded = renderer(
      {
        toolName: "task",
        args: {
          description: "Implement parser",
          prompt: "Implement the parser in `packages/parser.ts`, then run its focused tests.",
        },
        result: {
          ...result,
          toolCallId: "task-1",
          toolName: "task",
          details: { ...(result.details as object), kind: "task", description: "Implement parser" },
        },
        expanded: true,
      },
      { width: 100, depth: "none" },
    ).map(stripAnsi);

    expect(expanded[0]).toContain("delegated");
    expect(expanded[0]).not.toContain("Implement parser");
    expect(expanded).toContain(
      "      Implement the parser in `packages/parser.ts`, then run its focused tests.",
    );
    expect(expanded).toContain("      Ownership");
  });
});
