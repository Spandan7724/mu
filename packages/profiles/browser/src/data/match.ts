import type { ApplicantFact } from "../contracts/applicant.ts";
import {
  type BrowserElement,
  type BrowserElementRef,
  elementRefOf,
  isCredentialElement,
} from "../contracts/observation.ts";
import { isRestrictedField } from "../contracts/redaction.ts";
import type { FactLookup } from "./facts.ts";
import {
  CANONICAL_FIELDS,
  type CanonicalField,
  canonicalFieldByAlias,
  fieldTokens,
  isUnsolicitedPersonalField,
  normalizeFieldName,
} from "./fields.ts";

// A fill only happens at or above this score. Everything below becomes a question, so the
// threshold is the line between "grounded" and "guessed".
export const MATCH_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Input types that say nothing about which field a control is. A dropdown is a
 * presentation choice — country, city, notice period and work authorization are all
 * routinely rendered as one — so penalising a field for being a select made every such
 * control unrecognizable, and no application form with a country dropdown could be
 * filled at all. A genuine contradiction, like a date input labelled "Email", still
 * costs the match half its score.
 */
const NEUTRAL_INPUT_TYPES = new Set(["text", "search", "select-one", "select-multiple"]);

// Anything closer than this to the leader is not a second choice, it is an ambiguity.
const AMBIGUITY_MARGIN = 0.05;

type NameSource = "name" | "label" | "placeholder" | "description";

// How much a page's own naming is worth. A placeholder is deliberately weighted below the
// threshold on its own: placeholder text is decoration that happens to be readable, and the
// fixture uses a placeholder-only control precisely to see whether that is enough to fill.
const SOURCE_WEIGHT: Record<NameSource, number> = {
  name: 1,
  label: 1,
  placeholder: 0.62,
  description: 0.75,
};

const SOURCE_PHRASE: Record<NameSource, string> = {
  name: "accessible name",
  label: "label",
  placeholder: "placeholder",
  description: "description",
};

export type MatchRefusal = "credential" | "restricted" | "solicitation" | "hidden" | "not-editable";

export type MatchStatus =
  | "matched"
  | "ambiguous"
  | "unnamed"
  | "unrecognized"
  | "no-fact"
  | "refused";

export interface FieldMatch {
  ref: BrowserElementRef;
  label: string;
  status: MatchStatus;
  field?: string | undefined;
  fact?: ApplicantFact | undefined;
  confidence: number;
  reason: string;
  evidence: string[];
  refusal?: MatchRefusal | undefined;
  required: boolean;
}

interface Scored {
  field: CanonicalField;
  score: number;
  evidence: string[];
}

function bestName(element: BrowserElement): { text: string; source: NameSource } | undefined {
  const candidates: [NameSource, string | undefined][] = [
    ["label", element.label],
    ["name", element.name],
    ["description", element.description],
    ["placeholder", element.placeholder],
  ];
  for (const [source, text] of candidates) {
    if (text !== undefined && normalizeFieldName(text).length > 0) return { text, source };
  }
  return undefined;
}

// The observed label as a person would read it, used in questions and the ledger.
export function observedLabel(element: BrowserElement): string {
  return bestName(element)?.text ?? element.ref;
}

function scoreAgainst(
  field: CanonicalField,
  text: string,
  source: NameSource,
  element: BrowserElement,
): Scored | undefined {
  const normalized = normalizeFieldName(text);
  const tokens = new Set(fieldTokens(text));
  const evidence: string[] = [];
  let base = 0;
  for (const alias of [field.key, ...field.aliases]) {
    const aliasNormalized = normalizeFieldName(alias);
    if (aliasNormalized === normalized) {
      base = 1;
      evidence.push(`${SOURCE_PHRASE[source]} "${text}" is exactly "${alias}"`);
      break;
    }
    const aliasTokens = fieldTokens(alias);
    if (aliasTokens.length > 0 && aliasTokens.every((token) => tokens.has(token))) {
      const coverage = aliasTokens.length / Math.max(tokens.size, aliasTokens.length);
      const score = 0.7 + 0.15 * coverage;
      if (score > base) {
        base = score;
        evidence.length = 0;
        evidence.push(`${SOURCE_PHRASE[source]} "${text}" contains "${alias}"`);
      }
    }
  }
  if (base === 0) return undefined;

  let score = base * SOURCE_WEIGHT[source];
  if (source === "placeholder") {
    evidence.push("a placeholder is not an accessible name, so this cannot stand alone");
  }
  const inputType = element.inputType;
  if (inputType !== undefined && field.inputTypes.length > 0) {
    if (field.inputTypes.includes(inputType)) {
      score = Math.min(1, score + 0.1);
      evidence.push(`input type "${inputType}" agrees`);
    } else if (!NEUTRAL_INPUT_TYPES.has(inputType)) {
      score *= 0.5;
      evidence.push(`input type "${inputType}" contradicts this field`);
    }
  }
  return { field, score, evidence };
}

