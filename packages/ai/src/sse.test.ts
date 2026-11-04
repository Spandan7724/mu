import { describe, expect, test } from "bun:test";
import { AiError } from "./errors.ts";
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

  test("CRLF split across chunks at every boundary yields the same events", async () => {
    const text =
      'event: a\r\ndata: {"x":1}\r\n\r\nevent: error\r\ndata: 2\r\ndata: 3\r\n\r\n' +
      ": ka\r\n\r\ndata: lf\n\ndata: cr\r\rdata: tail\r\n";
    const expected: SseEvent[] = [
      { event: "a", data: '{"x":1}' },
      { event: "error", data: "2\n3" },
      { event: null, data: "lf" },
      { event: null, data: "cr" },
      { event: null, data: "tail" },
    ];
    for (let size = 1; size <= text.length; size++) {
      expect(await collect(text, size)).toEqual(expected);
    }
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

describe("iterateSse idle timeout", () => {
  function stallAfter(text: string): {
    body: ReadableStream<Uint8Array>;
    cancelled: () => boolean;
  } {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { body, cancelled: () => cancelled };
  }

  test("a stream that goes silent fails as a retryable network error", async () => {
    const { body, cancelled } = stallAfter("data: 1\n\n");
    const seen: SseEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of iterateSse(body, undefined, 20)) seen.push(event);
    } catch (error) {
      failure = error;
    }
    expect(seen).toEqual([{ event: null, data: "1" }]);
    expect(failure).toBeInstanceOf(AiError);
    expect((failure as AiError).kind).toBe("network");
    expect((failure as AiError).message).toContain("stream stalled");
    expect(cancelled()).toBe(true);
  });

  test("0 disables the limit", async () => {
    const { body } = stallAfter("data: 1\n\n");
    const iterator = iterateSse(body, undefined, 0);
    expect((await iterator.next()).value).toEqual({ event: null, data: "1" });
    const next = await Promise.race([iterator.next(), Bun.sleep(40).then(() => "waiting")]);
    expect(next).toBe("waiting");
  });
});
