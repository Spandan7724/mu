import { describe, expect, test } from "bun:test";
import type { SubmitIntent } from "../contracts/intent.ts";
import { sampleElement } from "../testing/samples.ts";
import {
  actPattern,
  BROWSER_SCOPES,
  isBrowserScope,
  NEVER_AUTO_ALLOWED_SCOPES,
  observePattern,
  sanitizePatternPart,
  scopeForIntent,
  scopeForRiskClass,
  scopesForAction,
  submitPattern,
  UNKNOWN_ORIGIN_PATTERN,
  uploadPattern,
} from "./scopes.ts";

const ORIGIN = "https://jobs.example.com";

describe("scope vocabulary", () => {
  test("the scopes in TOOLS.md exist and nothing else does", () => {
    expect([...BROWSER_SCOPES]).toEqual([
      "browser:observe",
      "browser:takeover",
      "browser:navigate",
      "browser:new-origin",
      "browser:interact",
      "browser:disclose",
      "browser:upload",
      "browser:submit",
      "browser:send",
      "browser:purchase",
      "browser:delete",
      "browser:consent",
      "browser:account-change",
    ]);
    expect(isBrowserScope("browser:everything")).toBe(false);
  });

  test("every submit intent maps to its own scope", () => {
    const intents: SubmitIntent[] = [
      "submit-form",
      "send",
      "purchase",
      "delete",
      "consent",
      "account-change",
    ];
    expect(intents.map(scopeForIntent)).toEqual([
      "browser:submit",
      "browser:send",
      "browser:purchase",
      "browser:delete",
      "browser:consent",
      "browser:account-change",
    ]);
  });

  test("SECURITY §9's never-auto-allowed set is exactly purchase, delete and account-change", () => {
    expect([...NEVER_AUTO_ALLOWED_SCOPES]).toEqual([
      "browser:purchase",
      "browser:delete",
      "browser:account-change",
    ]);
  });

  test("risk classes project onto scopes without inventing a commitment scope", () => {
    expect(scopeForRiskClass("read")).toBe("browser:observe");
    expect(scopeForRiskClass("disclosure")).toBe("browser:disclose");
    expect(scopeForRiskClass("unknown")).toBe("browser:interact");
  });
});

describe("patterns", () => {
  test("an unknown origin has an explicit pattern rather than an empty one", () => {
    expect(observePattern(undefined)).toBe(UNKNOWN_ORIGIN_PATTERN);
  });

  test("act patterns follow `<origin> <field-label-or-role>`", () => {
    expect(actPattern(ORIGIN, sampleElement())).toBe(`${ORIGIN} Full name`);
  });

  test("submit patterns follow `<origin> <intent> <action-name>`", () => {
    const control = sampleElement({ name: "Submit application" });
    expect(submitPattern(ORIGIN, "submit-form", control)).toBe(
      `${ORIGIN} submit-form Submit application`,
    );
  });

  test("upload patterns follow `<origin> <document-basename>`", () => {
    expect(uploadPattern(ORIGIN, "resume.pdf")).toBe(`${ORIGIN} resume.pdf`);
  });

  test("attack: glob metacharacters from page text are stripped", () => {
    expect(sanitizePatternPart("Sub*mit ?[x]{y}")).toBe("Submit xy");
    expect(sanitizePatternPart("***")).toBeUndefined();
  });

  test("attack: newlines cannot smuggle a second pattern segment", () => {
    expect(sanitizePatternPart("Submit\n\nrm -rf")).toBe("Submit rm -rf");
  });

  test("a very long page-authored label is truncated", () => {
    const long = sanitizePatternPart("a".repeat(500));
    expect(long?.length).toBeLessThanOrEqual(121);
  });
});

describe("action scope projection", () => {
  test("a plain click projects to interact", () => {
    expect(scopesForAction({ kind: "click", target: sampleElement() }, sampleElement())).toEqual([
      "browser:interact",
    ]);
  });

  test("entering a value projects to disclose", () => {
    const field = sampleElement();
    expect(scopesForAction({ kind: "fill", target: field, value: "Ada" }, field)).toContain(
      "browser:disclose",
    );
  });

  test("attack: no browser_act projection ever reaches a commitment scope", () => {
    const control = sampleElement({ name: "Place order", inputType: "submit", role: "button" });
    const scopes = scopesForAction({ kind: "click", target: control }, control);
    for (const scope of scopes) {
      expect(NEVER_AUTO_ALLOWED_SCOPES).not.toContain(scope);
      expect(scope).not.toBe("browser:submit");
    }
  });
});
