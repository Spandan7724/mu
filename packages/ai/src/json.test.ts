import { describe, expect, test } from "bun:test";
import { parseJsonWithRepair, parsePartialJson, repairJson, salvageToolArgs } from "./json.ts";

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
