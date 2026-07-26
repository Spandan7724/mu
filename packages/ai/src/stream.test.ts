import { describe, expect, test } from "bun:test";
import { AssistantStream, EventStream } from "./stream.ts";
import type { AssistantMessage } from "./types.ts";

function message(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "test/model",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end",
    timestamp: 0,
  };
}

describe("EventStream", () => {
  test("delivers queued events then completes", async () => {
    const stream = new EventStream<number, number>(
      (e) => e === 99,
      (e) => e,
    );
    stream.push(1);
    stream.push(2);
    stream.push(99);
    stream.end();
    const seen: number[] = [];
    for await (const e of stream) seen.push(e);
    expect(seen).toEqual([1, 2, 99]);
    expect(await stream.result()).toBe(99);
  });

  test("supports consumer waiting before events arrive", async () => {
    const stream = new EventStream<string, string>(
      (e) => e === "done",
      (e) => e,
    );
    const consumed = (async () => {
      const seen: string[] = [];
      for await (const e of stream) seen.push(e);
      return seen;
    })();
    await Bun.sleep(1);
    stream.push("a");
    stream.push("done");
    stream.end();
    expect(await consumed).toEqual(["a", "done"]);
  });
});

describe("AssistantStream", () => {
  test("result resolves on done event", async () => {
    const stream = new AssistantStream();
    const msg = message("hi");
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "done", message: msg });
    stream.end();
    expect(await stream.result()).toBe(msg);
  });

  test("result resolves on error event", async () => {
    const stream = new AssistantStream();
    const msg = message("");
    msg.stopReason = "error";
    stream.push({ type: "error", reason: "error", error: msg });
    stream.end();
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
  });
});
