import { describe, expect, test } from "bun:test";
import { unknownOutcome } from "../contracts/actions.ts";
import type { ReceiptStatus } from "../contracts/receipt.ts";
import { receiptNeedsReview } from "../contracts/receipt.ts";
import {
  SAMPLE_ORIGIN,
  SAMPLE_TAB_ID,
  SAMPLE_URL,
  sampleActionOutcome,
} from "../testing/samples.ts";
import {
  type CommitStatus,
  classifyCommitOutcome,
  commitEvidenceFromOutcome,
  commitReceiptStatus,
  commitRequiresReconciliation,
  hasReceipt,
  isCommitSuccess,
  isSufficientConfirmation,
  mayCommitAgain,
} from "./outcome.ts";

const CONFIRMATION_URL = `${SAMPLE_ORIGIN}/apply/confirmation`;

describe("confirmation evidence", () => {
  test("an external id or a deterministic response stands alone", () => {
    expect(isSufficientConfirmation([{ kind: "external-id", value: "APP-4711" }])).toBe(true);
    expect(isSufficientConfirmation([{ kind: "deterministic-response", ok: true }])).toBe(true);
  });

  test("page text alone is not proof, because the page writes it", () => {
    expect(
      isSufficientConfirmation([{ kind: "confirmation-text", text: "Application received" }]),
    ).toBe(false);
  });

  test("two independent weak signals corroborate", () => {
    expect(
      isSufficientConfirmation([
        { kind: "confirmation-text", text: "Application received" },
        { kind: "navigation", from: SAMPLE_URL, to: CONFIRMATION_URL },
      ]),
    ).toBe(true);
    expect(
      isSufficientConfirmation([
        { kind: "form-disappeared", label: "Apply" },
        { kind: "navigation", from: SAMPLE_URL, to: CONFIRMATION_URL },
      ]),
    ).toBe(true);
  });

  test("a rejected deterministic response confirms nothing", () => {
    expect(isSufficientConfirmation([{ kind: "deterministic-response", ok: false }])).toBe(false);
  });

  test("an empty external id is not an external id", () => {
    expect(isSufficientConfirmation([{ kind: "external-id", value: "" }])).toBe(false);
  });
});

