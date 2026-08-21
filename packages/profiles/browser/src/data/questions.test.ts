import { describe, expect, test } from "bun:test";
import { createFactStore } from "./facts.ts";
import { mergeFacts } from "./merge.ts";
import { answerCandidate, batchQuestions, createQuestionQueue } from "./questions.ts";
import { fact, SAMPLE_TIME } from "./samples.ts";

describe("question text", () => {
  test("a missing required fact names the field and why it cannot be inferred", () => {
    const queue = createQuestionQueue();
    const result = queue.ask({
      field: "desired_salary",
      label: "Desired annual salary",
      reason: "missing",
      required: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.question.prompt).toContain("Desired annual salary");
    expect(result.question.prompt).toContain("not in your resume");
    expect(result.question.prompt).toContain("What should I enter?");
  });

  test("a voluntary demographic question says it will not be answered without instruction", () => {
    const queue = createQuestionQueue();
    const result = queue.ask({
      field: "gender",
      label: "Gender (optional)",
      reason: "voluntary-demographic",
      options: ["Decline to self-identify", "Female", "Male"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.question.prompt).toContain("voluntary demographic");
    expect(result.question.prompt).toContain("without your instruction");
    expect(result.question.options).toHaveLength(3);
    expect(result.question.sensitivity).toBe("sensitive");
  });

  test("a conflict question carries the merge explanation", () => {
    const queue = createQuestionQueue();
    const [resolution] = mergeFacts([
      { layer: "profile", fact: fact({ id: "f-a", field: "city", value: "Springfield" }) },
      { layer: "profile", fact: fact({ id: "f-b", field: "city", value: "Shelbyville" }) },
    ]);
    const result = queue.askConflict(resolution as NonNullable<typeof resolution>, "City", true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.question.prompt).toContain("disagree about City");
    expect(result.question.prompt).toContain("Springfield");
  });

  test("a takeover prompt sends the user to the browser and never asks for a secret", () => {
    const queue = createQuestionQueue();
    const result = queue.ask({
      field: "login",
      label: "Signing in",
      reason: "takeover",
      takeoverReason: "mfa",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.question.prompt).toContain("needs you in the browser");
    expect(result.question.prompt).toContain("do not type anything sensitive here");
    expect(result.question.takeoverReason).toBe("mfa");
    expect(result.question.batchable).toBe(false);
  });
});

describe("what is never asked", () => {
  test("the queue refuses to ask for a credential", () => {
    const queue = createQuestionQueue();
    for (const [field, label] of [
      ["password", "Account password"],
      ["mfa_code", "One-time code"],
      ["security_answer", "Security answer"],
    ]) {
      const result = queue.ask({
        field: field as string,
        label: label as string,
        reason: "missing",
        required: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("credential");
    }
    expect(queue.pending()).toHaveLength(0);
  });

  test("the queue refuses to ask for restricted or solicited identity data", () => {
    const queue = createQuestionQueue();
    expect(queue.ask({ field: "ssn", label: "SSN", reason: "missing" }).ok).toBe(false);
    expect(
      queue.ask({ field: "mothers_maiden_name", label: "Mother's maiden name", reason: "missing" })
        .ok,
    ).toBe(false);
    expect(
      queue.ask({ field: "salary_history", label: "Prior salary history", reason: "missing" }).ok,
    ).toBe(false);
  });

  test("a takeover is still allowed to name the credential step", () => {
    const queue = createQuestionQueue();
    const result = queue.ask({
      field: "password",
      label: "Password entry",
      reason: "takeover",
      takeoverReason: "password",
    });
    expect(result.ok).toBe(true);
  });
});

describe("batching", () => {
  test("independent questions share one questionnaire", () => {
    const queue = createQuestionQueue();
    for (const field of ["city", "country", "notice_period"]) {
      queue.ask({ field, label: field, reason: "missing", required: true });
    }
    const batches = queue.batches();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.questions).toHaveLength(3);
  });

  test("a takeover is never batched with unrelated questions", () => {
    const queue = createQuestionQueue();
    queue.ask({ field: "city", label: "City", reason: "missing" });
    queue.ask({ field: "login", label: "Signing in", reason: "takeover", takeoverReason: "login" });
    queue.ask({ field: "country", label: "Country", reason: "missing" });
    const batches = queue.batches();
    const takeover = batches.filter((batch) => batch.kind === "takeover");
    expect(takeover).toHaveLength(1);
    expect(takeover[0]?.questions).toHaveLength(1);
    for (const batch of batches) {
      const kinds = new Set(batch.questions.map((question) => question.reason === "takeover"));
      expect(kinds.size).toBe(1);
    }
  });

  test("batches are bounded", () => {
    const questions = Array.from({ length: 7 }, (_, index) => ({
      id: `question-${index}`,
      field: "city",
      label: "City",
      prompt: "?",
      reason: "missing" as const,
      required: false,
      sensitivity: "personal" as const,
      options: [],
      batchable: true,
    }));
    expect(batchQuestions(questions, 3).map((batch) => batch.questions.length)).toEqual([3, 3, 1]);
  });
});

describe("answers", () => {
  test("an answer becomes a user-sourced exact fact", () => {
    const queue = createQuestionQueue();
    const result = queue.ask({
      field: "desired_salary",
      label: "Desired annual salary",
      reason: "policy-required",
      required: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const store = createFactStore({ now: () => SAMPLE_TIME });
    const admitted = store.add(answerCandidate(result.question, "120000"));
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.fact.source).toEqual({ kind: "user", label: "Desired annual salary" });
    expect(admitted.fact.confidence).toBe("exact");
    expect(admitted.fact.sensitivity).toBe("sensitive");
    expect(queue.resolve(result.question.id)?.id).toBe(result.question.id);
    expect(queue.pending()).toHaveLength(0);
  });
});
