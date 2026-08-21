import type {
  ApplicantFact,
  ApplicantPolicy,
  DemographicBehavior,
} from "../contracts/applicant.ts";
import type { BrowserElementOption } from "../contracts/observation.ts";
import type { FactLookup } from "./facts.ts";
import { canonicalField, isDemographicField, normalizeFieldName } from "./fields.ts";

// Canonical field key → the ApplicantPolicy slot that may answer it. A consequential
// field has exactly one authorized answer: the one the user put in their policy.
const POLICY_SLOTS = {
  work_authorization: "workAuthorizationFactId",
  sponsorship: "sponsorshipFactId",
  relocation: "relocationFactId",
  desired_salary: "compensationFactId",
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

function demographicAnswer(
  policy: ApplicantPolicy,
  facts: FactLookup,
  field: string,
): ApplicantFact | undefined {
  for (const id of policy.demographicAnswerFactIds ?? []) {
    const fact = facts.get(id);
    if (fact !== undefined && matchesField(fact, field)) return fact;
  }
  return undefined;
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
export function resolvePolicy(
  policy: ApplicantPolicy,
  facts: FactLookup,
  request: PolicyRequest,
): PolicyDecision {
  if (isConsequentialField(request.field)) {
    const id = policy[POLICY_SLOTS[request.field]];
    const fact = id === undefined ? undefined : facts.get(id);
    if (fact === undefined) {
      return {
        kind: "ask",
        reason: `${request.label} has no policy answer and is never inferred`,
      };
    }
    return { kind: "answer", fact, reason: `answered by your ${request.field} policy` };
  }

  if (isDemographicField(request.field)) {
    const explicit = demographicAnswer(policy, facts, request.field);
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
