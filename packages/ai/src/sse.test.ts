import { describe, expect, test } from "bun:test";
import { iterateSse, type SseEvent } from "./sse.ts";

function bodyFrom(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

async function collect(text: string, chunkSize?: number): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const e of iterateSse(bodyFrom(text, chunkSize))) events.push(e);
  return events;
}

describe("iterateSse", () => {
  test("parses events split across arbitrary chunks", async () => {
    const events = await collect('event: ping\ndata: {"a":1}\n\ndata: bare\n\n', 3);
    expect(events).toEqual([
      { event: "ping", data: '{"a":1}' },
      { event: null, data: "bare" },
    ]);
  });

  test("handles CRLF line endings", async () => {
    const events = await collect("event: x\r\ndata: 1\r\n\r\n");
    expect(events).toEqual([{ event: "x", data: "1" }]);
  });

  test("joins multi-line data", async () => {
    const events = await collect("data: a\ndata: b\n\n");
    expect(events).toEqual([{ event: null, data: "a\nb" }]);
  });

  test("ignores comment lines", async () => {
    const events = await collect(": keepalive\ndata: 1\n\n");
    expect(events).toEqual([{ event: null, data: "1" }]);
  });

  test("flushes trailing event without final blank line", async () => {
    const events = await collect("data: tail\n");
    expect(events).toEqual([{ event: null, data: "tail" }]);
  });
});
