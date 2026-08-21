import type {
  ApplicantFact,
  ApplicantPolicy,
  DemographicBehavior,
} from "../contracts/applicant.ts";
import type { BrowserElementOption } from "../contracts/observation.ts";
import { canonicalField, isDemographicField, normalizeFieldName } from "./fields.ts";

// Canonical field key → the ApplicantPolicy slot that may answer it. A consequential
// field has exactly one authorized answer: the one the user put in their policy.
const POLICY_SLOTS = {
  work_authorization: "workAuthorization",
  sponsorship: "sponsorship",
  relocation: "relocation",
  desired_salary: "compensation",
} as const satisfies Record<string, keyof ApplicantPolicy>;

export type ConsequentialField = keyof typeof POLICY_SLOTS;

export const CONSEQUENTIAL_FIELDS = Object.keys(POLICY_SLOTS) as ConsequentialField[];

export function isConsequentialField(field: string): field is ConsequentialField {
  return field in POLICY_SLOTS;
}

const DECLINE_PATTERN =
  /\b(?:decline|prefer not|do not wish|don'?t wish|choose not|rather not|not disclose|no answer)\b/i;

export function declineOption(
  options: readonly BrowserElementOption[] | undefined,
): BrowserElementOption | undefined {
  return options?.find((option) => DECLINE_PATTERN.test(option.label));
}

export interface PolicyRequest {
  field: string;
  label: string;
  required: boolean;
  options?: readonly BrowserElementOption[] | undefined;
}

export type PolicyDecision =
  | { kind: "answer"; fact: ApplicantFact; reason: string }
  | { kind: "decline"; value: string; label: string; reason: string }
  | { kind: "omit"; reason: string }
  | { kind: "ask"; reason: string };

export function isPolicyGoverned(field: string): boolean {
  return isConsequentialField(field) || isDemographicField(field);
}

function matchesField(fact: ApplicantFact, field: string): boolean {
  const normalized = normalizeFieldName(fact.field);
  if (normalized === normalizeFieldName(field)) return true;
  return canonicalField(fact.field)?.key === field;
}

function demographicAnswer(policy: ApplicantPolicy, field: string): ApplicantFact | undefined {
  return policy.demographicAnswers?.find((fact) => matchesField(fact, field));
}

function declineOrFallBack(request: PolicyRequest, why: string): PolicyDecision {
  const option = declineOption(request.options);
  if (option !== undefined) {
    return {
      kind: "decline",
      value: option.value ?? option.label,
      label: option.label,
      reason: `${why}, and the page offers "${option.label}"`,
    };
  }
  if (!request.required) {
    return { kind: "omit", reason: `${why}, and the question is optional` };
  }
  return { kind: "ask", reason: `${why}, but the page requires an answer and offers no decline` };
}

/**
 * The answer for a consequential or voluntary field, or a decision to ask. There is no
 * branch that produces a value the user did not supply: a missing policy always becomes a
 * question, never a plausible default.
 */
export function resolvePolicy(policy: ApplicantPolicy, request: PolicyRequest): PolicyDecision {
  if (isConsequentialField(request.field)) {
    const fact = policy[POLICY_SLOTS[request.field]];
    if (fact === undefined) {
      return {
        kind: "ask",
        reason: `${request.label} has no policy answer and is never inferred`,
      };
    }
    return { kind: "answer", fact, reason: `answered by your ${request.field} policy` };
  }

  if (isDemographicField(request.field)) {
    const explicit = demographicAnswer(policy, request.field);
    if (explicit !== undefined) {
      return { kind: "answer", fact: explicit, reason: "you set an explicit demographic answer" };
    }
    const behavior: DemographicBehavior | undefined = policy.defaultDemographicBehavior;
    switch (behavior) {
      case "decline":
        return declineOrFallBack(request, "your policy declines demographic questions");
      case "omit-when-optional":
        return request.required
          ? {
              kind: "ask",
              reason: "your policy omits optional demographics, but this one is required",
            }
          : { kind: "omit", reason: "your policy omits optional demographic questions" };
      default:
        return {
          kind: "ask",
          reason: "voluntary demographic answers require an explicit instruction",
        };
    }
  }

  return { kind: "ask", reason: `${request.label} is not governed by an applicant policy` };
}
