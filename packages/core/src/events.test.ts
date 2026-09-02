import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "./events.ts";
import { runLoop } from "./loop.ts";
import { userMessage } from "./messages.ts";
import { FakeProvider, fakeModel } from "./testing/fake-provider.ts";
import { type AnyTool, textResult } from "./tools.ts";

// One sample per member of the union — kept exhaustive by the switch below.
const samples: AgentEvent[] = [
  { type: "agent_start" },
  { type: "agent_end", messages: [userMessage("hi")], reason: "done" },
  { type: "turn_start" },
  {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      model: "fake/fake-1",
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end",
      timestamp: 1,
    },
    toolResults: [],
  },
  { type: "message_start", message: userMessage("hi") },
  {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "h" }],
      model: "fake/fake-1",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end",
      timestamp: 1,
    },
    delta: { kind: "text_delta", contentIndex: 0, text: "h" },
  },
  { type: "message_end", message: userMessage("hi") },
  { type: "tool_execution_start", toolCallId: "c1", toolName: "echo", args: { a: 1 } },
  {
    type: "tool_execution_update",
    toolCallId: "c1",
    partial: [{ type: "text", text: "part" }],
    details: { phase: "halfway" },
  },
  {
    type: "tool_execution_end",
    toolCallId: "c1",
    result: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "echo",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 1,
    },
  },
  {
    type: "web_search_start",
    search: {
      type: "webSearch",
      id: "s1",
      status: "searching",
      action: { type: "search", query: "mu" },
    },
  },
  {
    type: "web_search_end",
    search: {
      type: "webSearch",
      id: "s1",
      status: "completed",
      action: { type: "search", query: "mu" },
    },
  },
  {
    type: "permission_asked",
    request: {
      id: "p1",
      toolCallId: "c1",
      toolName: "echo",
      permission: "echo",
      pattern: "echo *",
      description: "Run echo",
    },
  },
  { type: "permission_resolved", requestId: "p1", outcome: "allow", remembered: true },
  { type: "compaction_start", layer: 2, trigger: "manual", contextTokensBefore: 10_000 },
  { type: "compaction_update", layer: 2, stage: "summarizing" },
  {
    type: "compaction_end",
    layer: 2,
    trigger: "manual",
    status: "completed",
    tokensFreed: 7_000,
    summaryEntryId: "e1",
    contextTokensBefore: 10_000,
    contextTokensAfter: 3_000,
    keptTokens: 2_000,
    toolResultsCleared: 2,
  },
  { type: "task_started", taskId: "t1", command: "sleep 1", background: true },
  { type: "task_output", taskId: "t1", chunk: "out" },
  { type: "task_exited", taskId: "t1", exitCode: 0 },
  {
    type: "usage_updated",
    sessionTotals: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    contextTokens: 10,
    contextPercent: 0.1,
  },
];

describe("AgentEvent", () => {
  test("every event kind round-trips through JSON unchanged", () => {
    for (const event of samples) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
  });

  test("samples cover every member of the union", () => {
    const covered = new Set(samples.map((e) => e.type));
    const all: AgentEvent["type"][] = [
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "web_search_start",
      "web_search_end",
      "permission_asked",
      "permission_resolved",
      "compaction_start",
      "compaction_update",
      "compaction_end",
      "task_started",
      "task_output",
      "task_exited",
      "usage_updated",
    ];
    for (const type of all) expect(covered.has(type)).toBe(true);
  });

  test("events emitted by a real run all serialize losslessly", async () => {
    const provider = new FakeProvider([
      {
        content: [
          { type: "thinking", thinking: "hmm", signature: "SIG" },
          { type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const tool: AnyTool = {
      name: "echo",
      description: "echo",
      inputSchema: { type: "object" },
      execute: async (_id, _args, _signal, onUpdate) => {
        onUpdate?.([{ type: "text", text: "partial" }]);
        return textResult("final");
      },
    };
    const events: AgentEvent[] = [];
    await runLoop(
      [userMessage("go")],
      { messages: [], tools: [tool] },
      { provider, model: fakeModel },
      (event) => void events.push(event),
    );

    expect(events.length).toBeGreaterThan(10);
    for (const event of events) {
      const round = JSON.parse(JSON.stringify(event));
      expect(round).toEqual(event);
    }
    // Thinking signatures survive the event stream.
    const end = events.find((e) => e.type === "message_end" && e.message.role === "assistant");
    if (end?.type === "message_end" && end.message.role === "assistant") {
      const thinking = end.message.content.find((c) => c.type === "thinking");
      expect(thinking?.type === "thinking" && thinking.signature).toBe("SIG");
    }
    expect(events.some((e) => e.type === "tool_execution_update")).toBe(true);
  });
});
