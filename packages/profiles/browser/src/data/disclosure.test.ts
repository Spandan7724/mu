import { describe, expect, test } from "bun:test";
import { DisclosureLedger } from "../artifacts/disclosure.ts";
import { disclosureRecordSchema } from "../contracts/disclosure.ts";
import { findSerializationViolations } from "../contracts/json.ts";
import { authorizeDisclosure, disclosureViews, recordFactDisclosure } from "./disclosure.ts";
import { createFactStore } from "./facts.ts";
import { SAMPLE_ORIGIN, SAMPLE_TIME, SAMPLE_URL } from "./samples.ts";

function setup() {
  const facts = createFactStore({ now: () => SAMPLE_TIME });
  facts.add({
    id: "fact-email",
    field: "email",
    value: "ada.testwell@example.invalid",
    source: { kind: "user" },
    confidence: "exact",
  });
  facts.add({
    id: "fact-salary",
    field: "desired_salary",
    value: "120000",
    source: { kind: "user" },
    confidence: "exact",
  });
  facts.add({
    id: "fact-scoped",
    field: "city",
    value: "Springfield",
    source: { kind: "user" },
    confidence: "exact",
    allowedOrigins: ["https://only-here.example.com"],
  });
  return { facts, ledger: new DisclosureLedger({ now: () => SAMPLE_TIME }) };
}

describe("fact-side authorization", () => {
  test("an authorized disclosure becomes the ledger's own input shape", () => {
    const { facts } = setup();
    const result = authorizeDisclosure(facts, {
      url: SAMPLE_URL,
      fills: [{ factId: "fact-email", fieldName: "Email address" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.origin).toBe(SAMPLE_ORIGIN);
    expect(result.input.factIds).toEqual(["fact-email"]);
    expect(result.input.fieldNames).toEqual(["Email address"]);
  });

  test("a fact that does not exist is refused", () => {
    const { facts } = setup();
    expect(
      authorizeDisclosure(facts, {
        url: SAMPLE_URL,
        fills: [{ factId: "fact-invented", fieldName: "Email address" }],
      }),
    ).toMatchObject({ ok: false, reason: "unknown-fact" });
  });

  test("an origin-scoped fact never reaches another origin", () => {
    const { facts } = setup();
    expect(
      authorizeDisclosure(facts, {
        url: SAMPLE_URL,
        fills: [{ factId: "fact-scoped", fieldName: "City" }],
      }),
    ).toMatchObject({ ok: false, reason: "origin-not-allowed" });
    expect(
      authorizeDisclosure(facts, {
        url: "https://only-here.example.com/apply",
        fills: [{ factId: "fact-scoped", fieldName: "City" }],
      }).ok,
    ).toBe(true);
  });

  test("credential, restricted and solicited field names are refused", () => {
    const { facts } = setup();
    for (const fieldName of ["Account password", "SSN", "Mother's maiden name", "Prior salary"]) {
      expect(
        authorizeDisclosure(facts, {
          url: SAMPLE_URL,
          fills: [{ factId: "fact-email", fieldName }],
        }),
      ).toMatchObject({ ok: false, reason: "forbidden-field" });
    }
  });

  test("a non-web url and an empty disclosure are refused", () => {
    const { facts } = setup();
    expect(
      authorizeDisclosure(facts, {
        url: "file:///etc/passwd",
        fills: [{ factId: "fact-email", fieldName: "Email address" }],
      }),
    ).toMatchObject({ ok: false, reason: "bad-url" });
    expect(authorizeDisclosure(facts, { url: SAMPLE_URL, fills: [] })).toMatchObject({
      ok: false,
      reason: "empty",
    });
  });

  test("a refused disclosure never reaches the ledger", () => {
    const { facts, ledger } = setup();
    recordFactDisclosure(ledger, facts, {
      url: SAMPLE_URL,
      fills: [{ factId: "fact-scoped", fieldName: "City" }],
    });
    expect(ledger.size).toBe(0);
  });
});

describe("recording through the artifacts ledger", () => {
  test("ids and field names are recorded, values are not", () => {
    const { facts, ledger } = setup();
    const result = recordFactDisclosure(ledger, facts, {
      url: SAMPLE_URL,
      fills: [
        { factId: "fact-email", fieldName: "Email address" },
        { factId: "fact-salary", fieldName: "Desired annual salary" },
      ],
      permissionRequestId: "perm-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(disclosureRecordSchema.safeParse(result.record).success).toBe(true);
    expect(result.record.origin).toBe(SAMPLE_ORIGIN);
    expect(result.record.permissionRequestId).toBe("perm-1");
    expect(JSON.stringify(result.record)).not.toContain("ada.testwell@example.invalid");
    expect(JSON.stringify(result.record)).not.toContain("120000");
  });

  test("the ledger stays queryable by origin and fact", () => {
    const { facts, ledger } = setup();
    recordFactDisclosure(ledger, facts, {
      url: SAMPLE_URL,
      fills: [{ factId: "fact-email", fieldName: "Email address" }],
    });
    expect(ledger.forOrigin(SAMPLE_ORIGIN)).toHaveLength(1);
    expect(ledger.factIdsForOrigin(SAMPLE_ORIGIN)).toEqual(["fact-email"]);
    expect(ledger.fieldNamesForOrigin(SAMPLE_ORIGIN)).toEqual(["Email address"]);
  });
});

describe("what is displayed", () => {
  test("a sensitive value is withheld and a personal one is shown", () => {
    const { facts, ledger } = setup();
    recordFactDisclosure(ledger, facts, {
      url: SAMPLE_URL,
      fills: [
        { factId: "fact-email", fieldName: "Email address" },
        { factId: "fact-salary", fieldName: "Desired annual salary" },
      ],
    });
    const [view] = disclosureViews(ledger.records(), facts);
    expect(view?.values.find((entry) => entry.factId === "fact-salary")?.value).toBe("[withheld]");
    expect(view?.values.find((entry) => entry.factId === "fact-email")?.value).toBe(
      "ada.testwell@example.invalid",
    );
    expect(JSON.stringify(disclosureViews(ledger.records(), facts))).not.toContain("120000");
  });

  test("a fact the store has forgotten is named, not guessed at", () => {
    const { facts, ledger } = setup();
    recordFactDisclosure(ledger, facts, {
      url: SAMPLE_URL,
      fills: [{ factId: "fact-email", fieldName: "Email address" }],
    });
    const empty = createFactStore({ now: () => SAMPLE_TIME });
    const [view] = disclosureViews(ledger.records(), empty);
    expect(view?.values[0]?.value).toBe("[unknown fact]");
  });

  test("everything emitted is JSON-serializable", () => {
    const { facts, ledger } = setup();
    recordFactDisclosure(ledger, facts, {
      url: SAMPLE_URL,
      fills: [{ factId: "fact-email", fieldName: "Email address" }],
    });
    expect(findSerializationViolations(ledger.records())).toHaveLength(0);
    expect(findSerializationViolations(disclosureViews(ledger.records(), facts))).toHaveLength(0);
  });
});
