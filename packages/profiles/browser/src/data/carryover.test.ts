import { describe, expect, test } from "bun:test";
import type { BrowserCarryover } from "../contracts/carryover.ts";
import { findSerializationViolations } from "../contracts/json.ts";
import { authorizedDocumentId } from "../contracts/primitives.ts";
import {
  applyGroundedCarryover,
  groundedCarryover,
  isValidCarryover,
  resumedFactIds,
} from "./carryover.ts";
import { createQuestionQueue } from "./questions.ts";
import { SAMPLE_ORIGIN, SAMPLE_REVISION, SAMPLE_TAB, SAMPLE_URL } from "./samples.ts";

function baseCarryover(): BrowserCarryover {
  return {
    connection: { mode: "extension", browser: "chrome", phase: "ready" },
    active: {
      tabId: SAMPLE_TAB,
      url: SAMPLE_URL,
      origin: SAMPLE_ORIGIN,
      title: "Apply",
      revision: SAMPLE_REVISION,
    },
    allowedOrigins: [SAMPLE_ORIGIN],
    completedSteps: ["Opened the application form"],
    outstandingSteps: ["Upload the resume"],
    filledFields: [],
    unresolvedQuestions: [],
    uploadedDocumentIds: [],
  };
}

function questions() {
  const queue = createQuestionQueue();
  queue.ask({
    field: "desired_salary",
    label: "Desired annual salary",
    reason: "policy-required",
    required: true,
  });
  queue.ask({ field: "gender", label: "Gender (optional)", reason: "voluntary-demographic" });
  return queue.pending();
}

describe("grounded carryover", () => {
  test("filled fields survive as label, fact id and origin", () => {
    const carryover = groundedCarryover({
      filledFields: [
        { label: "Email address", factId: "fact-email", origin: SAMPLE_ORIGIN },
        { label: "City", factId: "fact-city", origin: SAMPLE_ORIGIN },
      ],
      questions: [],
    });
    expect(carryover.filledFields).toHaveLength(2);
    expect(carryover.filledFields[0]).toEqual({
      label: "Email address",
      factId: "fact-email",
      origin: SAMPLE_ORIGIN,
    });
  });

  test("a field refilled after a validation error is one disclosure, not two", () => {
    const carryover = groundedCarryover({
      filledFields: [
        { label: "Email address", factId: "fact-old", origin: SAMPLE_ORIGIN },
        { label: "Email address", factId: "fact-new", origin: SAMPLE_ORIGIN },
      ],
      questions: [],
    });
    expect(carryover.filledFields).toHaveLength(1);
    expect(carryover.filledFields[0]?.factId).toBe("fact-new");
  });

  test("the same label on a different origin is a different disclosure", () => {
    const carryover = groundedCarryover({
      filledFields: [
        { label: "Email address", factId: "fact-a", origin: SAMPLE_ORIGIN },
        { label: "Email address", factId: "fact-b", origin: "https://other.example.com" },
      ],
      questions: [],
    });
    expect(carryover.filledFields).toHaveLength(2);
  });

  test("unresolved questions survive as their prompts", () => {
    const carryover = groundedCarryover({ filledFields: [], questions: questions() });
    expect(carryover.unresolvedQuestions).toHaveLength(2);
    expect(carryover.unresolvedQuestions[0]).toContain("Desired annual salary");
    expect(carryover.unresolvedQuestions[1]).toContain("voluntary demographic");
  });

  test("uploaded document ids survive and are deduplicated", () => {
    const id = authorizedDocumentId("doc-resume");
    const carryover = groundedCarryover({
      filledFields: [],
      questions: [],
      uploadedDocumentIds: [id, id],
    });
    expect(carryover.uploadedDocumentIds).toEqual([id]);
  });
});

describe("secret-free by construction", () => {
  test("no value reaches the carryover, only labels and ids", () => {
    const carryover = groundedCarryover({
      filledFields: [
        { label: "Desired annual salary", factId: "fact-salary", origin: SAMPLE_ORIGIN },
      ],
      questions: questions(),
      uploadedDocumentIds: [authorizedDocumentId("doc-resume")],
    });
    const serialized = JSON.stringify(carryover);
    expect(serialized).not.toContain("120000");
    expect(serialized).not.toContain("ada.testwell@example.invalid");
  });

  test("the carryover is JSON-serializable and round-trips", () => {
    const carryover = groundedCarryover({
      filledFields: [{ label: "City", factId: "fact-city", origin: SAMPLE_ORIGIN }],
      questions: questions(),
    });
    expect(findSerializationViolations(carryover)).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(carryover))).toEqual(carryover);
  });
});

describe("merging into the session carryover", () => {
  test("the grounded slice replaces only the fields this lane owns", () => {
    const base = baseCarryover();
    const merged = applyGroundedCarryover(
      base,
      groundedCarryover({
        filledFields: [{ label: "City", factId: "fact-city", origin: SAMPLE_ORIGIN }],
        questions: questions(),
        uploadedDocumentIds: [authorizedDocumentId("doc-resume")],
      }),
    );
    expect(merged.connection).toEqual(base.connection);
    expect(merged.active).toEqual(base.active);
    expect(merged.completedSteps).toEqual(base.completedSteps);
    expect(merged.filledFields).toHaveLength(1);
    expect(merged.unresolvedQuestions).toHaveLength(2);
  });

  test("the merged carryover satisfies the browser carryover contract", () => {
    const merged = applyGroundedCarryover(
      baseCarryover(),
      groundedCarryover({
        filledFields: [{ label: "City", factId: "fact-city", origin: SAMPLE_ORIGIN }],
        questions: questions(),
        uploadedDocumentIds: [authorizedDocumentId("doc-resume")],
      }),
    );
    expect(isValidCarryover(merged)).toBe(true);
  });
});

describe("resume", () => {
  test("what was filled is remembered by fact id, not by remembered text", () => {
    const merged = applyGroundedCarryover(
      baseCarryover(),
      groundedCarryover({
        filledFields: [
          { label: "City", factId: "fact-city", origin: SAMPLE_ORIGIN },
          { label: "Email address", factId: "fact-email", origin: SAMPLE_ORIGIN },
          { label: "Portfolio URL", origin: SAMPLE_ORIGIN },
        ],
        questions: [],
      }),
    );
    expect(resumedFactIds(merged)).toEqual(["fact-city", "fact-email"]);
  });
});
