import { describe, expect, test } from "bun:test";
import { sampleDisclosure, sampleReceipt } from "../testing/samples.ts";
import { disclosedFactIds, disclosureRecordSchema, disclosuresForOrigin } from "./disclosure.ts";
import { assertJsonSerializable } from "./json.ts";
import { browserReceiptSchema, receiptCandidateSchema, receiptEntry } from "./receipt.ts";

function rejects(receipt: unknown): boolean {
  return !browserReceiptSchema.safeParse(receipt).success;
}

describe("receipt", () => {
  test("accepts a confirmed receipt", () => {
    expect(browserReceiptSchema.safeParse(sampleReceipt()).success).toBe(true);
    assertJsonSerializable(sampleReceipt(), "receipt");
  });

  test("the only statuses are confirmed, unknown and failed — never rolled back", () => {
    expect(rejects(sampleReceipt({ status: "rolled-back" as never }))).toBe(true);
    expect(rejects(sampleReceipt({ status: "cancelled" as never }))).toBe(true);
    expect(
      rejects(
        sampleReceipt({ status: "unknown", externalId: undefined, confirmationText: undefined }),
      ),
    ).toBe(false);
  });

  test("an external id is evidence of confirmation and cannot accompany uncertainty", () => {
    expect(rejects(sampleReceipt({ status: "unknown" }))).toBe(true);
    expect(rejects(sampleReceipt({ status: "failed" }))).toBe(true);
  });

  test("origin must be the normalized origin of the final URL", () => {
    expect(rejects(sampleReceipt({ origin: "https://elsewhere.example.com" }))).toBe(true);
    expect(rejects(sampleReceipt({ origin: "https://jobs.example.com/apply" }))).toBe(true);
  });

  test("uploaded files are recorded by id, basename and digest — never by path", () => {
    expect(
      rejects(
        sampleReceipt({
          uploadedFiles: [
            {
              documentId: "doc-resume" as never,
              basename: "/home/user/resume.pdf",
              sha256: "a".repeat(64),
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(JSON.stringify(sampleReceipt())).not.toContain("/home");
  });

  test("a screenshot reference is relative to the artifact root", () => {
    expect(rejects(sampleReceipt({ screenshotPath: "/home/user/.mu/shot.png" }))).toBe(true);
    expect(rejects(sampleReceipt({ screenshotPath: "../../etc/passwd" }))).toBe(true);
    expect(rejects(sampleReceipt({ screenshotPath: "session-1/confirmation.png" }))).toBe(false);
  });

  test("an unknown key cannot smuggle a value into a receipt file", () => {
    expect(rejects({ ...sampleReceipt(), password: "hunter2" })).toBe(true);
    expect(rejects({ ...sampleReceipt(), disclosedValues: ["Ada Lovelace"] })).toBe(true);
  });

  test("the completion timestamp must be a real ISO instant", () => {
    expect(rejects(sampleReceipt({ completedAt: "yesterday" }))).toBe(true);
  });

  test("the session entry carries only the identifying fields", () => {
    const entry = receiptEntry(sampleReceipt(), "session-1/receipt-1.json");
    expect(Object.keys(entry).sort()).toEqual([
      "artifactPath",
      "finalUrl",
      "intent",
      "receiptId",
      "status",
    ]);
    expect(JSON.stringify(entry)).not.toContain("Ada");
    expect(JSON.stringify(entry)).not.toContain("APP-4711");
  });
});

describe("receipt candidate", () => {
  test("carries the evidence a receipt is built from", () => {
    const candidate = {
      kind: "submit-form",
      url: "https://jobs.example.com/apply/confirmation",
      title: "Thanks",
      confirmationText: "Your application was received.",
    };
    expect(receiptCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(receiptCandidateSchema.safeParse({ ...candidate, kind: "click" }).success).toBe(false);
  });
});

describe("disclosure ledger", () => {
  test("records ids and field names and has no field for a value", () => {
    expect(disclosureRecordSchema.safeParse(sampleDisclosure()).success).toBe(true);
    expect(
      disclosureRecordSchema.safeParse({ ...sampleDisclosure(), values: ["Ada Lovelace"] }).success,
    ).toBe(false);
  });

  test("the origin must be normalized", () => {
    expect(
      disclosureRecordSchema.safeParse(
        sampleDisclosure({ origin: "https://jobs.example.com/apply" }),
      ).success,
    ).toBe(false);
  });

  test("aggregates disclosed facts and filters by origin", () => {
    const records = [
      sampleDisclosure(),
      sampleDisclosure({ id: "disc-2", factIds: ["fact-name", "fact-email"] }),
      sampleDisclosure({ id: "disc-3", origin: "https://other.example.com" }),
    ];
    expect(disclosedFactIds(records).sort()).toEqual(["fact-email", "fact-name"]);
    expect(disclosuresForOrigin(records, "https://other.example.com")).toHaveLength(1);
  });
});
