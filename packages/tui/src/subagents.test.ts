import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@mu/core";
import { codingRenderers, RendererRegistry, subagentRenderers } from "./registry.ts";
import { stripAnsi } from "./style.ts";

function rendererRegistry(): RendererRegistry {
  const registry = new RendererRegistry();
  registry.registerAll(subagentRenderers);
  registry.registerAll(codingRenderers);
  return registry;
}

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
        details: { lines: 31 },
        isError: false,
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "bash-1",
        toolName: "bash",
        content: [{ type: "text", text: "match" }],
        details: { exitCode: 0, durationMs: 334 },
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
    const registry = rendererRegistry();
    const compact = renderer(
      { toolName: "search", args: { query: "Trace parser ownership" }, result },
      { width: 100, depth: "none" },
    ).map(stripAnsi);
    const expanded = renderer(
      { toolName: "search", args: { query: "Trace parser ownership" }, result, expanded: true },
      { width: 100, depth: "none" },
      registry,
    ).map(stripAnsi);

    expect(compact).toHaveLength(1);
    expect(compact[0]).toContain("searched codebase Trace parser ownership");
    expect(compact[0]).toContain("✓");
    expect(compact[0]).toContain("gpt-5.6-terra");
    expect(expanded[0]).not.toContain("Trace parser ownership");
    expect(expanded).toContain("    prompt");
    expect(expanded).toContain("      Trace parser ownership");
    expect(expanded).toContain("    activity · 2 actions");
    expect(expanded).toContain("      Explored 1 file, 1 search");
    expect(expanded).toContain("      │ read packages/parser.ts · 31 lines");
    expect(expanded).toContain("      │ ran rg -n 'parse' packages · ✓ 334ms");
    expect(expanded).not.toContain("      files");
    expect(expanded).not.toContain("      commands");
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
    const registry = rendererRegistry();
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
      registry,
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

  test("task expansion keeps its description above the complete brief and formatted result", () => {
    const renderer = subagentRenderers.task;
    if (!renderer) throw new Error("missing task renderer");
    const registry = rendererRegistry();
    const taskInfo = {
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
    };
    const compact = renderer(taskInfo, { width: 100, depth: "none" }, registry).map(stripAnsi);
    const expanded = renderer(
      { ...taskInfo, expanded: true },
      { width: 100, depth: "none" },
      registry,
    ).map(stripAnsi);

    expect(compact).toEqual(["  │ ✓ Implement parser · 2 actions · 1.2s"]);
    expect(compact[0]).not.toContain("delegated");
    expect(compact[0]).not.toContain("gpt-5.6-terra");
    expect(compact[0]).not.toContain("low");
    expect(expanded[0]).toContain("✓ Implement parser");
    expect(expanded[0]).not.toContain("delegated");
    expect(expanded[0]).toContain("gpt-5.6-terra");
    expect(expanded[0]).toContain("low");
    expect(expanded).toContain(
      "      Implement the parser in `packages/parser.ts`, then run its focused tests.",
    );
    expect(expanded).toContain("      Ownership");
  });

  test("a running task leads with its spinner and keeps model details out of the compact row", () => {
    const renderer = subagentRenderers.task;
    if (!renderer) throw new Error("missing task renderer");
    const running = renderer(
      {
        toolName: "task",
        args: { description: "Explore SDK and CLI", prompt: "Inspect the SDK and CLI." },
        running: true,
        elapsedMs: 64_000,
        progress: {
          type: "subagent-progress-state",
          kind: "task",
          description: "Explore SDK and CLI",
          model: "openai/gpt-5.6-terra",
          thinkingLevel: "none",
          messages: (result.details as { messages: unknown[] }).messages,
          answer: "",
        },
      },
      { width: 100, depth: "none", spinnerFrame: 0 },
    ).map(stripAnsi);

    expect(running).toEqual(["  │ ⠋ Explore SDK and CLI · 2 actions · 1m 4s"]);
    expect(running[0]).not.toContain("delegating");
    expect(running[0]).not.toContain("gpt-5.6-terra");
    expect(running[0]).not.toContain("none");
  });

  test("an expanded running task keeps its description and restores model details", () => {
    const renderer = subagentRenderers.task;
    if (!renderer) throw new Error("missing task renderer");
    const expanded = renderer(
      {
        toolName: "task",
        args: { description: "Explore SDK and CLI", prompt: "Inspect the SDK and CLI." },
        running: true,
        elapsedMs: 64_000,
        expanded: true,
        progress: {
          type: "subagent-progress-state",
          kind: "task",
          description: "Explore SDK and CLI",
          model: "openai/gpt-5.6-terra",
          thinkingLevel: "none",
          messages: (result.details as { messages: unknown[] }).messages,
          answer: "",
        },
      },
      { width: 100, depth: "none", spinnerFrame: 0 },
      rendererRegistry(),
    ).map(stripAnsi);

    expect(expanded[0]).toBe(
      "  │ ⠋ Explore SDK and CLI · openai/gpt-5.6-terra · none · 2 actions · 1m 4s",
    );
    expect(expanded[0]).not.toContain("delegating");
    expect(expanded).toContain("    prompt");
  });

  test("task descriptions use cerulean at every supported color depth", () => {
    const renderer = subagentRenderers.task;
    if (!renderer) throw new Error("missing task renderer");
    const info = {
      toolName: "task",
      args: { description: "Explore SDK and CLI", prompt: "Inspect the SDK and CLI." },
      running: true,
    };

    expect(renderer(info, { width: 100, depth: "truecolor" })[0]).toContain(
      "\u001b[1;38;2;86;182;232m⠋ Explore SDK and CLI\u001b[0m",
    );
    expect(renderer(info, { width: 100, depth: "ansi256" })[0]).toContain("38;5;74m");
    expect(renderer(info, { width: 100, depth: "ansi16" })[0]).toContain("96m");
    const completed = renderer(
      {
        ...info,
        running: false,
        result: {
          ...result,
          toolName: "task",
          details: {
            ...(result.details as object),
            kind: "task",
            description: "Explore SDK and CLI",
          },
        },
      },
      { width: 100, depth: "truecolor" },
    );
    expect(completed[0]).toContain("\u001b[1;38;2;86;182;232mExplore SDK and CLI\u001b[0m");
  });

  test("task activity reuses renderers registered by a custom profile", () => {
    const registry = rendererRegistry();
    registry.register("inspect_domain", () => ["  │ inspected widget · ✓ 9ms"]);
    const messages = (result.details as { messages: unknown[] }).messages;
    const customResult: ToolResultMessage = {
      ...result,
      toolCallId: "task-2",
      toolName: "task",
      details: {
        ...(result.details as object),
        kind: "task",
        messages: [
          {
            ...(messages[0] as object),
            content: [
              {
                type: "toolCall",
                id: "inspect-1",
                name: "inspect_domain",
                arguments: { name: "widget" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "inspect-1",
            toolName: "inspect_domain",
            content: [{ type: "text", text: "done" }],
            isError: false,
            timestamp: 2,
          },
        ],
      },
    };

    const expanded = registry
      .render(
        {
          toolName: "task",
          args: { description: "Inspect widget", prompt: "Inspect the widget." },
          result: customResult,
          expanded: true,
        },
        { width: 100, depth: "none" },
      )
      .map(stripAnsi);

    expect(expanded).toContain("      │ inspected widget · ✓ 9ms");
  });

  test("malformed nested delegation details cannot recursively render subagents", () => {
    const registry = rendererRegistry();
    const nestedResult: ToolResultMessage = {
      ...result,
      toolCallId: "nested-task",
      toolName: "task",
      details: { ...(result.details as object), kind: "task" },
    };
    const malformed: ToolResultMessage = {
      ...result,
      details: {
        ...(result.details as object),
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "nested-task",
                name: "task",
                arguments: { prompt: "recurse" },
              },
            ],
            model: "fake/fake-1",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            stopReason: "toolUse",
            timestamp: 1,
          },
          nestedResult,
        ],
      },
    };

    const expanded = registry
      .render(
        {
          toolName: "search",
          args: { query: "malformed trace" },
          result: malformed,
          expanded: true,
        },
        { width: 100, depth: "none" },
      )
      .map(stripAnsi)
      .join("\n");
    expect(expanded).toContain("searched codebase");
    expect(expanded).not.toContain("activity · 1 action");
    expect(expanded).not.toContain("delegated");
  });
});
