import { describe, expect, test } from "bun:test";
import { DisclosureLedger } from "../artifacts/disclosure.ts";
import type { ApplicantPolicy } from "../contracts/applicant.ts";
import { findSerializationViolations } from "../contracts/json.ts";
import { elementRefId } from "../contracts/primitives.ts";
import { groundedCarryover } from "./carryover.ts";
import { planCarryoverFields, recordPlanDisclosure } from "./disclosure.ts";
import { createFactStore, type FactCandidate } from "./facts.ts";
import { ingestDocument } from "./ingest.ts";
import { type LayeredFact, mergeFacts } from "./merge.ts";
import { isFullyGrounded, planFill } from "./plan.ts";
import { createQuestionQueue } from "./questions.ts";
import {
  applyFormElements,
  element,
  hostileElements,
  poisonedResume,
  policyFact,
  SAMPLE_TIME,
  SAMPLE_URL,
  SYNTHETIC_APPLICANT,
  sampleResume,
} from "./samples.ts";

function stated(field: string, value: string): FactCandidate {
  return { field, value, source: { kind: "user" }, confidence: "exact" };
}

/** A store grounded exactly the way the product grounds one: resume first, then profile. */
function groundedStore(document = sampleResume(), policy: ApplicantPolicy = {}) {
  const store = createFactStore({ documents: [document], policy, now: () => SAMPLE_TIME });
  const layers: LayeredFact[] = [];
  for (const candidate of ingestDocument(document).candidates) {
    const result = store.add(candidate);
    if (result.ok) layers.push({ layer: "document", fact: result.fact });
  }
  for (const [field, value] of [
    ["first_name", SYNTHETIC_APPLICANT.firstName],
    ["last_name", SYNTHETIC_APPLICANT.lastName],
    ["city", SYNTHETIC_APPLICANT.city],
  ] as const) {
    const result = store.add({ ...stated(field, value), updatedAt: SAMPLE_TIME + 1 });
    if (result.ok) layers.push({ layer: "profile", fact: result.fact });
  }
  return { store, layers };
}

const POLICY: ApplicantPolicy = {
  workAuthorization: policyFact("work_authorization", "yes", "fact-auth"),
  defaultDemographicBehavior: "decline",
};

function plan(policy: ApplicantPolicy = POLICY, elements = applyFormElements()) {
  const { store, layers } = groundedStore(sampleResume(), policy);
  const questions = createQuestionQueue();
  return {
    store,
    questions,
    plan: planFill({
      url: SAMPLE_URL,
      elements,
      facts: store,
      policy,
      questions,
      resolutions: mergeFacts(layers),
    }),
  };
}

describe("every submitted value traces to a source", () => {
  test("each fill carries a fact id and a provenance chain", () => {
    const { plan: filled, store } = plan();
    expect(filled.fills.length).toBeGreaterThan(0);
    for (const fill of filled.fills) {
      if (fill.grounding === "decline") continue;
      expect(fill.factId).toBeDefined();
      const fact = store.get(fill.factId as string);
      expect(fact).toBeDefined();
      expect(fill.provenance?.chain[0]).toBe(fill.factId as string);
      expect(fill.provenance?.grounded).toBe(true);
      expect(
        fill.provenance?.userStated === true || (fill.provenance?.documentIds.length ?? 0) > 0,
      ).toBe(true);
    }
    expect(isFullyGrounded(filled)).toBe(true);
  });

  test("a value read from the resume names the document and the line", () => {
    const { plan: filled } = plan();
    const email = filled.fills.find((fill) => fill.field === "email");
    expect(email?.text).toBe(SYNTHETIC_APPLICANT.email);
    expect(email?.provenance?.documentIds).toEqual([sampleResume().id]);
  });

  test("a policy answer is attributed to the policy, not to a guess", () => {
    const { plan: filled } = plan();
    const auth = filled.fills.find((fill) => fill.field === "work_authorization");
    expect(auth?.grounding).toBe("policy");
    expect(auth?.factId).toBe("fact-auth");
    expect(auth?.reason).toContain("policy");
  });

  test("the plan is JSON-serializable", () => {
    expect(findSerializationViolations(plan().plan)).toHaveLength(0);
  });
});

