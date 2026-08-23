import { describe, expect, test } from "bun:test";
import { evaluate } from "@mu/core";
import { isBrowserScope } from "../policy/scopes.ts";
import { BROWSER_PERMISSION_DEFAULTS, BROWSER_PERMISSION_MODES } from "./permissions.ts";

describe("a mode's rules name scopes that tools actually produce", () => {
  // The bug this pins: every mode granted `browser:act`, which no tool ever emits, so
  // the rule matched nothing and every click fell through to the catch-all ask. The
  // modes looked right, read right, and did nothing.
  test("every scope named by a mode or a default is a real browser scope", () => {
    const named = [
      ...BROWSER_PERMISSION_DEFAULTS,
      ...BROWSER_PERMISSION_MODES.flatMap((mode) => mode.rules ?? []),
    ]
      .map((rule) => rule.permission)
      .filter((permission) => permission.startsWith("browser:"));
    expect(named.length).toBeGreaterThan(0);
    for (const permission of named) {
      expect({ permission, known: isBrowserScope(permission) }).toEqual({
        permission,
        known: true,
      });
    }
  });

  test("an ordinary click is allowed outright in the modes that say so", () => {
    for (const id of ["confirm-submission", "autonomous-submit"]) {
      const mode = BROWSER_PERMISSION_MODES.find((candidate) => candidate.id === id);
      const rules = [...BROWSER_PERMISSION_DEFAULTS, ...(mode?.rules ?? [])];
      expect({
        id,
        action: evaluate(rules, ["browser:interact"], "https://x.test Products"),
      }).toEqual({ id, action: "allow" });
    }
  });

  test("read-only denies an ordinary click rather than merely asking", () => {
    const mode = BROWSER_PERMISSION_MODES.find((candidate) => candidate.id === "read-only");
    const rules = [...BROWSER_PERMISSION_DEFAULTS, ...(mode?.rules ?? [])];
    expect(evaluate(rules, ["browser:interact"], "https://x.test Products")).toBe("deny");
  });
});