describe("outcome classification", () => {
  test("confirmed carries the site's own identifier", () => {
    const result = classifyCommitOutcome({
      interactionOccurred: true,
      confirmation: [
        { kind: "external-id", value: "APP-4711" },
        { kind: "confirmation-text", text: "Your application was received." },
      ],
    });
    expect(result.status).toBe("confirmed");
    expect(result.externalId).toBe("APP-4711");
    expect(result.confirmationText).toBe("Your application was received.");
  });

  test("an interaction with no confirmation is completed, never confirmed", () => {
    const result = classifyCommitOutcome({ interactionOccurred: true });
    expect(result.status).toBe("completed");
    expect(isCommitSuccess(result.status)).toBe(false);
  });

  test("a lost confirmation is unknown", () => {
    for (const lost of ["disconnected", "timeout", "tab-closed", "driver-uncertain"] as const) {
      expect(classifyCommitOutcome({ interactionOccurred: true, lost }).status).toBe("unknown");
    }
  });

  test("a lost confirmation outranks failure evidence", () => {
    const result = classifyCommitOutcome({
      interactionOccurred: true,
      failure: [{ kind: "error-text", detail: "Something went wrong" }],
      lost: "timeout",
    });
    // A false "failed" invites a retry; that is the duplicate this ordering avoids.
    expect(result.status).toBe("unknown");
  });

  test("proof outranks a later loss", () => {
    const result = classifyCommitOutcome({
      interactionOccurred: true,
      confirmation: [{ kind: "external-id", value: "APP-1" }],
      lost: "tab-closed",
    });
    expect(result.status).toBe("confirmed");
  });

  test("evidence of rejection is failed", () => {
    const result = classifyCommitOutcome({
      interactionOccurred: true,
      failure: [{ kind: "validation-error", detail: "Email is required" }],
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("Email is required");
  });

  test("a denial before the interaction is cancelled", () => {
    expect(classifyCommitOutcome({ interactionOccurred: false, cancelled: true }).status).toBe(
      "cancelled",
    );
  });

  test("stopping after the interaction is unknown, because stopping undoes nothing", () => {
    const result = classifyCommitOutcome({ interactionOccurred: true, cancelled: true });
    expect(result.status).toBe("unknown");
    expect(result.reason).toContain("does not undo");
  });

  test("an interaction that never happened is failed", () => {
    expect(classifyCommitOutcome({ interactionOccurred: false }).status).toBe("failed");
  });
});

describe("what a status permits", () => {
  test("only confirmed reads as success", () => {
    const statuses: CommitStatus[] = ["confirmed", "completed", "unknown", "failed", "cancelled"];
    expect(statuses.filter(isCommitSuccess)).toEqual(["confirmed"]);
  });

  test("unproven outcomes are reconciled, never repeated", () => {
    expect(commitRequiresReconciliation("unknown")).toBe(true);
    expect(commitRequiresReconciliation("completed")).toBe(true);
    expect(mayCommitAgain("unknown")).toBe(false);
    expect(mayCommitAgain("completed")).toBe(false);
    expect(mayCommitAgain("confirmed")).toBe(false);
    expect(mayCommitAgain("failed")).toBe(true);
    expect(mayCommitAgain("cancelled")).toBe(true);
  });

  test("an unproven commitment cannot receipt as success", () => {
    // BD32: distinct statuses, but neither of the uncertain ones is "confirmed".
    expect(commitReceiptStatus("completed")).toBe("unconfirmed");
    expect(commitReceiptStatus("unknown")).toBe("unknown");
    expect(commitReceiptStatus("failed")).toBe("failed");
    expect(commitReceiptStatus("confirmed")).toBe("confirmed");
    for (const status of ["completed", "unknown"] as const) {
      expect(receiptNeedsReview(commitReceiptStatus(status) as ReceiptStatus)).toBe(true);
    }
    expect(receiptNeedsReview("confirmed")).toBe(false);
  });

  test("a cancelled commitment has no external effect to receipt", () => {
    expect(commitReceiptStatus("cancelled")).toBeUndefined();
    expect(hasReceipt("cancelled")).toBe(false);
  });

  test("no status can express a rollback", () => {
    const statuses: CommitStatus[] = ["confirmed", "completed", "unknown", "failed", "cancelled"];
    expect(statuses.some((status) => /rollback|rolled|undo|revert/i.test(status))).toBe(false);
  });
});

describe("evidence from a driver outcome", () => {
  test("a driver unknown becomes a lost confirmation", () => {
    const evidence = commitEvidenceFromOutcome(
      unknownOutcome({
        message: "The connection dropped after the click.",
        before: { tabId: SAMPLE_TAB_ID, revision: 3, url: SAMPLE_URL },
      }),
    );
    expect(evidence.interactionOccurred).toBe(true);
    expect(evidence.lost).toBe("driver-uncertain");
    expect(classifyCommitOutcome(evidence).status).toBe("unknown");
  });

  test("a receipt candidate's identifier carries into the evidence", () => {
    const evidence = commitEvidenceFromOutcome(
      sampleActionOutcome({
        receiptCandidate: {
          kind: "submit-form",
          url: CONFIRMATION_URL,
          title: "Received",
          externalId: "APP-9",
          confirmationText: "Thanks!",
        },
        navigation: { from: SAMPLE_URL, to: CONFIRMATION_URL },
      }),
    );
    expect(classifyCommitOutcome(evidence).status).toBe("confirmed");
  });

  test("a blocked or stale action never counts as an interaction", () => {
    for (const status of ["blocked", "stale", "takeover"] as const) {
      const evidence = commitEvidenceFromOutcome(
        sampleActionOutcome({ ok: false, status, after: undefined }),
      );
      expect(evidence.interactionOccurred).toBe(false);
      expect(classifyCommitOutcome(evidence).status).toBe("failed");
    }
  });
});
