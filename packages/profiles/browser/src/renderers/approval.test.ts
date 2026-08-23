import { describe, expect, test } from "bun:test";
import { elementRefId } from "../contracts/primitives.ts";
import { SAMPLE_ORIGIN, sampleElement, sampleFact, sampleObservation } from "../testing/samples.ts";
import {
  browserApprovalRequest,
  browserApprovalRequestSchema,
  choiceForKey,
  decideHeadlessApproval,
  parseBrowserApprovalReply,
  resolveApprovalReply,
} from "./approval.ts";
import { approvalField, fieldFromFact, interactApprovalCard, submitApprovalCard } from "./card.ts";

const observation = sampleObservation();
const submitElement = observation.elements[1];

function submitCard(overrides: Partial<Parameters<typeof submitApprovalCard>[0]> = {}) {
  return submitApprovalCard({
    scopes: ["browser:submit"],
    pattern: `${SAMPLE_ORIGIN} submit-form Submit application`,
    intent: "submit-form",
    observation,
    element: submitElement,
    disclosedFieldNames: ["Full name", "Email"],
    ...overrides,
  });
}

describe("a structured request carries enough for a non-interactive caller", () => {
  const request = browserApprovalRequest(submitCard(), "req-1");

  test("it validates against its own schema and is JSON round-trippable", () => {
    const round = browserApprovalRequestSchema.parse(JSON.parse(JSON.stringify(request)));
    expect(round).toEqual(request);
  });

  test("it names the scope, pattern, origin, action and reversibility", () => {
    expect(request.scopes).toEqual(["browser:submit"]);
    expect(request.pattern).toBe(`${SAMPLE_ORIGIN} submit-form Submit application`);
    expect(request.origin).toBe(SAMPLE_ORIGIN);
    expect(request.intent).toBe("submit-form");
    expect(request.reversibility).toBe("irreversible");
    expect(request.action).toContain("submit this form");
  });

  test("it carries the material fields and the rendered preview together", () => {
    expect(request.fields.map((field) => field.label)).toEqual(["Full name", "Email"]);
    expect(request.preview.join("\n")).toContain(SAMPLE_ORIGIN);
    expect(request.preview.length).toBeGreaterThan(3);
  });

  test("it enumerates exactly the choices the card offers", () => {
    expect(request.choices).toEqual(["review", "allow-once", "allow-task", "deny"]);
    expect(request.offersTaskScope).toBe(true);
  });
});

describe("the structured request obeys the no-preview rule", () => {
  test("an incomplete preview travels without the task-scope choice", () => {
    const request = browserApprovalRequest(
      submitCard({ element: undefined, disclosedFieldNames: [] }),
      "req-2",
    );
    expect(request.previewComplete).toBe(false);
    expect(request.offersTaskScope).toBe(false);
    expect(request.choices).not.toContain("allow-task");
    expect(request.incompleteReasons.length).toBeGreaterThan(0);
  });

  test("a hand-built request that offers task scope without a preview is rejected", () => {
    const request = browserApprovalRequest(submitCard({ element: undefined }), "req-3");
    const forged = {
      ...request,
      offersTaskScope: true,
      choices: [...request.choices, "allow-task"],
    };
    const parsed = browserApprovalRequestSchema.safeParse(forged);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("never offered as remembered");
  });

  test("choices and offersTaskScope cannot disagree", () => {
    const request = browserApprovalRequest(submitCard(), "req-4");
    const forged = { ...request, offersTaskScope: false };
    expect(browserApprovalRequestSchema.safeParse(forged).success).toBe(false);
  });
});

describe("no secret reaches a structured request", () => {
  test("a withheld value is absent from the serialized event, not just from the preview", () => {
    const fact = sampleFact({
      id: "fact-salary",
      field: "desired_salary",
      value: "185000",
      sensitivity: "sensitive",
    });
    const card = interactApprovalCard({
      scopes: ["browser:disclose"],
      pattern: `${SAMPLE_ORIGIN} desired salary`,
      observation,
      element: observation.elements[0],
      actionVerb: "fill",
      fields: [fieldFromFact(fact)],
      redactValues: ["185000"],
    });
    const serialized = JSON.stringify(browserApprovalRequest(card, "req-5"));
    expect(serialized).not.toContain("185000");
    expect(serialized).toContain("withheld");
  });

  test("a credential field never appears in the wire form", () => {
    const request = browserApprovalRequest(
      submitCard({ disclosedFieldNames: ["Full name", "Password"] }),
      "req-6",
    );
    expect(JSON.stringify(request)).not.toContain("Password");
    expect(request.suppressedFieldCount).toBe(1);
  });

  // The text preview scrubs generic secret shapes for every line via `safeLines`
  // (renderers/text.ts), regardless of the caller's own redactValues. The structured
  // form is the same event on the wire — a headless caller, an RPC client or the
  // permission_asked payload sees it instead of the rendered text — so a value that
  // was never explicitly declared sensitive still must not survive there unscrubbed.
  test("a card-number-shaped value in a non-withheld field is scrubbed in the wire form too", () => {
    const field = approvalField({
      label: "Note",
      sensitivity: "personal",
      value: "card 4111 1111 1111 1111 on file",
    });
    expect(field?.withheld).toBe(false);
    const card = interactApprovalCard({
      scopes: ["browser:disclose"],
      pattern: `${SAMPLE_ORIGIN} note`,
      observation,
      element: observation.elements[0],
      actionVerb: "fill",
      fields: [field],
    });
    const request = browserApprovalRequest(card, "req-7");
    expect(request.fields[0]?.value).not.toContain("4111 1111 1111 1111");
    expect(JSON.stringify(request)).not.toContain("4111 1111 1111 1111");
  });

  test("a bearer token smuggled into a warning is scrubbed in the wire form too", () => {
    const card = submitCard({
      reasons: ["the page said: authorization: Bearer abcdef0123456789"],
    });
    const request = browserApprovalRequest(card, "req-8");
    expect(JSON.stringify(request.warnings)).not.toContain("abcdef0123456789");
  });
});

