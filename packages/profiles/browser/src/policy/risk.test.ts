import { describe, expect, test } from "bun:test";
import type { BrowserAction } from "../contracts/actions.ts";
import type { BrowserElement } from "../contracts/observation.ts";
import { elementRefId } from "../contracts/primitives.ts";
import { REDACTED } from "../contracts/secret.ts";
import { sampleElement } from "../testing/samples.ts";
import {
  classifyElement,
  dominantIntent,
  dominantRiskClass,
  gateGenericAction,
  isCommitmentClass,
  validateSubmitIntent,
} from "./risk.ts";

function button(overrides: Partial<BrowserElement> = {}): BrowserElement {
  return sampleElement({
    ref: elementRefId("btn"),
    role: "button",
    name: "Continue",
    label: "Continue",
    inputType: undefined,
    required: false,
    ...overrides,
  });
}

function click(target: BrowserElement): BrowserAction {
  return { kind: "click", target };
}

describe("risk classification", () => {
  test("a form submitter is commitment class from its markup alone", () => {
    const classification = classifyElement(button({ inputType: "submit", name: "Continue" }));
    expect(classification.riskClass).toBe("commitment");
    expect(classification.intent).toBe("submit-form");
  });

  test("purchase, delete, consent, send and account-change labels each classify", () => {
    const cases: [string, string][] = [
      ["Place order", "purchase"],
      ["Delete account", "delete"],
      ["I agree", "consent"],
      ["Send message", "send"],
      ["Change password", "account-change"],
    ];
    for (const [name, intent] of cases) {
      expect(classifyElement(button({ name, label: name })).intent).toBe(
        intent as ReturnType<typeof dominantIntent>,
      );
    }
  });

  test("bare cancel stays reversible so the safe dialog choice is still reachable", () => {
    expect(classifyElement(button({ name: "Cancel", label: "Cancel" })).riskClass).not.toBe(
      "destructive",
    );
    expect(classifyElement(button({ name: "Cancel subscription" })).intent).toBe("delete");
  });

  test("an unlabelled interactive control is unknown, never read", () => {
    const classification = classifyElement(
      button({ name: undefined, label: undefined, value: undefined, description: undefined }),
    );
    expect(classification.riskClass).toBe("unknown");
  });

  test("driver-declared risk is a floor the classifier can only raise", () => {
    const classification = classifyElement(
      button({ name: "Continue", risk: ["purchase"], inputType: undefined }),
    );
    expect(classification.risks).toContain("purchase");
    expect(classification.riskClass).toBe("commitment");
  });

  test("dominance keeps the most consequential class and intent", () => {
    expect(dominantRiskClass(["read", "unknown", "disclosure"])).toBe("disclosure");
    expect(dominantIntent(["submit-form", "purchase", "send"])).toBe("purchase");
    expect(isCommitmentClass("destructive")).toBe(true);
  });
});

describe("BD12 — generic actions cannot reach commitment controls", () => {
  test("attack: a click aimed at a submit button is refused and redirected", () => {
    const target = button({ inputType: "submit", name: "Submit application" });
    const gate = gateGenericAction({ action: click(target), element: target });
    expect(gate.kind).toBe("use-submit");
    if (gate.kind !== "use-submit") throw new Error("unreachable");
    expect(gate.intent).toBe("submit-form");
    expect(gate.message).toContain("browser_submit");
  });

  test("attack: a click aimed at a purchase control is refused with the purchase intent", () => {
    const target = button({ name: "Buy now", label: "Buy now" });
    const gate = gateGenericAction({ action: click(target), element: target });
    expect(gate).toMatchObject({ kind: "use-submit", intent: "purchase" });
  });

  test("attack: a right-click instead of a left-click does not bypass the gate", () => {
    const target = button({ name: "Delete account" });
    const gate = gateGenericAction({
      action: { kind: "click", target, button: "right" },
      element: target,
    });
    expect(gate).toMatchObject({ kind: "use-submit", intent: "delete" });
  });

  test("attack: dragging onto a commitment control is refused like a click", () => {
    const source = button({ ref: elementRefId("src"), name: "Item" });
    const target = button({ name: "Place order" });
    const gate = gateGenericAction({
      action: { kind: "drag", source, target },
      element: target,
      source,
    });
    expect(gate).toMatchObject({ kind: "use-submit", intent: "purchase" });
  });

  test("attack: pressing Enter in a field submits the form, so it is gated too", () => {
    const field = sampleElement();
    const submitter = button({
      ref: elementRefId("go"),
      inputType: "submit",
      name: "Submit application",
    });
    const gate = gateGenericAction({
      action: { kind: "press", target: field, key: "Enter" },
      element: field,
      observed: [field, submitter],
    });
    expect(gate).toMatchObject({ kind: "use-submit", intent: "submit-form" });
  });

  test("ordinary typing keys are not treated as form activation", () => {
    const field = sampleElement();
    const submitter = button({ ref: elementRefId("go"), inputType: "submit" });
    const gate = gateGenericAction({
      action: { kind: "press", target: field, key: "a" },
      element: field,
      observed: [field, submitter],
    });
    expect(gate.kind).toBe("allow");
  });

  test("attack: an unresolvable target fails closed instead of executing unclassified", () => {
    const gate = gateGenericAction({ action: click(button()), element: undefined });
    expect(gate.kind).toBe("deny");
  });

  test("reversible interaction with an ordinary field is still allowed", () => {
    const field = sampleElement();
    const gate = gateGenericAction({
      action: { kind: "fill", target: field, value: "Ada Lovelace" },
      element: field,
    });
    expect(gate.kind).toBe("allow");
  });
});

