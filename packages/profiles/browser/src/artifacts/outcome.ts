import type { ActionOutcome } from "../contracts/actions.ts";
import { BROWSER_LIMITS } from "../contracts/json.ts";
import type { ReceiptStatus } from "../contracts/receipt.ts";

// SECURITY.md §10 plus DESIGN.md's cancelled. `completed` says the interaction
// occurred; only `confirmed` says the site agreed that it did.
export type CommitStatus = "confirmed" | "completed" | "unknown" | "failed" | "cancelled";

export type ConfirmationEvidence =
  | { kind: "navigation"; from: string; to: string }
  | { kind: "confirmation-text"; text: string }
  | { kind: "external-id"; value: string }
  | { kind: "form-disappeared"; label?: string | undefined }
  | { kind: "deterministic-response"; ok: boolean; detail?: string | undefined };

export type FailureEvidence =
  | { kind: "validation-error"; detail: string }
  | { kind: "error-text"; detail: string }
  | { kind: "rejected-response"; detail: string };

export type ConfirmationLossReason =
  | "disconnected"
  | "timeout"
  | "tab-closed"
  | "aborted"
  | "driver-uncertain";

export interface CommitEvidence {
  interactionOccurred: boolean;
  cancelled?: boolean | undefined;
  confirmation?: readonly ConfirmationEvidence[] | undefined;
  failure?: readonly FailureEvidence[] | undefined;
  lost?: ConfirmationLossReason | undefined;
}

export interface CommitClassification {
  status: CommitStatus;
  reason: string;
  confirmation: ConfirmationEvidence[];
  failure: FailureEvidence[];
  confirmationText?: string | undefined;
  externalId?: string | undefined;
}

// A page controls its own text, so text alone is not proof. An identifier the site
// minted, or a deterministic response, stands on its own; the weaker signals must
// corroborate each other.
const STRONG_KINDS = new Set<ConfirmationEvidence["kind"]>([
  "external-id",
  "deterministic-response",
]);

export function isSufficientConfirmation(evidence: readonly ConfirmationEvidence[]): boolean {
  const corroborating = new Set<ConfirmationEvidence["kind"]>();
  for (const item of evidence) {
    if (item.kind === "external-id" && item.value.length > 0) return true;
    if (item.kind === "deterministic-response") {
      if (item.ok) return true;
      continue;
    }
    if (!STRONG_KINDS.has(item.kind)) corroborating.add(item.kind);
  }
  return corroborating.size >= 2;
}

function firstExternalId(evidence: readonly ConfirmationEvidence[]): string | undefined {
  for (const item of evidence) {
    if (item.kind === "external-id" && item.value.length > 0) return item.value;
  }
  return undefined;
}

function firstConfirmationText(evidence: readonly ConfirmationEvidence[]): string | undefined {
  for (const item of evidence) {
    if (item.kind === "confirmation-text" && item.text.length > 0) {
      return item.text.slice(0, BROWSER_LIMITS.maxSummaryChars);
    }
  }
  return undefined;
}

export function classifyCommitOutcome(evidence: CommitEvidence): CommitClassification {
  const confirmation = [...(evidence.confirmation ?? [])];
  const failure = [...(evidence.failure ?? [])];
  const base = {
    confirmation,
    failure,
    ...(firstConfirmationText(confirmation) === undefined
      ? {}
      : { confirmationText: firstConfirmationText(confirmation) }),
  };
  if (evidence.cancelled === true && !evidence.interactionOccurred) {
    return { status: "cancelled", reason: "the user denied the action", ...base };
  }
  if (!evidence.interactionOccurred) {
    return {
      status: "failed",
      reason: failure[0]?.detail ?? "the interaction did not occur",
      ...base,
    };
  }
  if (isSufficientConfirmation(confirmation)) {
    const externalId = firstExternalId(confirmation);
    return {
      status: "confirmed",
      reason: "the site produced sufficient confirmation",
      ...base,
      ...(externalId === undefined ? {} : { externalId }),
    };
  }
  // Ordered before failure evidence on purpose: a lost confirmation can make a
  // completed action look failed, and a false failure is what invites a duplicate.
  if (evidence.cancelled === true) {
    return {
      status: "unknown",
      reason: "stopped after the interaction; stopping does not undo an external effect",
      ...base,
    };
  }
  if (evidence.lost !== undefined) {
    return { status: "unknown", reason: `confirmation was lost (${evidence.lost})`, ...base };
  }
  if (failure.length > 0) {
    return {
      status: "failed",
      reason: failure[0]?.detail ?? "the site reported a failure",
      ...base,
    };
  }
  return {
    status: "completed",
    reason: "the interaction occurred but the site produced no confirmation",
    ...base,
  };
}

// BD17: only `confirmed` reads as success. `completed` is an honest report that the
// click happened, never a claim that the submission landed.
export function isCommitSuccess(status: CommitStatus): boolean {
  return status === "confirmed";
}

// A commitment whose result is not proven is reconciled by observation. `completed`
// joins `unknown` here so an unconfirmed submission cannot be repeated either.
export function commitRequiresReconciliation(status: CommitStatus): boolean {
  return status === "unknown" || status === "completed";
}

export function mayCommitAgain(status: CommitStatus): boolean {
  return status === "failed" || status === "cancelled";
}

// A cancelled commitment produced no external effect, so it has nothing to receipt.
// BD32: `completed` and `unknown` are equally unsafe to retry, so both park in
// awaiting-reconciliation — but they are reported distinctly, because the user's next
// step differs. A missing confirmation means "check the page"; a lost connection means
// "check the site before doing anything else".
export function commitReceiptStatus(status: CommitStatus): ReceiptStatus | undefined {
  switch (status) {
    case "confirmed":
      return "confirmed";
    case "failed":
      return "failed";
    case "completed":
      return "unconfirmed";
    case "unknown":
      return "unknown";
    case "cancelled":
      return undefined;
  }
}

export function hasReceipt(status: CommitStatus): boolean {
  return commitReceiptStatus(status) !== undefined;
}

// Bridge from the driver's own outcome. The driver reports what it saw; the caller
// adds page-level evidence it gathered by observing.
export function commitEvidenceFromOutcome(
  outcome: ActionOutcome,
  extra: Omit<CommitEvidence, "interactionOccurred"> = {},
): CommitEvidence {
  const confirmation: ConfirmationEvidence[] = [...(extra.confirmation ?? [])];
  const candidate = outcome.receiptCandidate;
  if (candidate?.externalId !== undefined) {
    confirmation.push({ kind: "external-id", value: candidate.externalId });
  }
  if (candidate?.confirmationText !== undefined) {
    confirmation.push({ kind: "confirmation-text", text: candidate.confirmationText });
  }
  if (outcome.navigation !== undefined) {
    confirmation.push({
      kind: "navigation",
      from: outcome.navigation.from,
      to: outcome.navigation.to,
    });
  }
  const lost = extra.lost ?? (outcome.status === "unknown" ? "driver-uncertain" : undefined);
  const failure: FailureEvidence[] = [...(extra.failure ?? [])];
  if (outcome.status === "failed") {
    failure.push({ kind: "error-text", detail: outcome.message });
  }
  return {
    interactionOccurred: outcome.status === "completed" || outcome.status === "unknown",
    ...(extra.cancelled === undefined ? {} : { cancelled: extra.cancelled }),
    confirmation,
    failure,
    ...(lost === undefined ? {} : { lost }),
  };
}
