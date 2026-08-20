import { z } from "zod";
import {
  identifierSchema,
  observedUrlSchema,
  originSchema,
  timestampSchema,
} from "./primitives.ts";

// The ledger records which facts reached which origin — ids and field names only.
// There is no field here that could hold a disclosed value.
export interface DisclosureRecord {
  id: string;
  origin: string;
  url: string;
  factIds: string[];
  fieldNames: string[];
  timestamp: number;
  permissionRequestId?: string | undefined;
}

export const disclosureRecordSchema = z.strictObject({
  id: identifierSchema,
  origin: originSchema,
  url: observedUrlSchema,
  factIds: z.array(identifierSchema).min(1).max(1_000),
  fieldNames: z.array(z.string().min(1).max(256)).max(1_000),
  timestamp: timestampSchema,
  permissionRequestId: identifierSchema.optional(),
});

export function disclosedFactIds(records: readonly DisclosureRecord[]): string[] {
  return [...new Set(records.flatMap((record) => record.factIds))];
}

export function disclosuresForOrigin(
  records: readonly DisclosureRecord[],
  origin: string,
): DisclosureRecord[] {
  return records.filter((record) => record.origin === origin);
}
