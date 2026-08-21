import type { DisclosureLedger, DisclosureInput as LedgerInput } from "../artifacts/disclosure.ts";
import { factAllowsOrigin, redactFactValue } from "../contracts/applicant.ts";
import type { BrowserCarryoverField } from "../contracts/carryover.ts";
import type { DisclosureRecord } from "../contracts/disclosure.ts";
import type { JsonValue } from "../contracts/json.ts";
import { normalizeOrigin } from "../contracts/primitives.ts";
import { isCredentialLabel, isRestrictedField } from "../contracts/redaction.ts";
import type { FactLookup } from "./facts.ts";
import { isUnsolicitedPersonalField } from "./fields.ts";
import type { FillPlan } from "./plan.ts";

/**
 * The fact side of the disclosure ledger. `artifacts/disclosure.ts` owns the ledger itself
 * — appending, bounding, and dropping credential-shaped field names — and knows nothing
 * about facts. This module supplies what only the data layer can decide: that a fact id is
 * real, that the fact's own origin scope permits this destination, and that the field name
 * is one this product fills at all. Nothing here appends; it authorizes and then delegates.
 */

export interface DisclosureFill {
  factId: string;
  fieldName: string;
}

export interface FactDisclosureInput {
  url: string;
  fills: readonly DisclosureFill[];
  permissionRequestId?: string | undefined;
  timestamp?: number | undefined;
}

export type DisclosureRefusal =
  | "empty"
  | "bad-url"
  | "unknown-fact"
  | "origin-not-allowed"
  | "forbidden-field";

export type DisclosureAuthorization =
  | { ok: true; input: LedgerInput; origin: string }
  | { ok: false; reason: DisclosureRefusal; detail: string };

export function authorizeDisclosure(
  facts: FactLookup,
  input: FactDisclosureInput,
): DisclosureAuthorization {
  if (input.fills.length === 0) {
    return { ok: false, reason: "empty", detail: "a disclosure records at least one fact" };
  }
  const origin = normalizeOrigin(input.url);
  if (origin === undefined) {
    return { ok: false, reason: "bad-url", detail: `${input.url} is not an http(s) URL` };
  }
  for (const fill of input.fills) {
    const fact = facts.get(fill.factId);
    if (fact === undefined) {
      return { ok: false, reason: "unknown-fact", detail: `${fill.factId} is not a stored fact` };
    }
    if (!factAllowsOrigin(fact, origin)) {
      return {
        ok: false,
        reason: "origin-not-allowed",
        detail: `${fill.factId} is scoped away from ${origin}`,
      };
    }
    if (
      isCredentialLabel(fill.fieldName) ||
      isRestrictedField(fill.fieldName) ||
      isUnsolicitedPersonalField(fill.fieldName)
    ) {
      return {
        ok: false,
        reason: "forbidden-field",
        detail: `${fill.fieldName} is not a field this product fills`,
      };
    }
  }
  return {
    ok: true,
    origin,
    input: {
      url: input.url,
      factIds: input.fills.map((fill) => fill.factId),
      fieldNames: input.fills.map((fill) => fill.fieldName),
      ...(input.permissionRequestId === undefined
        ? {}
        : { permissionRequestId: input.permissionRequestId }),
      ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
    },
  };
}

export type FactDisclosureResult =
  | { ok: true; record: DisclosureRecord; omittedFields: string[] }
  | { ok: false; reason: DisclosureRefusal | "rejected"; detail: string };

export function recordFactDisclosure(
  ledger: DisclosureLedger,
  facts: FactLookup,
  input: FactDisclosureInput,
): FactDisclosureResult {
  const authorized = authorizeDisclosure(facts, input);
  if (!authorized.ok) return authorized;
  const result = ledger.record(authorized.input);
  if (!result.ok) return { ok: false, reason: "rejected", detail: result.message };
  return { ok: true, record: result.record, omittedFields: result.omittedFields };
}

export function fillsFromPlan(plan: FillPlan): DisclosureFill[] {
  const fills: DisclosureFill[] = [];
  for (const fill of plan.fills) {
    if (fill.factId === undefined) continue;
    fills.push({ factId: fill.factId, fieldName: fill.label });
  }
  return fills;
}

export function recordPlanDisclosure(
  ledger: DisclosureLedger,
  facts: FactLookup,
  plan: FillPlan,
  permissionRequestId?: string,
): FactDisclosureResult {
  return recordFactDisclosure(ledger, facts, {
    url: plan.url,
    fills: fillsFromPlan(plan),
    ...(permissionRequestId === undefined ? {} : { permissionRequestId }),
  });
}

export interface DisclosureView {
  origin: string;
  url: string;
  timestamp: number;
  fieldNames: string[];
  values: { factId: string; field: string; value: JsonValue }[];
}

// What a transcript, preview or receipt may show. redactFactValue withholds sensitive
// values; restricted ones cannot exist on an ApplicantFact in the first place.
export function disclosureViews(
  records: readonly DisclosureRecord[],
  facts: FactLookup,
): DisclosureView[] {
  return records.map((record) => ({
    origin: record.origin,
    url: record.url,
    timestamp: record.timestamp,
    fieldNames: [...record.fieldNames],
    values: record.factIds.map((factId) => {
      const fact = facts.get(factId);
      return fact === undefined
        ? { factId, field: "(unknown)", value: "[unknown fact]" as JsonValue }
        : { factId, field: fact.field, value: redactFactValue(fact) };
    }),
  }));
}

// Carryover pairs a label with the fact behind it, which the ledger record cannot do — it
// dedupes and filters both arrays independently — so the pairing comes from the plan.
export function planCarryoverFields(plan: FillPlan): BrowserCarryoverField[] {
  const origin = plan.origin;
  if (origin.length === 0) return [];
  return plan.fills.map((fill) => ({
    label: fill.label,
    origin,
    ...(fill.factId === undefined ? {} : { factId: fill.factId }),
  }));
}
