import { isAbsolute } from "node:path";
import { z } from "zod";
import { BROWSER_LIMITS } from "./json.ts";
import {
  type AuthorizedDocumentId,
  authorizedDocumentIdSchema,
  basenameSchema,
  sha256Schema,
  timestampSchema,
} from "./primitives.ts";

export type DocumentPurpose = "reference" | "upload";

export const documentPurposeSchema = z.enum(["reference", "upload"]);

export interface AuthorizedDocument {
  id: AuthorizedDocumentId;
  // Runtime-only. Never enters a receipt, session entry, event or model message —
  // documentSummary() is the projection everything else consumes.
  path: string;
  basename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  purposes: DocumentPurpose[];
  extractedText?: string | undefined;
  addedAt: number;
}

export const authorizedDocumentSchema = z
  .strictObject({
    id: authorizedDocumentIdSchema,
    path: z.string().min(1).refine(isAbsolute, "authorized documents are exact absolute paths"),
    basename: basenameSchema,
    mimeType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/, "must be a MIME type"),
    bytes: z.number().int().nonnegative(),
    sha256: sha256Schema,
    purposes: z.array(documentPurposeSchema).min(1).max(2),
    extractedText: z.string().max(BROWSER_LIMITS.maxSnapshotChars).optional(),
    addedAt: timestampSchema,
  })
  .superRefine((document, ctx) => {
    if (!document.path.endsWith(document.basename)) {
      ctx.addIssue({
        code: "custom",
        path: ["basename"],
        message: "basename must be the final component of path",
      });
    }
    if (new Set(document.purposes).size !== document.purposes.length) {
      ctx.addIssue({ code: "custom", path: ["purposes"], message: "duplicate purpose" });
    }
  });

// What the model, a permission preview and a receipt are allowed to see.
export interface AuthorizedDocumentSummary {
  id: AuthorizedDocumentId;
  basename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  purposes: DocumentPurpose[];
}

export const authorizedDocumentSummarySchema = z.strictObject({
  id: authorizedDocumentIdSchema,
  basename: basenameSchema,
  mimeType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: sha256Schema,
  purposes: z.array(documentPurposeSchema).min(1).max(2),
});

export function documentSummary(document: AuthorizedDocument): AuthorizedDocumentSummary {
  return {
    id: document.id,
    basename: document.basename,
    mimeType: document.mimeType,
    bytes: document.bytes,
    sha256: document.sha256,
    purposes: [...document.purposes],
  };
}

export function canUpload(document: AuthorizedDocument): boolean {
  return document.purposes.includes("upload");
}

export function findAuthorizedDocument(
  documents: readonly AuthorizedDocument[],
  id: string,
): AuthorizedDocument | undefined {
  return documents.find((document) => document.id === id);
}
