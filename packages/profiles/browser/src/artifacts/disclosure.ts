import {
  type DisclosureRecord,
  disclosedFactIds,
  disclosureRecordSchema,
  disclosuresForOrigin,
} from "../contracts/disclosure.ts";
import { normalizeOrigin } from "../contracts/primitives.ts";
import { partitionFieldNames } from "./redaction.ts";

export const DISCLOSURE_LIMITS = {
  maxRecords: 1_000,
  maxFieldsPerRecord: 200,
  maxFactIdsPerRecord: 200,
} as const;

export interface DisclosureInput {
  id?: string | undefined;
  url: string;
  factIds: readonly string[];
  fieldNames: readonly string[];
  permissionRequestId?: string | undefined;
  timestamp?: number | undefined;
}

export type DisclosureResult =
  | { ok: true; record: DisclosureRecord; omittedFields: string[] }
  | { ok: false; reason: "invalid-origin" | "no-facts" | "invalid-record"; message: string };

export interface DisclosureLedgerOptions {
  now?: (() => number) | undefined;
  maxRecords?: number | undefined;
}

// The ledger answers "which facts reached which origin". It holds ids and field
// names only — there is no field here a value could be written into.
export class DisclosureLedger {
  private readonly entries: DisclosureRecord[] = [];
  private readonly now: () => number;
  private readonly maxRecords: number;
  private counter = 0;
  private dropped = 0;

  constructor(options: DisclosureLedgerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? DISCLOSURE_LIMITS.maxRecords;
  }

  get size(): number {
    return this.entries.length;
  }

  // Non-zero when BD22's bound forced the oldest records out, so a caller can say so
  // rather than presenting a truncated ledger as complete.
  get droppedRecords(): number {
    return this.dropped;
  }

  record(input: DisclosureInput): DisclosureResult {
    const origin = normalizeOrigin(input.url);
    if (origin === undefined) {
      return {
        ok: false,
        reason: "invalid-origin",
        message: "a disclosure is made to an http(s) origin",
      };
    }
    const factIds = [...new Set(input.factIds)].slice(0, DISCLOSURE_LIMITS.maxFactIdsPerRecord);
    if (factIds.length === 0) {
      return { ok: false, reason: "no-facts", message: "a disclosure records at least one fact" };
    }
    const { recordable, omitted } = partitionFieldNames([...new Set(input.fieldNames)]);
    const candidate: DisclosureRecord = {
      id: input.id ?? `disc-${(++this.counter).toString(36)}`,
      origin,
      url: input.url,
      factIds,
      fieldNames: recordable.slice(0, DISCLOSURE_LIMITS.maxFieldsPerRecord),
      timestamp: input.timestamp ?? this.now(),
      ...(input.permissionRequestId === undefined
        ? {}
        : { permissionRequestId: input.permissionRequestId }),
    };
    const parsed = disclosureRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "invalid-record",
        message: parsed.error.issues[0]?.message ?? "invalid disclosure",
      };
    }
    this.entries.push(candidate);
    while (this.entries.length > this.maxRecords) {
      this.entries.shift();
      this.dropped += 1;
    }
    return { ok: true, record: candidate, omittedFields: omitted };
  }

  records(): DisclosureRecord[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  forOrigin(origin: string): DisclosureRecord[] {
    return disclosuresForOrigin(this.entries, origin).map((entry) => ({ ...entry }));
  }

  factIdsForOrigin(origin: string): string[] {
    return disclosedFactIds(this.forOrigin(origin));
  }

  fieldNamesForOrigin(origin: string): string[] {
    return [...new Set(this.forOrigin(origin).flatMap((entry) => entry.fieldNames))];
  }
}
