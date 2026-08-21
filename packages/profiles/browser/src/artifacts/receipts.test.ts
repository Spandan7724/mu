import { describe, expect, test } from "bun:test";
import { documentSummary } from "../contracts/documents.ts";
import { browserReceiptSchema } from "../contracts/receipt.ts";
import { REDACTED } from "../contracts/secret.ts";
import { SAMPLE_ORIGIN, SAMPLE_URL, sampleDocument, sampleFact } from "../testing/samples.ts";
import { DisclosureLedger } from "./disclosure.ts";
import { buildReceipt, ReceiptBuildError, type ReceiptDraft } from "./receipts.ts";

const CONFIRMATION_URL = `${SAMPLE_ORIGIN}/apply/confirmation`;

function ledgerWith(fieldNames: string[], url = SAMPLE_URL): DisclosureLedger {
  const ledger = new DisclosureLedger({ now: () => 1_700_000_000_000 });
  ledger.record({ url, factIds: ["fact-name", "fact-email"], fieldNames });
  return ledger;
}

function draft(overrides: Partial<ReceiptDraft> = {}): ReceiptDraft {
  return {
    id: "receipt-1",
    sessionId: "session-1",
    intent: "submit-form",
    status: "confirmed",
    startedUrl: SAMPLE_URL,
    finalUrl: CONFIRMATION_URL,
    completedAt: "2026-08-20T10:00:00.000Z",
    externalId: "APP-4711",
    confirmationText: "Your application was received.",
    disclosures: ledgerWith(["Full name", "Email"]).records(),
    uploads: [documentSummary(sampleDocument())],
    ...overrides,
  };
}

describe("receipt construction", () => {
  test("records what happened, addressed by document id and basename", () => {
    const { receipt } = buildReceipt(draft());
    expect(browserReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(receipt.status).toBe("confirmed");
    expect(receipt.origin).toBe(SAMPLE_ORIGIN);
    expect(receipt.externalId).toBe("APP-4711");
    expect(receipt.disclosedFields).toEqual(["Full name", "Email"]);
    expect(receipt.disclosedFactIds).toEqual(["fact-name", "fact-email"]);
    expect(receipt.uploadedFiles).toEqual([
      { documentId: sampleDocument().id, basename: "resume.pdf", sha256: sampleDocument().sha256 },
    ]);
    expect(JSON.stringify(receipt)).not.toContain(sampleDocument().path);
  });

  test("the session entry carries the reference, not the receipt", () => {
    const { entry } = buildReceipt(draft());
    expect(Object.keys(entry).sort()).toEqual(["finalUrl", "intent", "receiptId", "status"]);
  });

  test("an unproven outcome never receipts as success and drops the external id", () => {
    const { receipt } = buildReceipt(draft({ status: "unknown" }));
    expect(receipt.status).toBe("unknown");
    expect(receipt.externalId).toBeUndefined();
    const completed = buildReceipt(draft({ status: "completed" }));
    expect(completed.receipt.status).toBe("unknown");
    expect(completed.receipt.externalId).toBeUndefined();
  });

  test("a cancelled commitment has nothing to receipt", () => {
    expect(() => buildReceipt(draft({ status: "cancelled" }))).toThrow(ReceiptBuildError);
  });

  test("only disclosures to the receipt's own origin are recorded", () => {
    const ledger = ledgerWith(["Full name"]);
    ledger.record({
      url: "https://tracker.example.net/collect",
      factIds: ["fact-phone"],
      fieldNames: ["Phone"],
    });
    const { receipt } = buildReceipt(draft({ disclosures: ledger.records() }));
    expect(receipt.disclosedFields).toEqual(["Full name"]);
    expect(receipt.disclosedFactIds).not.toContain("fact-phone");
  });

  test("a credential-shaped field name is never recorded", () => {
    const ledger = new DisclosureLedger();
    const recorded = ledger.record({
      url: SAMPLE_URL,
      factIds: ["fact-name"],
      fieldNames: ["Full name", "Password", "MFA code"],
    });
    expect(recorded.ok).toBe(true);
    if (recorded.ok) expect(recorded.omittedFields).toEqual(["Password", "MFA code"]);
    const { receipt } = buildReceipt(draft({ disclosures: ledger.records() }));
    expect(receipt.disclosedFields).toEqual(["Full name"]);
    expect(JSON.stringify(receipt).toLowerCase()).not.toContain("password");
  });

  test("the receipt drops a credential field name the ledger never saw", () => {
    const smuggled = ledgerWith(["Full name"]).records();
    const [record] = smuggled;
    if (record !== undefined) record.fieldNames = ["Full name", "Security answer"];
    const { receipt, omittedFields } = buildReceipt(draft({ disclosures: smuggled }));
    expect(receipt.disclosedFields).toEqual(["Full name"]);
    expect(omittedFields).toEqual(["Security answer"]);
  });

  test("a sensitive fact value is redacted out of the confirmation text", () => {
    const salary = sampleFact({
      id: "fact-salary",
      field: "desired_compensation",
      value: "185000 USD",
      sensitivity: "sensitive",
    });
    const { receipt } = buildReceipt(
      draft({
        facts: [salary],
        confirmationText: "We received your application at 185000 USD.",
      }),
    );
    expect(receipt.confirmationText).toBe(`We received your application at ${REDACTED}.`);
  });

  test("a restricted value stays redacted wherever it could surface", () => {
    const { receipt } = buildReceipt(
      draft({
        redactValues: [{ value: "123-45-6789", sensitivity: "restricted" }],
        confirmationText: "Received for applicant 123-45-6789.",
      }),
    );
    expect(receipt.confirmationText).not.toContain("123-45-6789");
    expect(receipt.confirmationText).toContain(REDACTED);
  });

  test("a page that echoes a secret cannot write it into the receipt", () => {
    const { receipt } = buildReceipt(
      draft({
        confirmationText:
          "Saved. session_id=8f2a1c3e9b Authorization: Bearer eyJhbGciOiJIUzI1NiJ9 card 4111 1111 1111 1111",
      }),
    );
    const text = receipt.confirmationText ?? "";
    expect(text).not.toContain("8f2a1c3e9b");
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(text).not.toContain("4111 1111 1111 1111");
  });

  test("a raw screenshot cannot ride in as a screenshot path", () => {
    expect(() =>
      buildReceipt(draft({ screenshotPath: "data:image/png;base64,iVBORw0KGgo=" })),
    ).toThrow(ReceiptBuildError);
    expect(() => buildReceipt(draft({ screenshotPath: "https://evil.example.com/x.png" }))).toThrow(
      ReceiptBuildError,
    );
    const { receipt } = buildReceipt(draft({ screenshotPath: "screenshots/receipt-1.png" }));
    expect(receipt.screenshotPath).toBe("screenshots/receipt-1.png");
  });

  test("a receipt has no field in which to claim a rollback", () => {
    const { receipt } = buildReceipt(draft());
    expect(Object.keys(receipt)).not.toContain("rolledBack");
    expect(Object.keys(receipt)).not.toContain("undo");
    expect(Object.keys(receipt)).not.toContain("checkpoint");
  });

  test("a non-web final url is refused", () => {
    expect(() => buildReceipt(draft({ finalUrl: "file:///tmp/confirmation.html" }))).toThrow(
      ReceiptBuildError,
    );
  });

  test("the completion timestamp is normalized to ISO-8601", () => {
    const { receipt } = buildReceipt(draft({ completedAt: 1_700_000_000_000 }));
    expect(receipt.completedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
});
