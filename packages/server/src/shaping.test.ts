import { describe, expect, test } from "bun:test";
import type { AgentEvent, AssistantMessage, StreamDelta, ToolResultMessage } from "@mu/core";
import { FULL_FIDELITY, resolvePolicy } from "@mu/protocol";
import { BlobStore } from "./blobs.ts";
import { applyBudget, collapseUpdates, isExempt, Shaper } from "./shaping.ts";

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "fake/fake-1",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end",
    timestamp: 1,
  };
}

function toolResult(text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

// A recorded delta stream: a start marker, a long run of text deltas, an end
// marker, then a completed message — the shape a real reply has.
function recordedStream(chunks: string[]): AgentEvent[] {
  const events: AgentEvent[] = [{ type: "agent_start" }, { type: "turn_start" }];
  let accumulated = "";
  events.push({
    type: "message_update",
    message: assistant(""),
    delta: { kind: "text_start", contentIndex: 0 },
  });
  for (const chunk of chunks) {
    accumulated += chunk;
    events.push({
      type: "message_update",
      message: assistant(accumulated),
      delta: { kind: "text_delta", contentIndex: 0, text: chunk },
    });
  }
  events.push({
    type: "message_update",
    message: assistant(accumulated),
    delta: { kind: "text_end", contentIndex: 0 },
  });
  events.push({ type: "message_end", message: assistant(accumulated) });
  events.push({ type: "turn_end", message: assistant(accumulated), toolResults: [] });
  events.push({ type: "agent_end", messages: [assistant(accumulated)], reason: "done" });
  return events;
}

// Replays a stream through a policy with a controllable clock, so a coalescing
// window is a deterministic thing rather than a sleep.
function replay(events: AgentEvent[], policy: Parameters<typeof resolvePolicy>[0]) {
  const out: AgentEvent[] = [];
  let pending: (() => void) | undefined;
  const shaper = new Shaper({
    policy: resolvePolicy(policy),
    blobs: new BlobStore(),
    emit: (event) => out.push(event),
    setTimer: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimer: () => {
      pending = undefined;
    },
  });
  return {
    out,
    push: (event: AgentEvent) => shaper.push(event),
    tick: () => {
      const fire = pending;
      pending = undefined;
      fire?.();
    },
    all: () => {
      for (const event of events) shaper.push(event);
      shaper.flush();
      return out;
    },
  };
}

function finalText(events: AgentEvent[]): string {
  const last = [...events].reverse().find((event) => event.type === "message_end");
  if (last?.type !== "message_end" || last.message.role !== "assistant") return "";
  return last.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

const CHUNKS = Array.from({ length: 200 }, (_, index) => `token${index} `);

describe("coalescing", () => {
  test("full and coalesced replays produce byte-identical final messages", () => {
    const events = recordedStream(CHUNKS);
    const full = replay(events, FULL_FIDELITY).all();
    const coalesced = replay(events, { updates: "coalesced", updateHz: 8 }).all();

    expect(finalText(coalesced)).toBe(finalText(full));
    expect(JSON.stringify(finalText(coalesced))).toBe(JSON.stringify(CHUNKS.join("")));
  });

  test("it delays updates but never reorders or drops another event", () => {
    const events = recordedStream(CHUNKS);
    const coalesced = replay(events, { updates: "coalesced" }).all();

    const order = coalesced.map((event) => event.type);
    const nonUpdates = order.filter((type) => type !== "message_update");
    expect(nonUpdates).toEqual([
      "agent_start",
      "turn_start",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    // Every update precedes the message_end it belongs to.
    expect(order.lastIndexOf("message_update")).toBeLessThan(order.indexOf("message_end"));
    expect(coalesced.length).toBeLessThan(events.length);
  });

  test("a full policy is byte-identical to what the Agent emitted", () => {
    const events = recordedStream(CHUNKS);
    expect(replay(events, FULL_FIDELITY).all()).toEqual(events);
  });

  test("a run of text deltas collapses to one carrying the concatenation", () => {
    const buffer = CHUNKS.map((chunk, index) => ({
      type: "message_update" as const,
      message: assistant(CHUNKS.slice(0, index + 1).join("")),
      delta: { kind: "text_delta", contentIndex: 0, text: chunk } as StreamDelta,
    }));
    const collapsed = collapseUpdates(buffer);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.delta).toEqual({
      kind: "text_delta",
      contentIndex: 0,
      text: CHUNKS.join(""),
    });
  });

  test("markers and separate content indexes stay apart", () => {
    const collapsed = collapseUpdates([
      {
        type: "message_update",
        message: assistant(""),
        delta: { kind: "text_start", contentIndex: 0 },
      },
      {
        type: "message_update",
        message: assistant("a"),
        delta: { kind: "text_delta", contentIndex: 0, text: "a" },
      },
      {
        type: "message_update",
        message: assistant("ab"),
        delta: { kind: "text_delta", contentIndex: 0, text: "b" },
      },
      {
        type: "message_update",
        message: assistant("ab"),
        delta: { kind: "text_end", contentIndex: 0 },
      },
      {
        type: "message_update",
        message: assistant("ab"),
        delta: { kind: "toolcall_delta", contentIndex: 1, argsFragment: '{"a' },
      },
      {
        type: "message_update",
        message: assistant("ab"),
        delta: { kind: "toolcall_delta", contentIndex: 1, argsFragment: '":1}' },
      },
    ]);

    expect(collapsed.map((update) => update.delta)).toEqual([
      { kind: "text_start", contentIndex: 0 },
      { kind: "text_delta", contentIndex: 0, text: "ab" },
      { kind: "text_end", contentIndex: 0 },
      { kind: "toolcall_delta", contentIndex: 1, argsFragment: '{"a":1}' },
    ]);
  });

  test("a turn boundary flushes what is buffered before it is sent", () => {
    const session = replay([], { updates: "coalesced" });
    session.push({
      type: "message_update",
      message: assistant("partial"),
      delta: { kind: "text_delta", contentIndex: 0, text: "partial" },
    });
    expect(session.out).toEqual([]);

    session.push({ type: "message_end", message: assistant("partial") });

    expect(session.out.map((event) => event.type)).toEqual(["message_update", "message_end"]);
  });

  test("permission_asked is never coalesced, delayed or truncated under any policy", () => {
    const request = {
      id: "p1",
      toolCallId: "c1",
      toolName: "bash",
      permission: "bash",
      pattern: "rm -rf /",
      description: "Run rm -rf /",
      preview: { kind: "text" as const, lines: ["x".repeat(200_000)] },
    };
    const asked: AgentEvent = { type: "permission_asked", request };

    for (const policy of [
      FULL_FIDELITY,
      { updates: "coalesced" as const, updateHz: 1 },
      { updates: "none" as const },
      { updates: "coalesced" as const, maxInlineBytes: 8 },
    ]) {
      const session = replay([], policy);
      session.push({
        type: "message_update",
        message: assistant("x"),
        delta: { kind: "text_delta", contentIndex: 0, text: "x" },
      });
      session.push(asked);

      // Present, intact, and never behind a buffered update.
      const emitted = session.out.filter((event) => event.type === "permission_asked");
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual(asked);
      expect(emitted[0]).toBe(asked);
      expect(session.out[session.out.length - 1]).toBe(asked);
    }

    expect(isExempt(asked)).toBe(true);
  });

  test("a none policy still delivers the one event that must always arrive", () => {
    const session = replay([], { updates: "none" });
    session.push({ type: "turn_start" });
    session.push({
      type: "permission_asked",
      request: {
        id: "p1",
        toolCallId: "c1",
        toolName: "bash",
        permission: "bash",
        pattern: "ls",
        description: "Run ls",
      },
    });
    expect(session.out.map((event) => event.type)).toEqual(["permission_asked"]);
  });

  test("task output is opt-in", () => {
    const output: AgentEvent = { type: "task_output", taskId: "task_1", chunk: "line\n" };
    expect(replay([output], { updates: "full" }).all()).toEqual([]);
    expect(replay([output], { updates: "full", taskOutput: true }).all()).toEqual([output]);
  });
});

describe("payload budgets", () => {
  test("an over-budget tool result becomes a stub carrying a blobRef", () => {
    const blobs = new BlobStore();
    const big = "y".repeat(64 * 1024);
    const shaped = applyBudget(
      { type: "tool_execution_end", toolCallId: "c1", result: toolResult(big) },
      resolvePolicy({ updates: "full", maxInlineBytes: 1024 }),
      blobs,
    );

    expect(shaped.type).toBe("tool_execution_end");
    const block =
      shaped.type === "tool_execution_end"
        ? (shaped.result.content[0] as {
            text: string;
            truncated?: boolean;
            blobRef?: string;
            bytes?: number;
          })
        : undefined;
    expect(block?.truncated).toBe(true);
    expect(block?.text.length).toBe(1024);
    expect(block?.bytes).toBeGreaterThan(64 * 1024);
    expect(blobs.get(block?.blobRef as string)).toEqual(toolResult(big).content);
  });

  test("a result inside the budget is passed through untouched", () => {
    const event: AgentEvent = {
      type: "tool_execution_end",
      toolCallId: "c1",
      result: toolResult("small"),
    };
    expect(applyBudget(event, resolvePolicy(FULL_FIDELITY), new BlobStore())).toBe(event);
  });

  test("images are stubbed for a remote subscriber and inline for a local one", () => {
    const image: AgentEvent = {
      type: "tool_execution_end",
      toolCallId: "c1",
      result: {
        ...toolResult("caption"),
        content: [
          { type: "text", text: "caption" },
          { type: "image", mimeType: "image/png", data: "AAAA" },
        ],
      },
    };
    const stubbed = applyBudget(image, resolvePolicy({ updates: "coalesced" }), new BlobStore());
    const content = stubbed.type === "tool_execution_end" ? stubbed.result.content : [];
    expect(content.map((block) => block.type)).toEqual(["text", "text"]);
    expect((content[1] as { blobRef?: string }).blobRef).toMatch(/^b_/);

    expect(applyBudget(image, resolvePolicy(FULL_FIDELITY), new BlobStore())).toBe(image);
  });
});
