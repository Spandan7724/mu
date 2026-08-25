import { describe, expect, test } from "bun:test";
import { evaluate } from "@mu/core";
import { elementRefOf } from "../contracts/observation.ts";
import { elementRefId } from "../contracts/primitives.ts";
import { BROWSER_SCOPES, isBrowserScope } from "../policy/scopes.ts";
import { sampleElement, sampleObservation } from "../testing/samples.ts";
import { createHarness } from "../tools/harness.ts";
import { browserSubmitTool } from "../tools/submit.ts";
import { browserTabsTool } from "../tools/tabs.ts";
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

  test("full access allows every permission scope without asking", () => {
    const mode = BROWSER_PERMISSION_MODES.find((candidate) => candidate.id === "yolo");
    const rules = [...BROWSER_PERMISSION_DEFAULTS, ...(mode?.rules ?? [])];
    for (const permission of [...BROWSER_SCOPES, "future:browser-scope"]) {
      expect({ permission, action: evaluate(rules, permission, "*") }).toEqual({
        permission,
        action: "allow",
      });
    }
  });
});

describe("Mu is the only permission authority", () => {
  const autonomousRules = () => {
    const mode = BROWSER_PERMISSION_MODES.find((candidate) => candidate.id === "autonomous-submit");
    return [...BROWSER_PERMISSION_DEFAULTS, ...(mode?.rules ?? [])];
  };

  test("opening a tab on an unapproved origin asks through Mu", async () => {
    const harness = createHarness({ allowedOrigins: ["https://approved.example"] });
    try {
      const tabs = browserTabsTool({ session: harness.session });
      const args = { action: "open" as const, url: "https://unapproved.example/path" };
      const scope = tabs.permissionScope?.(args) ?? tabs.name;
      const pattern = tabs.permissionPattern?.(args) ?? JSON.stringify(args);
      expect({ scope, verdict: evaluate(autonomousRules(), scope, pattern) }).toEqual({
        scope: "browser:new-origin",
        verdict: "ask",
      });
    } finally {
      await harness.shutdown();
    }
  });

  test("autonomous submission does not cover an unapproved current origin", async () => {
    const harness = createHarness({ allowedOrigins: ["https://approved.example"] });
    try {
      const target = sampleElement({
        ref: elementRefId("submit"),
        role: "button",
        label: "Submit application",
        name: "Submit application",
        inputType: "submit",
      });
      const record = harness.session.adopt(
        sampleObservation({
          url: "https://unapproved.example/apply",
          origin: "https://unapproved.example",
          tab: {
            id: "tab-unapproved",
            title: "Apply",
            url: "https://unapproved.example/apply",
            active: true,
            attached: true,
          },
          elements: [target],
          risks: ["submit"],
        }),
      );
      const submit = browserSubmitTool({ session: harness.session });
      const args = {
        target: elementRefOf(
          record.observation.elements[0] as NonNullable<(typeof record.observation.elements)[0]>,
        ),
        intent: "submit-form" as const,
      };
      const scope = submit.permissionScope?.(args) ?? submit.name;
      const pattern = submit.permissionPattern?.(args) ?? JSON.stringify(args);
      expect({ scope, verdict: evaluate(autonomousRules(), scope, pattern) }).toEqual({
        scope: "browser:new-origin",
        verdict: "ask",
      });
    } finally {
      await harness.shutdown();
    }
  });

  test("answering a page-authored dialog uses consent, not the submit grant", async () => {
    const sampleOrigin = sampleObservation().origin as string;
    const harness = createHarness({ allowedOrigins: [sampleOrigin] });
    try {
      const target = sampleElement({
        ref: elementRefId("submit"),
        role: "button",
        label: "Submit application",
        name: "Submit application",
        inputType: "submit",
      });
      const record = harness.session.adopt(
        sampleObservation({ elements: [target], risks: ["submit"] }),
      );
      const submit = browserSubmitTool({ session: harness.session });
      const scope = submit.permissionScope?.({
        target: elementRefOf(
          record.observation.elements[0] as NonNullable<(typeof record.observation.elements)[0]>,
        ),
        intent: "submit-form",
        acceptDialog: { message: "Send now?" },
      });
      expect({ scope, verdict: evaluate(autonomousRules(), scope ?? "", "*") }).toEqual({
        scope: "browser:consent",
        verdict: "ask",
      });
    } finally {
      await harness.shutdown();
    }
  });
});
