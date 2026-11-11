import { describe, expect, test } from "bun:test";
import {
  parseJsonWithRepair,
  parsePartialJson,
  repairJson,
  StreamingToolArgs,
  salvageToolArgs,
} from "./json.ts";

describe("repairJson", () => {
  test("escapes raw control characters in strings", () => {
    expect(repairJson('{"a": "x\ny"}')).toBe('{"a": "x\\ny"}');
  });

  test("doubles invalid escapes", () => {
    expect(repairJson('{"a": "C:\\x"}')).toBe('{"a": "C:\\\\x"}');
  });

  test("keeps valid escapes and unicode", () => {
    const s = '{"a": "line\\n \\u00e9"}';
    expect(repairJson(s)).toBe(s);
  });
});

describe("parseJsonWithRepair", () => {
  test("parses valid json directly", () => {
    expect(parseJsonWithRepair<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  test("repairs newline inside string", () => {
    expect(parseJsonWithRepair<{ a: string }>('{"a":"x\ny"}')).toEqual({ a: "x\ny" });
  });
});

describe("parsePartialJson", () => {
  test("complete object", () => {
    expect(parsePartialJson('{"a": 1, "b": [true, null]}')).toEqual({ a: 1, b: [true, null] });
  });

  test("truncated mid-string", () => {
    expect(parsePartialJson('{"path": "/tmp/fi')).toEqual({ path: "/tmp/fi" });
  });

  test("truncated after colon", () => {
    expect(parsePartialJson('{"a": ')).toEqual({});
  });

  test("truncated mid-key", () => {
    expect(parsePartialJson('{"lon')).toEqual({});
  });

  test("truncated array", () => {
    expect(parsePartialJson('{"xs": [1, 2, ')).toEqual({ xs: [1, 2] });
  });

  test("truncated literal", () => {
    expect(parsePartialJson('{"ok": tru')).toEqual({ ok: true });
  });

  test("truncated number", () => {
    expect(parsePartialJson('{"n": 12')).toEqual({ n: 12 });
  });

  test("nested truncation", () => {
    expect(parsePartialJson('{"a": {"b": {"c": "deep')).toEqual({ a: { b: { c: "deep" } } });
  });

  test("escapes inside truncated string", () => {
    expect(parsePartialJson('{"s": "a\\nb')).toEqual({ s: "a\nb" });
  });
});

describe("salvageToolArgs", () => {
  test("empty input yields empty object", () => {
    expect(salvageToolArgs("")).toEqual({});
    expect(salvageToolArgs(undefined)).toEqual({});
  });

  test("valid json", () => {
    expect(salvageToolArgs('{"city":"Paris"}')).toEqual({ city: "Paris" });
  });

  test("truncated json is salvaged", () => {
    expect(salvageToolArgs('{"command": "echo hi", "timeout": 50')).toEqual({
      command: "echo hi",
      timeout: 50,
    });
  });

  test("non-object json yields empty object", () => {
    expect(salvageToolArgs("[1,2]")).toEqual({});
  });

  test("raw newline in string plus truncation", () => {
    expect(salvageToolArgs('{"text": "line1\nline2')).toEqual({ text: "line1\nline2" });
  });
});

describe("StreamingToolArgs", () => {
  test("small arguments are parsed on every fragment", () => {
    const args = new StreamingToolArgs(() => 0);
    expect(args.append('{"path":"a.ts","con')).toEqual({ path: "a.ts" });
    expect(args.append('tent":"x')).toEqual({ path: "a.ts", content: "x" });
    expect(args.finish()).toEqual({ path: "a.ts", content: "x" });
  });

  test("large arguments are parsed on a clock and exactly at the end", () => {
    let clock = 0;
    const args = new StreamingToolArgs(() => clock);
    const full = JSON.stringify({ content: 'line "one"\n'.repeat(4000) });
    let parses = 0;
    let last: unknown;
    for (let i = 0; i < full.length - 2; i += 20) {
      clock += 1;
      const value = args.append(full.slice(i, Math.min(i + 20, full.length - 2)));
      if (value !== last) parses++;
      last = value;
    }
    const fragments = Math.ceil((full.length - 2) / 20);
    expect(parses).toBeLessThan(fragments / 10);
    expect(parses).toBeGreaterThan(fragments / 60);
    expect(args.finish(full)).toEqual(JSON.parse(full));
    expect(args.json).toBe(full);
  });

  test("the partial parser keeps escapes inside long strings", () => {
    const text = 'a\\b "quoted" \u00e9\n'.repeat(500);
    const json = JSON.stringify({ text });
    expect(parsePartialJson(json.slice(0, -2))).toEqual({ text });
  });
});
