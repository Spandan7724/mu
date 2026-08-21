import type { ApplicantFact } from "../contracts/applicant.ts";
import type { DisclosureRecord } from "../contracts/disclosure.ts";
import type { AuthorizedDocumentSummary } from "../contracts/documents.ts";
import type { SubmitIntent } from "../contracts/intent.ts";
import { assertJsonSerializable, BROWSER_LIMITS } from "../contracts/json.ts";
import { normalizeOrigin } from "../contracts/primitives.ts";
import {
  type BrowserReceipt,
  type BrowserReceiptEntry,
  browserReceiptSchema,
  receiptEntry,
} from "../contracts/receipt.ts";
import { type CommitStatus, commitReceiptStatus } from "./outcome.ts";
import {
  collectRedactableValues,
  containsAnyValue,
  partitionFieldNames,
  type RedactableValue,
  redactText,
} from "./redaction.ts";

export const RECEIPT_LIMITS = {
  maxDisclosedFields: 1_000,
  maxDisclosedFactIds: 1_000,
  maxUploads: 100,
} as const;

export interface ReceiptDraft {
  id: string;
  sessionId: string;
  taskId?: string | undefined;
  intent: SubmitIntent;
  status: CommitStatus;
  startedUrl: string;
  finalUrl: string;
  completedAt?: number | Date | string | undefined;
  confirmationText?: string | undefined;
  externalId?: string | undefined;
  disclosures?: readonly DisclosureRecord[] | undefined;
  uploads?: readonly AuthorizedDocumentSummary[] | undefined;
  facts?: readonly ApplicantFact[] | undefined;
  redactValues?: readonly RedactableValue[] | undefined;
  screenshotPath?: string | undefined;
}

export interface ReceiptBuildResult {
  receipt: BrowserReceipt;
  entry: BrowserReceiptEntry;
  omittedFields: string[];
}

export class ReceiptBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptBuildError";
  }
}

function completedAtIso(value: ReceiptDraft["completedAt"]): string {
  if (value === undefined) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return new Date(value).toISOString();
}

// artifactRelativePathSchema accepts "data:image/png;base64,…" — it has no leading
// slash, no "..", no drive letter — so a raw screenshot could otherwise ride into a
// receipt through screenshotPath. A receipt references a file; it never carries one.
function assertArtifactReference(path: string): void {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes("://")) {
    throw new ReceiptBuildError("a screenshot is referenced by artifact path, never inlined");
  }
}

export function buildReceipt(draft: ReceiptDraft): ReceiptBuildResult {
  const status = commitReceiptStatus(draft.status);
  if (status === undefined) {
    throw new ReceiptBuildError("a cancelled commitment produced no external effect to receipt");
  }
  const origin = normalizeOrigin(draft.finalUrl);
  if (origin === undefined) {
    throw new ReceiptBuildError("a receipt records the http(s) origin the commitment reached");
  }
  const redactable = collectRedactableValues(draft.facts, draft.redactValues);
  const relevant = (draft.disclosures ?? []).filter((record) => record.origin === origin);
  const { recordable, omitted } = partitionFieldNames([
    ...new Set(relevant.flatMap((record) => record.fieldNames)),
  ]);
  const factIds = [...new Set(relevant.flatMap((record) => record.factIds))];
  const confirmationText =
    draft.confirmationText === undefined
      ? undefined
      : redactText(draft.confirmationText, redactable).slice(0, BROWSER_LIMITS.maxSummaryChars);
  if (draft.screenshotPath !== undefined) assertArtifactReference(draft.screenshotPath);
  const receipt: BrowserReceipt = {
    version: 1,
    id: draft.id,
    sessionId: draft.sessionId,
    ...(draft.taskId === undefined ? {} : { taskId: draft.taskId }),
    status,
    intent: draft.intent,
    startedUrl: draft.startedUrl,
    finalUrl: draft.finalUrl,
    origin,
    completedAt: completedAtIso(draft.completedAt),
    ...(confirmationText === undefined || confirmationText.length === 0
      ? {}
      : { confirmationText }),
    // An external id is confirmation evidence; the contract refuses it beside any
    // other status, so an unproven outcome cannot borrow its authority.
    ...(status === "confirmed" && draft.externalId !== undefined
      ? { externalId: redactText(draft.externalId, redactable).slice(0, 256) }
      : {}),
    disclosedFactIds: factIds.slice(0, RECEIPT_LIMITS.maxDisclosedFactIds),
    disclosedFields: recordable.slice(0, RECEIPT_LIMITS.maxDisclosedFields),
    uploadedFiles: (draft.uploads ?? []).slice(0, RECEIPT_LIMITS.maxUploads).map((upload) => ({
      documentId: upload.id,
      basename: upload.basename,
      sha256: upload.sha256,
    })),
    ...(draft.screenshotPath === undefined ? {} : { screenshotPath: draft.screenshotPath }),
  };
  const parsed = browserReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    throw new ReceiptBuildError(parsed.error.issues[0]?.message ?? "invalid receipt");
  }
  assertJsonSerializable(receipt, "receipt");
  // Last line of defence: a receipt that still carries a redacted value is a defect,
  // and writing it would be the leak the redaction exists to prevent.
  if (containsAnyValue(JSON.stringify(receipt), redactable)) {
    throw new ReceiptBuildError("receipt still contains a value that must stay redacted");
  }
  return {
    receipt,
    entry: receiptEntry(receipt),
    omittedFields: omitted,
  };
}
