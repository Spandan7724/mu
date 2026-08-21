import { factAllowsOrigin, redactFactValue } from "../contracts/applicant.ts";
import type { BrowserCarryoverField } from "../contracts/carryover.ts";
import {
  type DisclosureRecord,
  disclosureRecordSchema,
  disclosuresForOrigin,
} from "../contracts/disclosure.ts";
import type { JsonValue } from "../contracts/json.ts";
import { normalizeOrigin } from "../contracts/primitives.ts";
import { isCredentialLabel, isRestrictedField } from "../contracts/redaction.ts";
import type { FactLookup } from "./facts.ts";
import { isUnsolicitedPersonalField } from "./fields.ts";

export interface DisclosureFill {
  factId: string;
  fieldName: string;
}

export interface DisclosureInput {
  origin: string;
  url: string;
  fills: readonly DisclosureFill[];
  permissionRequestId?: string | undefined;
  timestamp?: number | undefined;
}

export type DisclosureRefusal =
  | "empty"
  | "bad-origin"
  | "cross-origin-url"
  | "unknown-fact"
  | "origin-not-allowed"
  | "forbidden-field"
  | "invalid";

export type DisclosureResult =
  | { ok: true; record: DisclosureRecord }
  | { ok: false; reason: DisclosureRefusal; detail: string };

export interface DisclosureView {
  origin: string;
  url: string;
  timestamp: number;
  entries: { fieldName: string; factId: string; value: JsonValue }[];
}

export class DisclosureLedger {
  readonly #records: DisclosureRecord[] = [];
  readonly #facts: FactLookup;
  readonly #now: () => number;
  #sequence = 0;

  constructor(facts: FactLookup, now: () => number = Date.now) {
    this.#facts = facts;
    this.#now = now;
  }

  /**
   * Appends what actually went to a page. Every guard here is a disclosure boundary, not a
   * data-quality check: an origin-scoped fact reaching the wrong origin, or a credential-
   * shaped field name, is refused rather than recorded.
   */
  record(input: DisclosureInput): DisclosureResult {
    if (input.fills.length === 0) {
      return { ok: false, reason: "empty", detail: "a disclosure record needs at least one fact" };
    }
    const origin = normalizeOrigin(input.origin);
    if (origin === undefined || origin !== input.origin) {
      return {
        ok: false,
        reason: "bad-origin",
        detail: `${input.origin} is not a normalized origin`,
      };
    }
    if (normalizeOrigin(input.url) !== origin) {
      return { ok: false, reason: "cross-origin-url", detail: `${input.url} is not on ${origin}` };
    }
    for (const fill of input.fills) {
      const fact = this.#facts.get(fill.factId);
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
    this.#sequence += 1;
    const record: DisclosureRecord = {
      id: `disclosure-${this.#sequence}`,
      origin,
      url: input.url,
      factIds: [...new Set(input.fills.map((fill) => fill.factId))],
      fieldNames: [...new Set(input.fills.map((fill) => fill.fieldName))],
      timestamp: input.timestamp ?? this.#now(),
      ...(input.permissionRequestId === undefined
        ? {}
        : { permissionRequestId: input.permissionRequestId }),
    };
    const parsed = disclosureRecordSchema.safeParse(record);
    if (!parsed.success) {
      return { ok: false, reason: "invalid", detail: parsed.error.issues[0]?.message ?? "invalid" };
    }
    this.#records.push(record);
    return { ok: true, record };
  }

  records(): DisclosureRecord[] {
    return [...this.#records];
  }

  forOrigin(origin: string): DisclosureRecord[] {
    return disclosuresForOrigin(this.#records, origin);
  }

  factIds(): string[] {
    return [...new Set(this.#records.flatMap((record) => record.factIds))];
  }

  fieldNames(): string[] {
    return [...new Set(this.#records.flatMap((record) => record.fieldNames))];
  }

  // What a transcript, preview or receipt may show. Sensitive values are withheld by
  // redactFactValue; restricted ones cannot exist on a fact in the first place.
  views(): DisclosureView[] {
    return this.#records.map((record) => ({
      origin: record.origin,
      url: record.url,
      timestamp: record.timestamp,
      entries: record.factIds.map((factId, index) => {
        const fact = this.#facts.get(factId);
        return {
          factId,
          fieldName: record.fieldNames[index] ?? factId,
          value: fact === undefined ? "[unknown fact]" : redactFactValue(fact),
        };
      }),
    }));
  }

  // Carryover shape: labels, fact ids and origins only, no values.
  carryoverFields(): BrowserCarryoverField[] {
    const fields: BrowserCarryoverField[] = [];
    for (const record of this.#records) {
      record.factIds.forEach((factId, index) => {
        fields.push({
          label: record.fieldNames[index] ?? factId,
          factId,
          origin: record.origin,
        });
      });
    }
    return fields;
  }
}

export function createDisclosureLedger(
  facts: FactLookup,
  now: () => number = Date.now,
): DisclosureLedger {
  return new DisclosureLedger(facts, now);
}