function refuse(
  element: BrowserElement,
  refusal: MatchRefusal,
  reason: string,
  label: string,
): FieldMatch {
  return {
    ref: elementRefOf(element),
    label,
    status: "refused",
    confidence: 0,
    reason,
    evidence: [],
    refusal,
    required: element.required === true,
  };
}

export function matchElement(element: BrowserElement, facts: FactLookup): FieldMatch {
  const named = bestName(element);
  const label = named?.text ?? element.ref;

  // BD14: a credential-shaped control is a takeover boundary before it is a form field.
  if (isCredentialElement(element)) {
    return refuse(element, "credential", "credential fields are handled by human takeover", label);
  }
  // A hidden input is not something the user can see, verify or consent to.
  if (element.inputType === "hidden") {
    return refuse(element, "hidden", "a hidden input is never filled from applicant data", label);
  }
  const solicitation = [element.label, element.name, element.placeholder, element.description]
    .filter((text): text is string => text !== undefined)
    .find((text) => isRestrictedField(text) || isUnsolicitedPersonalField(text));
  if (solicitation !== undefined) {
    return refuse(
      element,
      isRestrictedField(solicitation) ? "restricted" : "solicitation",
      `"${solicitation}" asks for data this product never supplies to a page`,
      label,
    );
  }
  if (element.disabled === true || element.readonly === true) {
    return refuse(element, "not-editable", "the control is disabled or read-only", label);
  }

  const ref = elementRefOf(element);
  const required = element.required === true;
  if (named === undefined) {
    return {
      ref,
      label,
      status: "unnamed",
      confidence: 0,
      reason: "the page gives this control no label, name, placeholder or description",
      evidence: [],
      required,
    };
  }

  const scored: Scored[] = [];
  for (const field of CANONICAL_FIELDS) {
    const result = scoreAgainst(field, named.text, named.source, element);
    if (result !== undefined) scored.push(result);
  }
  scored.sort((a, b) => b.score - a.score);
  const leader = scored[0];
  if (leader === undefined) {
    return {
      ref,
      label,
      status: "unrecognized",
      confidence: 0,
      reason: `"${named.text}" does not name any fact this profile holds`,
      evidence: [],
      required,
    };
  }
  const runnerUp = scored[1];
  if (runnerUp !== undefined && leader.score - runnerUp.score <= AMBIGUITY_MARGIN) {
    return {
      ref,
      label,
      status: "ambiguous",
      confidence: Math.min(leader.score, MATCH_CONFIDENCE_THRESHOLD - 0.01),
      reason: `"${named.text}" reads as both ${leader.field.label} and ${runnerUp.field.label}`,
      evidence: [...leader.evidence, ...runnerUp.evidence],
      required,
    };
  }
  if (leader.score < MATCH_CONFIDENCE_THRESHOLD) {
    return {
      ref,
      label,
      status: "unrecognized",
      field: leader.field.key,
      confidence: leader.score,
      reason: `"${named.text}" only weakly suggests ${leader.field.label}`,
      evidence: leader.evidence,
      required,
    };
  }
  const fact = facts.factFor(leader.field.key);
  if (fact === undefined) {
    return {
      ref,
      label,
      status: "no-fact",
      field: leader.field.key,
      confidence: leader.score,
      reason: `${leader.field.label} is not in your resume, saved profile or answers`,
      evidence: leader.evidence,
      required,
    };
  }
  return {
    ref,
    label,
    status: "matched",
    field: leader.field.key,
    fact,
    confidence: leader.score,
    reason: `${leader.field.label} — ${leader.evidence[0] ?? "named by the page"}`,
    evidence: leader.evidence,
    required,
  };
}

/**
 * Matching across a whole observation. Per-element scoring cannot see that two controls
 * carry the same label, so duplicate winners are demoted here: when a page labels two
 * inputs "Reference", the label has stopped identifying anything and both become questions.
 */
export function matchElements(
  elements: readonly BrowserElement[],
  facts: FactLookup,
): FieldMatch[] {
  const matches = elements.map((element) => matchElement(element, facts));
  const counts = new Map<string, number>();
  for (const match of matches) {
    if (match.status !== "matched" || match.field === undefined) continue;
    counts.set(match.field, (counts.get(match.field) ?? 0) + 1);
  }
  return matches.map((match) => {
    if (match.status !== "matched" || match.field === undefined) return match;
    if ((counts.get(match.field) ?? 0) < 2) return match;
    return {
      ...match,
      status: "ambiguous",
      fact: undefined,
      confidence: Math.min(match.confidence, MATCH_CONFIDENCE_THRESHOLD - 0.01),
      reason: `more than one control on this page is named "${match.label}"`,
      evidence: [...match.evidence, "duplicate labels cannot identify which value goes where"],
    };
  });
}

export function isFillable(match: FieldMatch): boolean {
  return (
    match.status === "matched" &&
    match.fact !== undefined &&
    match.confidence >= MATCH_CONFIDENCE_THRESHOLD
  );
}

export function fieldForLabel(label: string): string | undefined {
  return canonicalFieldByAlias(label)?.key;
}
