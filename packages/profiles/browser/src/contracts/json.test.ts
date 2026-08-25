import { describe, expect, test } from "bun:test";
import {
  assertJsonSerializable,
  BROWSER_LIMITS,
  findSerializationViolations,
  isJsonValue,
  jsonValueSchema,
} from "./json.ts";
import { BrowserSecret } from "./secret.ts";

function reasons(value: unknown): string[] {
  return findSerializationViolations(value).map((violation) => violation.reason);
}

describe("json value contract", () => {
  test("accepts the shapes a receipt or event may carry", () => {
    const value = { a: 1, b: "two", c: [true, null, { d: [] }] };
    expect(isJsonValue(value)).toBe(true);
    expect(jsonValueSchema.safeParse(value).success).toBe(true);
  });

  test("rejects a cyclic value instead of overflowing on it", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(reasons(cyclic)).toEqual(["cycle"]);
    expect(() => assertJsonSerializable(cyclic)).toThrow(/cycle/);
  });

  test("rejects a cycle reached through an array", () => {
    const list: unknown[] = [];
    list.push({ list });
    expect(reasons(list)).toEqual(["cycle"]);
  });

  test("rejects functions, symbols, bigints and undefined", () => {
    expect(reasons({ fn: () => 1 })).toEqual(["function"]);
    expect(reasons({ sym: Symbol("x") })).toEqual(["symbol"]);
    expect(reasons({ big: 1n })).toEqual(["bigint"]);
    expect(reasons({ nothing: undefined })).toEqual(["undefined"]);
  });

  test("rejects non-finite numbers that JSON would silently turn into null", () => {
    expect(reasons({ n: Number.NaN })).toEqual(["non-finite-number"]);
    expect(reasons({ n: Number.POSITIVE_INFINITY })).toEqual(["non-finite-number"]);
    expect(jsonValueSchema.safeParse({ n: Number.NaN }).success).toBe(false);
  });

  test("rejects class instances that stand in for a live handle", () => {
    class PageHandle {
      close(): void {}
    }
    expect(reasons({ page: new PageHandle() })).toEqual(["class-instance"]);
    expect(reasons({ when: new Date() })).toEqual(["class-instance"]);
    expect(reasons({ seen: new Map() })).toEqual(["class-instance"]);
    expect(reasons({ error: new Error("boom") })).toEqual(["class-instance"]);
  });

  test("a secret cannot enter a serializable shape", () => {
    const carrier = { sessionSecret: new BrowserSecret("secret_live_1") };
    expect(reasons(carrier)).toEqual(["class-instance"]);
    expect(() => assertJsonSerializable(carrier, "session entry")).toThrow(/session entry/);
  });

  test("rejects a value nested past the depth bound rather than recursing forever", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i <= BROWSER_LIMITS.maxSerializableDepth + 2; i++) {
      const next: Record<string, unknown> = {};
      deep.next = next;
      deep = next;
    }
    expect(reasons(root)).toContain("too-deep");
  });

  test("reports the path of the offending value", () => {
    const violations = findSerializationViolations({ outer: [{ inner: () => 1 }] });
    expect(violations[0]?.path).toBe("outer.0.inner");
  });
});
