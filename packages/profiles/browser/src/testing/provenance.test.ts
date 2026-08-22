import { describe, expect, test } from "bun:test";
import type { ApplicantFact, ApplicantPolicy } from "../contracts/applicant.ts";
import type { BrowserElement } from "../contracts/observation.ts";
import { elementRefId } from "../contracts/primitives.ts";
import { createFactStore, type FactCandidate } from "../data/facts.ts";
import { ingestDocument } from "../data/ingest.ts";
import { type LayeredFact, mergeFacts } from "../data/merge.ts";
import { type FillPlan, planFill } from "../data/plan.ts";
import { createQuestionQueue } from "../data/questions.ts";
import {
  applyFormElements,
  policyFact,
  SAMPLE_TIME,
  SAMPLE_URL,
  SYNTHETIC_APPLICANT,
  sampleResume,
} from "../data/samples.ts";
import { type ReceivedSubmission, verifyProvenance } from "./provenance.ts";
import { sampleObservation } from "./samples.ts";

const WORK_AUTH = policyFact("work_authorization", "yes", "fact-auth");
const POLICY: ApplicantPolicy = {
  workAuthorizationFactId: WORK_AUTH.id,
  defaultDemographicBehavior: "decline",
};

function stated(field: string, value: string): FactCandidate {
  return { field, value, source: { kind: "user" }, confidence: "exact" };
}

function grounded(elements: BrowserElement[]): FillPlan {
  const document = sampleResume();
  const store = createFactStore({ documents: [document], policy: POLICY, now: () => SAMPLE_TIME });
  const layers: LayeredFact[] = [];
  store.adopt(WORK_AUTH as ApplicantFact);
  for (const candidate of ingestDocument(document).candidates) {
    const result = store.add(candidate);
    if (result.ok) layers.push({ layer: "document", fact: result.fact });
  }
  for (const [field, value] of [
    ["first_name", SYNTHETIC_APPLICANT.firstName],
    ["last_name", SYNTHETIC_APPLICANT.lastName],
  ] as const) {
    const result = store.add({ ...stated(field, value), updatedAt: SAMPLE_TIME + 1 });
    if (result.ok) layers.push({ layer: "profile", fact: result.fact });
  }
  return planFill({
    url: SAMPLE_URL,
    elements,
    facts: store,
    policy: POLICY,
    questions: createQuestionQueue(),
    resolutions: mergeFacts(layers),
  });
}

function submission(fields: { name: string; value: string }[]): ReceivedSubmission {
  return { path: "/apply", fields, files: [] };
}

describe("what the server received is checked against where it came from", () => {
  const elements = applyFormElements();
  const observation = sampleObservation({ elements, risks: [], frames: [] });
  const plan = grounded(elements);

  test("a planned fill is attributed to its fact and its chain", () => {
    const first = plan.fills.find((fill) => fill.field === "first_name");
    expect(first).toBeDefined();
    const report = verifyProvenance({
      submission: submission([{ name: "First name", value: first?.text ?? "" }]),
      plan,
      observation,
    });
    expect(report.ok).toBe(true);
    const value = report.values[0];
    expect(value?.source?.kind).toBe("plan");
    if (value?.source?.kind === "plan") {
      expect(value.source.factId).toBe(first?.factId);
      expect(value.source.chain.length).toBeGreaterThan(0);
    }
  });

  // The failure this whole module exists for: a value nobody supplied.
  test("a value that traces to nothing is reported, and the report is not ok", () => {
    const report = verifyProvenance({
      submission: submission([{ name: "Desired annual salary", value: "185000" }]),
      plan,
      observation,
    });
    expect(report.ok).toBe(false);
    expect(report.values[0]?.unattributed).toContain("traces to no fact");
    // The value itself is never repeated back into the report.
    expect(JSON.stringify(report)).not.toContain("185000");
  });

  test("an answer the user typed is a source, and only for the field they typed it in", () => {
    const answers = [{ field: "Desired annual salary", text: "185000" }];
    const accepted = verifyProvenance({
      submission: submission([{ name: "Desired annual salary", value: "185000" }]),
      plan,
      observation,
      answers,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.values[0]?.source?.kind).toBe("user");

    const elsewhere = verifyProvenance({
      submission: submission([{ name: "Phone number", value: "185000" }]),
      plan,
      observation,
      answers,
    });
    expect(elsewhere.ok).toBe(false);
  });

  test("a hidden token the page posts itself is the page's, not an invention", () => {
    const report = verifyProvenance({
      submission: submission([{ name: "csrf_token", value: "abc123" }]),
      plan,
      observation,
    });
    expect(report.ok).toBe(true);
    expect(report.values[0]?.source).toMatchObject({ kind: "page" });
  });

  test("an empty field is neither a disclosure nor a problem", () => {
    const report = verifyProvenance({
      submission: submission([{ name: "Phone number", value: "" }]),
      plan,
      observation,
    });
    expect(report.ok).toBe(true);
    expect(report.values[0]?.source?.kind).toBe("empty");
  });

  test("only an authorized document counts as uploaded, and only with its own bytes", () => {
    const document = sampleResume();
    const authorized = verifyProvenance({
      submission: {
        path: "/apply",
        fields: [],
        files: [{ field: "Resume", basename: document.basename, sha256: document.sha256 }],
      },
      plan,
      observation,
      documents: [document],
    });
    expect(authorized.ok).toBe(true);

    const swapped = verifyProvenance({
      submission: {
        path: "/apply",
        fields: [],
        files: [{ field: "Resume", basename: document.basename, sha256: `${"9".repeat(63)}0` }],
      },
      plan,
      observation,
      documents: [document],
    });
    expect(swapped.ok).toBe(false);
    expect(swapped.files[0]?.detail).toContain("does not match");

    const unauthorized = verifyProvenance({
      submission: {
        path: "/apply",
        fields: [],
        files: [{ field: "Resume", basename: "someone-elses.pdf" }],
      },
      plan,
      observation,
      documents: [document],
    });
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.files[0]?.detail).toContain("never authorized");
  });
});