describe("deny, allow-once and task-scoped approval", () => {
  const card = submitCard();

  test("deny answers the kernel with deny and remembers nothing", () => {
    const resolution = resolveApprovalReply(card, { requestId: "req-1", outcome: "deny" });
    expect(resolution).toMatchObject({ outcome: "deny", remember: false, applied: "deny" });
  });

  test("allow-once allows without remembering", () => {
    const resolution = resolveApprovalReply(card, { requestId: "req-1", outcome: "allow-once" });
    expect(resolution).toMatchObject({ outcome: "allow", remember: false, applied: "allow-once" });
  });

  test("allow-task allows and remembers, and says the scope out loud", () => {
    const resolution = resolveApprovalReply(card, { requestId: "req-1", outcome: "allow-task" });
    expect(resolution).toMatchObject({ outcome: "allow", remember: true, applied: "allow-task" });
    expect(resolution.message).toContain("expires with the task");
    expect(resolution.message).not.toContain("always");
  });

  test("review pauses rather than allowing, and asks for takeover", () => {
    const resolution = resolveApprovalReply(card, { requestId: "req-1", outcome: "review" });
    expect(resolution.outcome).toBe("deny");
    expect(resolution.takeover?.reason).toBe("user-requested");
    expect(resolution.takeover?.instructions).toContain("visible browser");
  });
});

describe("a reply may narrow authority and never widen it", () => {
  test("task scope on an incomplete preview is clamped to a single allowance", () => {
    const card = submitCard({ element: undefined });
    const resolution = resolveApprovalReply(card, { requestId: "req-2", outcome: "allow-task" });
    expect(resolution).toMatchObject({
      outcome: "allow",
      remember: false,
      applied: "allow-once",
      clamped: "task-scope-not-offered",
    });
    expect(resolution.message).toContain("preview is incomplete");
  });

  test("task scope on a never-auto-allowed class is clamped too", () => {
    const deleteButton = sampleElement({
      ref: elementRefId("e8"),
      role: "button",
      name: "Delete account",
      label: "Delete account",
      risk: ["delete"],
    });
    const card = submitApprovalCard({
      scopes: ["browser:delete"],
      pattern: `${SAMPLE_ORIGIN} delete Delete account`,
      intent: "delete",
      observation: sampleObservation({
        elements: [...observation.elements, deleteButton],
        risks: ["submit", "delete"],
      }),
      element: deleteButton,
    });
    const resolution = resolveApprovalReply(card, { requestId: "req-3", outcome: "allow-task" });
    expect(resolution.remember).toBe(false);
    expect(resolution.applied).toBe("allow-once");
    expect(resolution.message).toContain("always asks");
  });

  test("review on a card that does not offer it denies rather than allowing", () => {
    const card = submitApprovalCard({
      scopes: ["browser:submit"],
      pattern: `${SAMPLE_ORIGIN} submit-form Submit application`,
      intent: "submit-form",
      observation,
      element: submitElement,
    });
    const withoutReview = { ...card, choices: card.choices.filter((c) => c.id !== "review") };
    const resolution = resolveApprovalReply(withoutReview, {
      requestId: "req-4",
      outcome: "review",
    });
    expect(resolution.outcome).toBe("deny");
    expect(resolution.clamped).toBe("choice-not-offered");
  });
});

describe("replies arrive as data, not as keystrokes", () => {
  test("a well-formed reply parses", () => {
    const parsed = parseBrowserApprovalReply({ requestId: "req-1", outcome: "allow-task" });
    expect(parsed.ok).toBe(true);
  });

  test("an unknown outcome is refused rather than coerced", () => {
    const parsed = parseBrowserApprovalReply({ requestId: "req-1", outcome: "always" });
    expect(parsed.ok).toBe(false);
  });

  test("an unknown extra key is refused", () => {
    const parsed = parseBrowserApprovalReply({
      requestId: "req-1",
      outcome: "allow-once",
      remember: true,
    });
    expect(parsed.ok).toBe(false);
  });

  test("a headless caller decides in one call", () => {
    const result = decideHeadlessApproval(submitCard(), {
      requestId: "req-1",
      outcome: "allow-task",
      note: "approved by the operator",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.resolution.remember).toBe(true);
  });

  test("a malformed headless reply is reported, not applied", () => {
    const result = decideHeadlessApproval(submitCard(), { outcome: "allow-once" });
    expect(result.ok).toBe(false);
  });
});

describe("a terminal key maps to the same vocabulary as an RPC reply", () => {
  const card = submitCard();

  test("each offered key resolves to its choice", () => {
    expect(choiceForKey(card, "r")).toBe("review");
    expect(choiceForKey(card, "a")).toBe("allow-once");
    expect(choiceForKey(card, "t")).toBe("allow-task");
    expect(choiceForKey(card, "D")).toBe("deny");
  });

  test("a key the card does not offer resolves to nothing", () => {
    const incomplete = submitCard({ element: undefined });
    expect(choiceForKey(incomplete, "t")).toBeUndefined();
    expect(choiceForKey(card, "y")).toBeUndefined();
  });
});
