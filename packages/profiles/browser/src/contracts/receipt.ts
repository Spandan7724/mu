import { z } from "zod";
import { type SubmitIntent, submitIntentSchema } from "./intent.ts";
import { BROWSER_LIMITS } from "./json.ts";
import {
  type AuthorizedDocumentId,
  artifactRelativePathSchema,
  authorizedDocumentIdSchema,
  basenameSchema,
  identifierSchema,
  normalizeOrigin,
  observedUrlSchema,
  originSchema,
  sha256Schema,
} from "./primitives.ts";

export interface ReceiptCandidate {
  kind: SubmitIntent;
  url: string;
  title: string;
  confirmationText?: string | undefined;
  externalId?: string | undefined;
}

export const receiptCandidateSchema = z.strictObject({
  kind: submitIntentSchema,
  url: observedUrlSchema,
  title: z.string().max(BROWSER_LIMITS.maxElementTextChars),
  confirmationText: z.string().max(BROWSER_LIMITS.maxSummaryChars).optional(),
  externalId: z.string().max(256).optional(),
});

// BD17: confirmed / unknown / failed. There is deliberately no "rolled back".
export type ReceiptStatus = "confirmed" | "unknown" | "failed";

export const receiptStatusSchema = z.enum(["confirmed", "unknown", "failed"]);

export interface ReceiptUpload {
  documentId: AuthorizedDocumentId;
  basename: string;
  sha256: string;
}

export interface BrowserReceipt {
  version: 1;
  id: string;
  sessionId: string;
  taskId?: string | undefined;
  status: ReceiptStatus;
  intent: SubmitIntent;
  startedUrl: string;
  finalUrl: string;
  origin: string;
  completedAt: string;
  confirmationText?: string | undefined;
  externalId?: string | undefined;
  disclosedFactIds: string[];
  disclosedFields: string[];
  uploadedFiles: ReceiptUpload[];
  screenshotPath?: string | undefined;
}

export const browserReceiptSchema = z
  .strictObject({
    version: z.literal(1),
    id: identifierSchema,
    sessionId: identifierSchema,
    taskId: identifierSchema.optional(),
    status: receiptStatusSchema,
    intent: submitIntentSchema,
    startedUrl: observedUrlSchema,
    finalUrl: observedUrlSchema,
    origin: originSchema,
    completedAt: z.iso.datetime(),
    confirmationText: z.string().max(BROWSER_LIMITS.maxSummaryChars).optional(),
    externalId: z.string().max(256).optional(),
    // Ids and field names only: values stay in the session's redacted view.
    disclosedFactIds: z.array(identifierSchema).max(1_000),
    disclosedFields: z.array(z.string().min(1).max(256)).max(1_000),
    uploadedFiles: z
      .array(
        z.strictObject({
          documentId: authorizedDocumentIdSchema,
          basename: basenameSchema,
          sha256: sha256Schema,
        }),
      )
      .max(100),
    screenshotPath: artifactRelativePathSchema.optional(),
  })
  .superRefine((receipt, ctx) => {
    if (normalizeOrigin(receipt.finalUrl) !== receipt.origin) {
      ctx.addIssue({
        code: "custom",
        path: ["origin"],
        message: "origin must be the normalized origin of finalUrl",
      });
    }
    if (receipt.status !== "confirmed" && receipt.externalId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["externalId"],
        message: "an external id is evidence of confirmation and cannot accompany another status",
      });
    }
  });

// The only projection of a receipt that may enter a session entry.
export interface BrowserReceiptEntry {
  receiptId: string;
  status: ReceiptStatus;
  intent: SubmitIntent;
  finalUrl: string;
  artifactPath?: string | undefined;
}

export const browserReceiptEntrySchema = z.strictObject({
  receiptId: identifierSchema,
  status: receiptStatusSchema,
  intent: submitIntentSchema,
  finalUrl: observedUrlSchema,
  artifactPath: artifactRelativePathSchema.optional(),
});

export function receiptEntry(receipt: BrowserReceipt, artifactPath?: string): BrowserReceiptEntry {
  return {
    receiptId: receipt.id,
    status: receipt.status,
    intent: receipt.intent,
    finalUrl: receipt.finalUrl,
    ...(artifactPath === undefined ? {} : { artifactPath }),
  };
}
