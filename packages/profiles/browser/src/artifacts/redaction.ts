import type { ApplicantFact, Sensitivity } from "../contracts/applicant.ts";
import { isCredentialLabel, isRestrictedField } from "../contracts/redaction.ts";
import { REDACTED } from "../contracts/secret.ts";

export interface RedactableValue {
  value: string;
  sensitivity: Sensitivity;
}

// SECURITY.md §11: these never reach a receipt, ledger, log or event, whoever
// assembled the string they are hiding in.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|authorization|cookie|set-cookie|session[_-]?id)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
  /\bdata:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,
  // Full payment data. A 13-19 digit run is a card number far more often than it is
  // anything a receipt needs to quote verbatim.
  /\b(?:\d[ -]?){13,19}\b/g,
];

// Below this length a "value" is a word like "NY" and scrubbing it would shred
// unrelated text without hiding anything.
const MIN_SCRUBBABLE_LENGTH = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(text: string, values: readonly string[] = []): string {
  let result = text;
  for (const value of values) {
    if (value.length < MIN_SCRUBBABLE_LENGTH) continue;
    result = result.replace(new RegExp(escapeRegExp(value), "gi"), REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

export function containsAnyValue(text: string, values: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return values.some(
    (value) => value.length >= MIN_SCRUBBABLE_LENGTH && haystack.includes(value.toLowerCase()),
  );
}

// Sensitivity decides where a value may surface: restricted and sensitive values
// stay redacted everywhere, so they are collected once and scrubbed everywhere.
export function collectRedactableValues(
  facts: readonly ApplicantFact[] = [],
  extra: readonly RedactableValue[] = [],
): string[] {
  const values = new Set<string>();
  for (const fact of facts) {
    if (fact.sensitivity !== "sensitive") continue;
    if (typeof fact.value === "string") values.add(fact.value);
  }
  for (const item of extra) {
    if (item.sensitivity === "sensitive" || item.sensitivity === "restricted") {
      values.add(item.value);
    }
  }
  return [...values];
}

// A field name is safe to record; a credential-shaped one is not, because its
// presence alone says the agent touched a takeover boundary it never should have.
export function isRecordableFieldName(name: string): boolean {
  return !isCredentialLabel(name);
}

export function partitionFieldNames(names: readonly string[]): {
  recordable: string[];
  omitted: string[];
} {
  const recordable: string[] = [];
  const omitted: string[] = [];
  for (const name of names) {
    if (isRecordableFieldName(name)) recordable.push(name);
    else omitted.push(name);
  }
  return { recordable, omitted };
}

export function isRestrictedFieldName(name: string): boolean {
  return isRestrictedField(name);
}