describe("nothing is invented", () => {
  test("a required field with no fact becomes a question, not a value", () => {
    const { plan: filled } = plan();
    const salary = filled.fills.find((fill) => fill.field === "desired_salary");
    expect(salary).toBeUndefined();
    const question = filled.questions.find((entry) => entry.field === "desired_salary");
    expect(question?.prompt).toContain("Desired annual salary");
    expect(question?.required).toBe(true);
  });

  test("removing the work-authorization policy turns it into a question", () => {
    const { plan: filled } = plan({ defaultDemographicBehavior: "decline" });
    expect(filled.fills.find((fill) => fill.field === "work_authorization")).toBeUndefined();
    const question = filled.questions.find((entry) => entry.field === "work_authorization");
    expect(question?.reason).toBe("policy-required");
  });

  test("a voluntary demographic question is declined through the page's own option", () => {
    const { plan: filled } = plan();
    const gender = filled.fills.find((fill) => fill.field === "gender");
    expect(gender?.grounding).toBe("decline");
    expect(gender?.text).toBe("decline");
    expect(gender?.factId).toBeUndefined();
  });

  test("without a demographic policy the question is asked, never answered", () => {
    const { plan: filled } = plan({
      workAuthorization: policyFact("work_authorization", "yes", "fact-auth"),
    });
    expect(filled.fills.find((fill) => fill.field === "gender")).toBeUndefined();
    expect(filled.questions.find((entry) => entry.field === "gender")?.reason).toBe(
      "voluntary-demographic",
    );
  });

  test("a conflicting required fact becomes a question rather than a chosen side", () => {
    const store = createFactStore({ now: () => SAMPLE_TIME });
    const a = store.add({ ...stated("email", "ada@example.invalid"), id: "fact-a" });
    const b = store.add({ ...stated("email", "testwell@example.invalid"), id: "fact-b" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const questions = createQuestionQueue();
    const filled = planFill({
      url: SAMPLE_URL,
      elements: [element({ label: "Email address", inputType: "email", required: true })],
      facts: store,
      policy: {},
      questions,
      resolutions: mergeFacts([
        { layer: "profile", fact: a.fact },
        { layer: "profile", fact: b.fact },
      ]),
    });
    expect(filled.fills).toHaveLength(0);
    expect(filled.questions[0]?.reason).toBe("conflicting");
    expect(filled.questions[0]?.prompt).toContain("disagree about");
  });

  test("a required field whose only source is an uncertain extraction is asked about", () => {
    const { store, layers } = groundedStore();
    const questions = createQuestionQueue();
    const filled = planFill({
      url: SAMPLE_URL,
      elements: [element({ label: "Full name", required: true })],
      facts: store,
      policy: {},
      questions,
      resolutions: mergeFacts(layers),
    });
    expect(filled.fills).toHaveLength(0);
    expect(filled.questions[0]?.reason).toBe("missing");
    expect(filled.questions[0]?.prompt).toContain("Full name");
  });

  test("an origin-scoped fact is skipped rather than disclosed", () => {
    const store = createFactStore({ now: () => SAMPLE_TIME });
    store.add({
      ...stated("city", "Springfield"),
      id: "fact-city",
      allowedOrigins: ["https://only-here.example.com"],
    });
    const filled = planFill({
      url: SAMPLE_URL,
      elements: [element({ label: "City" })],
      facts: store,
      policy: {},
      questions: createQuestionQueue(),
    });
    expect(filled.fills).toHaveLength(0);
    expect(filled.skipped[0]?.reason).toBe("origin-scoped");
  });
});

describe("hostile pages produce no values and no questions about identity", () => {
  test("nothing on the hidden-field page is filled", () => {
    const { plan: filled } = plan(POLICY, hostileElements());
    expect(filled.fills).toHaveLength(0);
  });

  test("the agent is never made to ask the user for the harvested fields", () => {
    const { plan: filled } = plan(POLICY, hostileElements());
    const asked = filled.questions.map((question) => question.label.toLowerCase()).join(" ");
    for (const forbidden of ["maiden", "government", "bank", "birth", "salary history"]) {
      expect(asked).not.toContain(forbidden);
    }
  });

  test("a credential control never becomes a fill or a question", () => {
    const { plan: filled } = plan();
    expect(filled.fills.some((fill) => fill.label.toLowerCase().includes("password"))).toBe(false);
    expect(
      filled.questions.some((question) => question.label.toLowerCase().includes("password")),
    ).toBe(false);
    const password = filled.skipped.find((entry) => entry.ref.ref === elementRefId("e-password"));
    expect(password?.reason).toBe("refused");
  });

  test("an instruction injected into a resume never becomes a submitted value", () => {
    const { store, layers } = groundedStore(poisonedResume(), POLICY);
    const filled = planFill({
      url: SAMPLE_URL,
      elements: applyFormElements(),
      facts: store,
      policy: POLICY,
      questions: createQuestionQueue(),
      resolutions: mergeFacts(layers),
    });
    const serialized = JSON.stringify(filled.fills);
    for (const fragment of ["/etc/passwd", "id_rsa", "cookies", "SYSTEM", "Ignore"]) {
      expect(serialized).not.toContain(fragment);
    }
    expect(isFullyGrounded(filled)).toBe(true);
  });
});

describe("the plan feeds the ledger and the carryover", () => {
  test("only grounded fills are offered to the ledger, and it accepts them", () => {
    const { plan: filled, store } = plan();
    const ledger = new DisclosureLedger({ now: () => SAMPLE_TIME });
    const result = recordPlanDisclosure(ledger, store, filled, "perm-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.factIds).toEqual(
      filled.fills.filter((fill) => fill.factId !== undefined).map((fill) => fill.factId as string),
    );
    expect(JSON.stringify(result.record)).not.toContain(SYNTHETIC_APPLICANT.email);
  });

  test("the carryover records what was filled and what is still unanswered", () => {
    const { plan: filled, questions } = plan();
    const carryover = groundedCarryover({
      filledFields: planCarryoverFields(filled),
      questions: questions.pending(),
    });
    expect(carryover.filledFields.length).toBe(filled.fills.length);
    expect(carryover.unresolvedQuestions.length).toBe(filled.questions.length);
    expect(JSON.stringify(carryover)).not.toContain(SYNTHETIC_APPLICANT.email);
  });
});
