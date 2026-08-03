import { describe, expect, test } from "bun:test";
import { InputDecoder, type InputEvent, PasteBurstDetector } from "./input.ts";

const ESC = "\u001b";

function keys(events: InputEvent[]): string[] {
  return events.filter((e) => e.type === "key").map((e) => (e.type === "key" ? e.key.name : ""));
}

describe("InputDecoder", () => {
  test("decodes printable characters with their text", () => {
    const events = new InputDecoder().push("hi");
    expect(keys(events)).toEqual(["h", "i"]);
    expect(events[0]?.type === "key" && events[0].key.text).toBe("h");
  });

  test("decodes return, tab and backspace", () => {
    expect(keys(new InputDecoder().push("\r\t"))).toEqual(["return", "tab", "backspace"]);
  });

  test("decodes ctrl combinations", () => {
    const events = new InputDecoder().push("\u0003"); // Ctrl+C
    expect(events[0]?.type === "key" && events[0].key.name).toBe("c");
    expect(events[0]?.type === "key" && events[0].key.ctrl).toBe(true);
  });

  test("decodes arrow keys", () => {
    expect(keys(new InputDecoder().push(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`))).toEqual([
      "up",
      "down",
      "right",
      "left",
    ]);
  });

  test("decodes modified arrows", () => {
    const events = new InputDecoder().push(`${ESC}[1;5A`); // Ctrl+Up
    expect(events[0]?.type === "key" && events[0].key.name).toBe("up");
    expect(events[0]?.type === "key" && events[0].key.ctrl).toBe(true);

    const altEvents = new InputDecoder().push(`${ESC}[1;3A`); // Alt+Up
    expect(altEvents[0]?.type === "key" && altEvents[0].key.name).toBe("up");
    expect(altEvents[0]?.type === "key" && altEvents[0].key.alt).toBe(true);
  });

  test("decodes shift+tab", () => {
    for (const sequence of [`${ESC}[Z`, `${ESC}[9;2u`]) {
      const events = new InputDecoder().push(sequence);
      expect(events[0]?.type === "key" && events[0].key.name).toBe("tab");
      expect(events[0]?.type === "key" && events[0].key.shift).toBe(true);
    }
  });

  test("decodes home/end/delete", () => {
    expect(keys(new InputDecoder().push(`${ESC}[3~${ESC}[5~`))).toEqual(["delete", "pageup"]);
  });

  test("decodes the kitty keyboard protocol", () => {
    const events = new InputDecoder().push(`${ESC}[97;5u`); // Ctrl+a
    expect(events[0]?.type === "key" && events[0].key.name).toBe("a");
    expect(events[0]?.type === "key" && events[0].key.ctrl).toBe(true);
  });

  test("alt+character is decoded as alt", () => {
    const events = new InputDecoder().push(`${ESC}b`);
    expect(events[0]?.type === "key" && events[0].key.name).toBe("b");
    expect(events[0]?.type === "key" && events[0].key.alt).toBe(true);
  });

  test("a lone escape waits, then flushes as the escape key", () => {
    const decoder = new InputDecoder();
    expect(decoder.push(ESC)).toEqual([]);
    const flushed = decoder.flushPendingEscape();
    expect(flushed?.type === "key" && flushed.key.name).toBe("escape");
  });

  test("multi-byte characters survive intact", () => {
    const events = new InputDecoder().push("é你🎉");
    expect(keys(events)).toEqual(["é", "你", "🎉"]);
  });
});

describe("bracketed paste", () => {
  test("a multi-line paste is one paste event, never a submit", () => {
    const events = new InputDecoder().push(`${ESC}[200~line one\nline two${ESC}[201~`);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("paste");
    expect(events[0]?.type === "paste" && events[0].text).toBe("line one\nline two");
    // Crucially, the embedded newline did not become a return key.
    expect(keys(events)).toEqual([]);
  });

  test("a paste split across reads is reassembled", () => {
    const decoder = new InputDecoder();
    expect(decoder.push(`${ESC}[200~first `)).toEqual([]);
    expect(decoder.push("second")).toEqual([]);
    const events = decoder.push(`${ESC}[201~`);
    expect(events[0]?.type === "paste" && events[0].text).toBe("first second");
  });

  test("a paste marker split mid-sequence is not mis-decoded", () => {
    const decoder = new InputDecoder();
    expect(decoder.push(`${ESC}[20`)).toEqual([]);
    const events = decoder.push(`0~pasted${ESC}[201~`);
    expect(events[0]?.type === "paste" && events[0].text).toBe("pasted");
  });

  test("keys before and after a paste still decode", () => {
    const events = new InputDecoder().push(`a${ESC}[200~X${ESC}[201~b`);
    expect(events.map((e) => e.type)).toEqual(["key", "paste", "key"]);
  });
});

describe("PasteBurstDetector", () => {
  test("coalesces a burst into a single flush", async () => {
    const flushed: string[] = [];
    const detector = new PasteBurstDetector((text) => flushed.push(text), 10, 3);
    detector.push("a");
    detector.push("b");
    detector.push("c");
    expect(flushed).toEqual([]);
    await Bun.sleep(25);
    expect(flushed).toEqual(["abc"]);
  });

  test("reports when the burst threshold is crossed", () => {
    const detector = new PasteBurstDetector(() => {}, 10, 3);
    expect(detector.push("a")).toBe(false);
    expect(detector.push("bc")).toBe(true);
    detector.flush();
  });
});