describe("BD14 — authentication controls route to takeover", () => {
  test("attack: filling a password field is refused even with a value in hand", () => {
    const field = sampleElement({
      inputType: "password",
      name: "Password",
      label: "Password",
      value: REDACTED,
    });
    const gate = gateGenericAction({
      action: { kind: "fill", target: field, value: "hunter2" },
      element: field,
    });
    expect(gate).toMatchObject({ kind: "takeover", reason: "password" });
  });

  test("attack: a page relabelling a password field as plain text does not help", () => {
    const field = sampleElement({
      inputType: "text",
      name: "Password",
      label: "Not a password, just a normal text box",
      risk: undefined,
    });
    const gate = gateGenericAction({
      action: { kind: "type", target: field, text: "hunter2" },
      element: field,
    });
    expect(gate.kind).toBe("takeover");
  });

  test("attack: clicking a captcha checkbox routes to takeover, never to solving", () => {
    const box = button({ role: "checkbox", name: "I'm not a robot", label: "reCAPTCHA" });
    const gate = gateGenericAction({ action: click(box), element: box });
    expect(gate).toMatchObject({ kind: "takeover", reason: "captcha" });
  });

  test("authentication outranks commitment so a login submit still asks for takeover", () => {
    const control = button({ inputType: "submit", name: "Sign in with password" });
    expect(gateGenericAction({ action: click(control), element: control }).kind).toBe("takeover");
  });
});

describe("uploads are not reachable through generic fills", () => {
  test("attack: filling a file input with a path is denied", () => {
    const input = sampleElement({ inputType: "file", name: "Resume" });
    const gate = gateGenericAction({
      action: { kind: "fill", target: input, value: "/etc/passwd" },
      element: input,
    });
    expect(gate.kind).toBe("deny");
    if (gate.kind !== "deny") throw new Error("unreachable");
    expect(gate.message).toContain("browser_upload");
  });
});

describe("declared submit intent cannot downgrade the observed control", () => {
  test("attack: a purchase button declared as submit-form is rejected", () => {
    const target = button({ inputType: "submit", name: "Buy now — $499" });
    const check = validateSubmitIntent("submit-form", target);
    expect(check).toMatchObject({ kind: "mismatch", classified: "purchase" });
  });

  test("attack: a delete button declared as send is rejected", () => {
    const target = button({ name: "Delete everything" });
    expect(validateSubmitIntent("send", target).kind).toBe("mismatch");
  });

  test("attack: over-declaring a plain form submit as a purchase is also rejected", () => {
    const target = button({ inputType: "submit", name: "Submit application" });
    expect(validateSubmitIntent("purchase", target).kind).toBe("mismatch");
  });

  test("a control with no classified external effect cannot be submitted at all", () => {
    expect(validateSubmitIntent("submit-form", sampleElement()).kind).toBe("not-committal");
  });

  test("a matching declaration passes", () => {
    const target = button({ inputType: "submit", name: "Submit application" });
    expect(validateSubmitIntent("submit-form", target).kind).toBe("ok");
  });
});
