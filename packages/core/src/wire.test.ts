import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "./events.ts";
import { runLoop } from "./loop.ts";
import { userMessage } from "./messages.ts";
import { FakeProvider, fakeModel } from "./testing/fake-provider.ts";
import { textResult } from "./tools.ts";
import { toWireEvent, WireEventDecoder } from "./wire.ts";

async function recorded(): Promise<AgentEvent[]> {
  const provider = new FakeProvider([
    {
      content: [
        { type: "thinking", thinking: "plan the edit" },
        { type: "text", text: "Writing the file." },
        { type: "toolCall", id: "c1", name: "write", arguments: { path: "a.ts", content: "x" } },
      ],
    },
    { content: [{ type: "text", text: "done" }] },
  ]);
  const events: AgentEvent[] = [];
  await runLoop(
    [userMessage("go")],
    {
      messages: [],
      tools: [
        {
          name: "write",
          description: "write",
          inputSchema: { type: "object" },
          execute: async () => textResult("ok"),
        },
      ],
    },
    { provider, model: fakeModel },
    // The partial is live state: keep what each event showed when it was emitted.
    (event) => void events.push(structuredClone(event)),
  );
  return events;
}

describe("wire events", () => {
  test("message_update crosses the wire as its delta alone", async () => {
    const events = await recorded();
    const updates = events.filter((event) => event.type === "message_update");
    expect(updates.length).toBeGreaterThan(5);
    for (const event of updates) {
      expect(Object.keys(toWireEvent(event)).sort()).toEqual(["delta", "type"]);
    }
    const other = events.find((event) => event.type === "turn_end");
    expect(other && toWireEvent(other)).toBe(other as AgentEvent);
  });

  test("a decoder rebuilds every partial message from the deltas", async () => {
    const events = await recorded();
    const decoder = new WireEventDecoder();
    for (const event of events) {
      const decoded = decoder.decode(JSON.parse(JSON.stringify(toWireEvent(event))));
      if (event.type !== "message_update" || decoded.type !== "message_update") {
        expect(decoded).toEqual(event);
        continue;
      }
      expect(decoded.delta).toEqual(event.delta);
      // The scripted provider opens a block already filled, which no delta describes.
      if (event.delta.kind.endsWith("_start")) continue;
      expect(decoded.message.content).toEqual(event.message.content);
    }
  });

  test("a stream joined part-way still ends each tool call complete", () => {
    const decoder = new WireEventDecoder();
    decoder.decode({
      type: "message_update",
      delta: { kind: "toolcall_delta", contentIndex: 1, argsFragment: 'h":"a.ts"}' },
    });
    const decoded = decoder.decode({
      type: "message_update",
      delta: {
        kind: "toolcall_end",
        contentIndex: 1,
        toolCallId: "c1",
        toolName: "read",
        args: { path: "a.ts" },
      },
    });
    expect(decoded.type === "message_update" && decoded.message.content[1]).toEqual({
      type: "toolCall",
      id: "c1",
      name: "read",
      arguments: { path: "a.ts" },
    });
  });

  test("an event that still carries its message passes through", () => {
    const decoder = new WireEventDecoder();
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "hi" }],
      model: "fake/fake-1",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end" as const,
      timestamp: 1,
    };
    const event = {
      type: "message_update" as const,
      message,
      delta: { kind: "text_delta" as const, contentIndex: 0, text: "hi" },
    };
    const decoded = decoder.decode(event);
    expect(decoded.type === "message_update" && decoded.message).toBe(message);
  });
});
