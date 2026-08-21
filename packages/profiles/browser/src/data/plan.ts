import type { ApplicantFact, ApplicantPolicy } from "../contracts/applicant.ts";
import { factAllowsOrigin } from "../contracts/applicant.ts";
import type { BrowserElement, BrowserElementRef } from "../contracts/observation.ts";
import { normalizeOrigin } from "../contracts/primitives.ts";
import { type FactLookup, type FactProvenance, factValueText } from "./facts.ts";
import { fieldLabel } from "./fields.ts";
import { type FieldMatch, matchElements, observedLabel } from "./match.ts";
import { type FieldResolution, resolutionsByField } from "./merge.ts";
import { isPolicyGoverned, resolvePolicy } from "./policy.ts";
import type { GroundingQuestion, QuestionQueue } from "./questions.ts";

export type FillGrounding = "fact" | "policy" | "decline";

export interface FillPlanEntry {
  ref: BrowserElementRef;
  label: string;
  field: string;
  text: string;
  grounding: FillGrounding;
  factId?: string | undefined;
  provenance?: FactProvenance | undefined;
  confidence: number;
  reason: string;
}

export type SkipReason = "refused" | "policy-omit" | "origin-scoped" | "asked" | "not-a-fact-field";

export interface SkippedField {
  ref: BrowserElementRef;
  label: string;
  reason: SkipReason;
  detail: string;
}

export interface FillPlan {
  origin: string;
  url: string;
  fills: FillPlanEntry[];
  questions: GroundingQuestion[];
  skipped: SkippedField[];
  matches: FieldMatch[];
}

export interface PlanInput {
  url: string;
  elements: readonly BrowserElement[];
  facts: FactLookup;
  policy: ApplicantPolicy;
  questions: QuestionQueue;
  resolutions?: readonly FieldResolution[] | undefined;
}

function skip(match: FieldMatch, reason: SkipReason, detail: string): SkippedField {
  return { ref: match.ref, label: match.label, reason, detail };
}

function fillFromFact(
  match: FieldMatch,
  fact: ApplicantFact,
  facts: FactLookup,
  grounding: FillGrounding,
  reason: string,
): FillPlanEntry {
  return {
    ref: match.ref,
    label: match.label,
    field: match.field ?? fact.field,
    text: factValueText(fact.value),
    grounding,
    factId: fact.id,
    provenance: facts.trace(fact),
    confidence: match.confidence,
    reason,
  };
}

/**
 * Turns an observation into the exact set of values that may be typed, plus the questions
 * that must be answered first. Every entry in `fills` carries a fact id and its provenance
 * chain; there is no code path that produces a value without one, which is what makes
 * "nothing is invented" checkable rather than aspirational.
 */
