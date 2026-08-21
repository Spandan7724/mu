import { describe, expect, test } from "bun:test";
import { disclosureRecordSchema } from "../contracts/disclosure.ts";
import { SAMPLE_ORIGIN, SAMPLE_URL, sampleFact } from "../testing/samples.ts";
import { DisclosureLedger } from "./disclosure.ts";
import { collectRedactableValues, containsAnyValue, redactText } from "./redaction.ts";

function ledger(): DisclosureLedger {
  return new DisclosureLedger({ now: () => 1_700_000_000_000 });
}

describe("disclosure ledger", () => {
  test("records which facts reached which origin", () => {
    const book = ledger();
    const result = book.record({
      url: SAMPLE_URL,
      factIds: ["fact-name", "fact-email"],
      fieldNames: ["Full name", "Email"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(disclosureRecordSchema.safeParse(result.record).success).toBe(true);
    expect(result.record.origin).toBe(SAMPLE_ORIGIN);
    expect(book.factIdsForOrigin(SAMPLE_ORIGIN)).toEqual(["fact-name", "fact-email"]);
    expect(book.fieldNamesForOrigin(SAMPLE_ORIGIN)).toEqual(["Full name", "Email"]);
  });

  test("a record has nowhere to put a disclosed value", () => {
    const book = ledger();
    book.record({ url: SAMPLE_URL, factIds: ["fact-name"], fieldNames: ["Full name"] });
    const [record] = book.records();
    expect(Object.keys(record ?? {}).sort()).toEqual([
      "factIds",
      "fieldNames",
      "id",
      "origin",
      "timestamp",
      "url",
    ]);
  });

  test("origins are kept apart", () => {
    const book = ledger();
    book.record({ url: SAMPLE_URL, factIds: ["fact-name"], fieldNames: ["Full name"] });
    book.record({
      url: "https://tracker.example.net/collect",
      factIds: ["fact-phone"],
      fieldNames: ["Phone"],
    });
    expect(book.factIdsForOrigin(SAMPLE_ORIGIN)).toEqual(["fact-name"]);
    expect(book.forOrigin("https://tracker.example.net")).toHaveLength(1);
  });

  test("a credential field name is dropped and reported", () => {
    const book = ledger();
    const result = book.record({
      url: SAMPLE_URL,
      factIds: ["fact-name"],
      fieldNames: ["Full name", "Password", "One-time code"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.fieldNames).toEqual(["Full name"]);
    expect(result.omittedFields).toEqual(["Password", "One-time code"]);
  });

  test("a non-web destination is not a disclosure target", () => {
    const result = ledger().record({
      url: "file:///etc/passwd",
      factIds: ["fact-name"],
      fieldNames: ["Full name"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-origin");
  });

  test("a disclosure of nothing is not recorded", () => {
    const result = ledger().record({ url: SAMPLE_URL, factIds: [], fieldNames: ["Full name"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-facts");
  });

  test("the ledger is bounded and says how much it dropped", () => {
    const book = new DisclosureLedger({ maxRecords: 3 });
    for (let index = 0; index < 10; index += 1) {
      book.record({ url: SAMPLE_URL, factIds: [`fact-${index}`], fieldNames: ["Field"] });
    }
    expect(book.size).toBe(3);
    expect(book.droppedRecords).toBe(7);
    expect(book.factIdsForOrigin(SAMPLE_ORIGIN)).toEqual(["fact-7", "fact-8", "fact-9"]);
  });

  test("duplicate fact ids and field names collapse", () => {
    const result = ledger().record({
      url: SAMPLE_URL,
      factIds: ["fact-name", "fact-name"],
      fieldNames: ["Full name", "Full name"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.factIds).toEqual(["fact-name"]);
      expect(result.record.fieldNames).toEqual(["Full name"]);
    }
  });
});

describe("redaction by sensitivity", () => {
  test("sensitive and restricted values are collected, public and personal are not", () => {
    const values = collectRedactableValues(
      [
        sampleFact({ id: "fact-city", value: "Ada Lovelace", sensitivity: "personal" }),
        sampleFact({ id: "fact-addr", value: "12 Orchard Lane", sensitivity: "sensitive" }),
      ],
      [
        { value: "123-45-6789", sensitivity: "restricted" },
        { value: "https://ada.example.com", sensitivity: "public" },
      ],
    );
    expect(values).toEqual(["12 Orchard Lane", "123-45-6789"]);
  });

  test("a short value is not scrubbed, because it would shred unrelated text", () => {
    expect(redactText("Mailing to NY office", ["NY"])).toBe("Mailing to NY office");
  });

  test("scrubbing is case-insensitive and repeated", () => {
    const text = redactText("12 Orchard Lane and 12 orchard lane", ["12 Orchard Lane"]);
    expect(text).not.toContain("Orchard");
    expect(text).not.toContain("orchard");
  });

  test("secret-shaped text is scrubbed even with no declared values", () => {
    const text = redactText(
      "cookie: session=abc123def456; api_key=sk-live-90210; password: hunter2",
    );
    expect(text).not.toContain("abc123def456");
    expect(text).not.toContain("sk-live-90210");
    expect(text).not.toContain("hunter2");
  });

  test("a base64 image never survives as text", () => {
    expect(redactText("shot: data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==")).not.toContain(
      "iVBORw0KGgo",
    );
  });

  test("containsAnyValue is the check a caller can assert on", () => {
    expect(containsAnyValue("applicant 12 Orchard Lane", ["12 Orchard Lane"])).toBe(true);
    expect(containsAnyValue("applicant elsewhere", ["12 Orchard Lane"])).toBe(false);
    expect(containsAnyValue("NY", ["NY"])).toBe(false);
  });
});
