import type { ApplicantFactSensitivity } from "../contracts/applicant.ts";
import { isCredentialLabel, isRestrictedField } from "../contracts/redaction.ts";
import type { TakeoverReason } from "../contracts/takeover.ts";
import type { FactCandidate } from "./facts.ts";
import { fieldSensitivity, isUnsolicitedPersonalField } from "./fields.ts";
import type { FieldResolution } from "./merge.ts";

export type QuestionReason =
  | "missing"
  | "conflicting"
  | "ambiguous"
  | "unrecognized"
  | "policy-required"
  | "voluntary-demographic"
  | "takeover";

export interface GroundingQuestion {
  id: string;
  field: string;
  label: string;
  prompt: string;
  reason: QuestionReason;
  required: boolean;
  sensitivity: ApplicantFactSensitivity;
  options: string[];
  // DESIGN.md: independent missing facts share one small questionnaire, but a takeover
  // never does — browser state can expire while the user works through unrelated answers.
  batchable: boolean;
  takeoverReason?: TakeoverReason | undefined;
}

export type QuestionRefusal = "credential" | "restricted" | "solicitation";

export type AskResult =
  | { ok: true; question: GroundingQuestion }
  | { ok: false; reason: QuestionRefusal; detail: string };

export interface AskInput {
  field: string;
  label: string;
  reason: QuestionReason;
  required?: boolean | undefined;
  options?: readonly string[] | undefined;
  detail?: string | undefined;
  takeoverReason?: TakeoverReason | undefined;
}

export const DEFAULT_QUESTION_BATCH_SIZE = 5;

function optional(required: boolean): string {
  return required ? "requires" : "asks for";
}

export function questionPrompt(input: AskInput): string {
  const required = input.required === true;
  switch (input.reason) {
    case "missing":
      return `The form ${optional(required)} ${input.label}. It is not in your resume, saved profile or previous answers. What should I enter?`;
    case "conflicting":
      return `Your sources disagree about ${input.label}${input.detail === undefined ? "" : ` (${input.detail})`}. Which value is correct?`;
    case "ambiguous":
      return `I cannot tell which value belongs in ${input.label}${input.detail === undefined ? "" : ` — ${input.detail}`}. What should I enter?`;
    case "unrecognized":
      return `The form ${optional(required)} "${input.label}" and I could not tell what it is asking for. What should I enter, if anything?`;
    case "policy-required":
      return `${input.label} is a consequential answer I will not infer. What should I enter?`;
    case "voluntary-demographic":
      return `${input.label} is a voluntary demographic question. I will not answer it without your instruction. Answer it, decline to answer, or leave it blank?`;
    case "takeover":
      return `${input.label} needs you in the browser. ${input.detail ?? "Finish it there, then resume — do not type anything sensitive here."}`;
  }
}

export class QuestionQueue {
  readonly #questions = new Map<string, GroundingQuestion>();
  #sequence = 0;

  ask(input: AskInput): AskResult {
    const subject = `${input.field} ${input.label}`;
    if (input.reason !== "takeover") {
      if (isCredentialLabel(subject)) {
        return {
          ok: false,
          reason: "credential",
          detail: "a password, passkey, MFA or one-time code is entered in the browser, never here",
        };
      }
      if (isRestrictedField(subject)) {
        return { ok: false, reason: "restricted", detail: "restricted identifiers are not asked" };
      }
      if (isUnsolicitedPersonalField(subject)) {
        return {
          ok: false,
          reason: "solicitation",
          detail: "asking the user for this on a page's behalf is the same disclosure, delayed",
        };
      }
    }
    this.#sequence += 1;
    const question: GroundingQuestion = {
      id: `question-${this.#sequence}`,
      field: input.field,
      label: input.label,
      prompt: questionPrompt(input),
      reason: input.reason,
      required: input.required === true,
      sensitivity: fieldSensitivity(input.field),
      options: [...(input.options ?? [])],
      batchable: input.reason !== "takeover",
      ...(input.takeoverReason === undefined ? {} : { takeoverReason: input.takeoverReason }),
    };
    this.#questions.set(question.id, question);
    return { ok: true, question };
  }

  askConflict(resolution: FieldResolution, label: string, required: boolean): AskResult {
    return this.ask({
      field: resolution.field,
      label,
      reason: "conflicting",
      required,
      detail: resolution.reason,
    });
  }

  pending(): GroundingQuestion[] {
    return [...this.#questions.values()];
  }

  get(id: string): GroundingQuestion | undefined {
    return this.#questions.get(id);
  }

  resolve(id: string): GroundingQuestion | undefined {
    const question = this.#questions.get(id);
    if (question !== undefined) this.#questions.delete(id);
    return question;
  }

  prompts(): string[] {
    return this.pending().map((question) => question.prompt);
  }

  batches(maxPerBatch = DEFAULT_QUESTION_BATCH_SIZE): QuestionBatch[] {
    return batchQuestions(this.pending(), maxPerBatch);
  }
}

export interface QuestionBatch {
  kind: "questions" | "takeover";
  questions: GroundingQuestion[];
}

export function batchQuestions(
  questions: readonly GroundingQuestion[],
  maxPerBatch = DEFAULT_QUESTION_BATCH_SIZE,
): QuestionBatch[] {
  const batches: QuestionBatch[] = [];
  let current: GroundingQuestion[] = [];
  for (const question of questions) {
    if (!question.batchable) {
      batches.push({ kind: "takeover", questions: [question] });
      continue;
    }
    current.push(question);
    if (current.length === maxPerBatch) {
      batches.push({ kind: "questions", questions: current });
      current = [];
    }
  }
  if (current.length > 0) batches.push({ kind: "questions", questions: current });
  return batches;
}

export function createQuestionQueue(): QuestionQueue {
  return new QuestionQueue();
}

// An answer is a first-class source, so it enters the store as a `user` fact carrying the
// question that produced it. Nothing else in the pipeline may mint a `user` fact.
export function answerCandidate(question: GroundingQuestion, value: string): FactCandidate {
  return {
    field: question.field,
    value,
    source: { kind: "user", label: question.label },
    confidence: "exact",
    sensitivity: question.sensitivity,
  };
}