export function planFill(input: PlanInput): FillPlan {
  const origin = normalizeOrigin(input.url);
  const matches = matchElements(input.elements, input.facts);
  const fills: FillPlanEntry[] = [];
  const skipped: SkippedField[] = [];
  const asked: GroundingQuestion[] = [];
  const byField =
    input.resolutions === undefined ? undefined : resolutionsByField(input.resolutions);

  const ask = (match: FieldMatch, reason: GroundingQuestion["reason"], detail?: string): void => {
    const field = match.field ?? match.label;
    const result = input.questions.ask({
      field,
      label: match.label,
      reason,
      required: match.required,
      ...(detail === undefined ? {} : { detail }),
      ...(match.status === "ambiguous" || reason === "voluntary-demographic"
        ? { options: optionLabels(input.elements, match.ref) }
        : {}),
    });
    if (result.ok) asked.push(result.question);
    else skipped.push(skip(match, "refused", result.detail));
  };

  for (const match of matches) {
    if (match.status === "refused") {
      skipped.push(skip(match, "refused", match.reason));
      continue;
    }
    if (match.status === "unnamed" || match.status === "ambiguous") {
      if (match.required)
        ask(match, match.status === "unnamed" ? "unrecognized" : "ambiguous", match.reason);
      else skipped.push(skip(match, "asked", match.reason));
      continue;
    }
    if (match.status === "unrecognized") {
      if (match.required) ask(match, "unrecognized", match.reason);
      else skipped.push(skip(match, "not-a-fact-field", match.reason));
      continue;
    }

    const field = match.field;
    if (field === undefined) {
      skipped.push(skip(match, "not-a-fact-field", match.reason));
      continue;
    }

    // A contested field behaves exactly like a missing one: the disagreement is surfaced,
    // never resolved by preferring the newer or more confident side.
    const resolution = byField?.get(field);
    if (resolution !== undefined && resolution.status === "conflict") {
      const result = input.questions.askConflict(resolution, match.label, match.required);
      if (result.ok) asked.push(result.question);
      else skipped.push(skip(match, "refused", result.detail));
      continue;
    }

    if (isPolicyGoverned(field)) {
      const decision = resolvePolicy(input.policy, input.facts, {
        field,
        label: match.label,
        required: match.required,
        ...(elementOptions(input.elements, match.ref) === undefined
          ? {}
          : { options: elementOptions(input.elements, match.ref) }),
      });
      switch (decision.kind) {
        case "answer":
          if (origin !== undefined && !factAllowsOrigin(decision.fact, origin)) {
            skipped.push(skip(match, "origin-scoped", `${field} is not disclosable to ${origin}`));
            break;
          }
          fills.push(fillFromFact(match, decision.fact, input.facts, "policy", decision.reason));
          break;
        case "decline":
          fills.push({
            ref: match.ref,
            label: match.label,
            field,
            text: decision.value,
            grounding: "decline",
            confidence: match.confidence,
            reason: decision.reason,
          });
          break;
        case "omit":
          skipped.push(skip(match, "policy-omit", decision.reason));
          break;
        case "ask":
          ask(
            match,
            field === "gender" ||
              field === "ethnicity" ||
              field === "veteran_status" ||
              field === "disability_status"
              ? "voluntary-demographic"
              : "policy-required",
            decision.reason,
          );
          break;
      }
      continue;
    }

    if (match.status === "no-fact") {
      if (match.required) ask(match, "missing", match.reason);
      else skipped.push(skip(match, "asked", match.reason));
      continue;
    }

    const fact = match.fact;
    if (fact === undefined) {
      skipped.push(skip(match, "not-a-fact-field", match.reason));
      continue;
    }
    if (origin !== undefined && !factAllowsOrigin(fact, origin)) {
      skipped.push(
        skip(match, "origin-scoped", `${fieldLabel(field)} is not disclosable to ${origin}`),
      );
      continue;
    }
    // A heuristically extracted value is good enough to offer, not good enough to commit
    // to a field the form insists on.
    if (fact.confidence === "uncertain" && match.required) {
      ask(match, "missing", `the only source for ${fieldLabel(field)} is an uncertain extraction`);
      continue;
    }
    fills.push(fillFromFact(match, fact, input.facts, "fact", match.reason));
  }

  return {
    origin: origin ?? "",
    url: input.url,
    fills,
    questions: asked,
    skipped,
    matches,
  };
}

function findElement(
  elements: readonly BrowserElement[],
  ref: BrowserElementRef,
): BrowserElement | undefined {
  return elements.find((element) => element.ref === ref.ref && element.tabId === ref.tabId);
}

function elementOptions(elements: readonly BrowserElement[], ref: BrowserElementRef) {
  return findElement(elements, ref)?.options;
}

function optionLabels(elements: readonly BrowserElement[], ref: BrowserElementRef): string[] {
  return (elementOptions(elements, ref) ?? [])
    .map((option) => option.label)
    .filter((l) => l !== "");
}

// Every value the plan would submit, with the source it came from. The acceptance rule for
// B6 is that this list has no entry whose grounding is absent.
export function planProvenance(plan: FillPlan): {
  label: string;
  field: string;
  grounding: FillGrounding;
  factId?: string | undefined;
  chain: string[];
}[] {
  return plan.fills.map((fill) => ({
    label: fill.label,
    field: fill.field,
    grounding: fill.grounding,
    ...(fill.factId === undefined ? {} : { factId: fill.factId }),
    chain: fill.provenance?.chain ?? [],
  }));
}

export function isFullyGrounded(plan: FillPlan): boolean {
  return plan.fills.every(
    (fill) =>
      (fill.grounding === "decline" && fill.factId === undefined) ||
      (fill.factId !== undefined && fill.provenance?.grounded === true),
  );
}

export function observedLabels(elements: readonly BrowserElement[]): string[] {
  return elements.map(observedLabel);
}
