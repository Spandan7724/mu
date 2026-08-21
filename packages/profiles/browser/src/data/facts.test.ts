import { describe, expect, test } from "bun:test";
import { authorizedDocumentId } from "../contracts/primitives.ts";
import { createFactStore, factValueText, sameFactValue } from "./facts.ts";
import { SAMPLE_TIME, sampleResume } from "./samples.ts";

function store() {
  return createFactStore({ documents: [sampleResume()], now: () => SAMPLE_TIME });
}

function stated(field: string, value: string) {
  return { field, value, source: { kind: "user" } as const, confidence: "exact" as const };
}

describe("fact store provenance", () => {
  test("a stated fact keeps its source, confidence, sensitivity and time", () => {
    const result = store().add(stated("email", "ada.testwell@example.invalid"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fact.source).toEqual({ kind: "user" });
    expect(result.fact.confidence).toBe("exact");
    expect(result.fact.sensitivity).toBe("personal");
    expect(result.fact.updatedAt).toBe(SAMPLE_TIME);
  });

  test("sensitivity defaults from the field catalog rather than the caller", () => {
    const facts = store();
    const salary = facts.add(stated("desired_salary", "120000"));
    const portfolio = facts.add(stated("portfolio_url", "https://portfolio.example.invalid/a"));
    expect(salary.ok && salary.fact.sensitivity).toBe("sensitive");
    expect(portfolio.ok && portfolio.fact.sensitivity).toBe("public");
  });

  test("a document fact must cite an authorized document", () => {
    const result = store().add({
      field: "email",
      value: "ada.testwell@example.invalid",
      source: { kind: "document", documentId: authorizedDocumentId("doc-elsewhere") },
      confidence: "exact",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe("unknown-document");
  });

  test("a derived fact must name facts the store already holds", () => {
    const result = store().derive({
      field: "phone_e164",
      value: "+15550100",
      from: ["fact-missing"],
      method: "normalize-phone",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe("unknown-parent");
  });

  test("a derived fact traces back to what it came from", () => {
    const facts = store();
    const phone = facts.add({
      field: "phone",
      value: "+1-555-0100",
      source: {
        kind: "document",
        documentId: authorizedDocumentId("doc-resume"),
        location: "line 2",
      },
      confidence: "exact",
    });
    expect(phone.ok).toBe(true);
    if (!phone.ok) return;
    const derived = facts.derive({
      field: "phone_e164",
      value: "+15550100",
      from: [phone.fact.id],
      method: "normalize-phone",
    });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const provenance = facts.trace(derived.fact);
    expect(provenance.chain).toEqual([derived.fact.id, phone.fact.id]);
    expect(provenance.documentIds).toEqual([authorizedDocumentId("doc-resume")]);
    expect(provenance.method).toBe("normalize-phone");
    expect(provenance.grounded).toBe(true);
    expect(provenance.userStated).toBe(false);
  });
});

describe("the inference boundary", () => {
  test("only an enumerated mechanical derivation may produce an inferred fact", () => {
    const facts = store();
    const name = facts.add(stated("full_name", "Ada Testwell"));
    expect(name.ok).toBe(true);
    if (!name.ok) return;
    const mechanical = facts.derive({
      field: "first_name",
      value: "Ada",
      from: [name.fact.id],
      method: "split-full-name",
    });
    expect(mechanical.ok).toBe(true);

    const judgement = facts.add({
      field: "notice_period",
      value: "2 weeks",
      source: { kind: "derived", factIds: [name.fact.id], method: "seems reasonable" },
      confidence: "inferred",
    });
    expect(judgement.ok).toBe(false);
    if (judgement.ok) return;
    expect(judgement.rejection.reason).toBe("non-mechanical-inference");
  });

  test("an inferred fact cannot claim a user or document source", () => {
    const result = store().add({
      field: "years_experience",
      value: 6,
      source: { kind: "user" },
      confidence: "inferred",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe("non-mechanical-inference");
  });

  test("legal status, salary, demographics and consent are never inferred", () => {
    const facts = store();
    const seed = facts.add(stated("city", "Springfield"));
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;
    for (const field of [
      "work_authorization",
      "visa_status",
      "citizenship",
      "gender",
      "race",
      "veteran_status",
      "disability_status",
      "criminal_history",
      "desired_salary",
      "consent",
      "date_of_birth",
    ]) {
      const result = facts.derive({
        field,
        value: "yes",
        from: [seed.fact.id],
        method: "normalize-date",
      });
      expect(result.ok).toBe(false);
    }
  });

  test("the same consequential field is fine when the user stated it", () => {
    const result = store().add(stated("work_authorization", "yes"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fact.confidence).toBe("exact");
  });
});

describe("what a fact may never be", () => {
  test("credentials are a takeover boundary, not a fact", () => {
    const facts = store();
    for (const field of ["password", "account password", "mfa_code", "one-time code", "cvv"]) {
      const result = facts.add(stated(field, "hunter2"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.rejection.reason).toBe("credential");
    }
  });

  test("restricted identifiers never enter the profile", () => {
    const facts = store();
    for (const field of ["ssn", "passport number", "bank_account_number", "credit card"]) {
      const result = facts.add(stated(field, "1234"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.rejection.reason).toBe("restricted");
    }
  });

  test("data a hostile form solicits is not storable either", () => {
    const facts = store();
    for (const field of ["mothers_maiden_name", "date_of_birth", "prior salary", "session_dump"]) {
      const result = facts.add(stated(field, "x"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["solicitation", "restricted"]).toContain(result.rejection.reason);
      }
    }
  });

  test("a fact value cannot be a live handle", () => {
    const result = store().add({
      field: "full_name",
      value: { reveal: () => "secret" } as never,
      source: { kind: "user" },
      confidence: "exact",
    });
    expect(result.ok).toBe(false);
  });

  test("two facts may not share an id", () => {
    const facts = store();
    expect(facts.add({ ...stated("city", "Springfield"), id: "fact-city" }).ok).toBe(true);
    const duplicate = facts.add({ ...stated("city", "Shelbyville"), id: "fact-city" });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.rejection.reason).toBe("duplicate-id");
  });
});

describe("store views", () => {
  test("the profile projection validates against the applicant contract", async () => {
    const { applicantProfileSchema } = await import("../contracts/applicant.ts");
    const facts = store();
    facts.add(stated("full_name", "Ada Testwell"));
    facts.add(stated("email", "ada.testwell@example.invalid"));
    expect(applicantProfileSchema.safeParse(facts.profile()).success).toBe(true);
  });

  test("factFor returns the most recent fact and byField returns every one", () => {
    const facts = createFactStore({ now: () => SAMPLE_TIME });
    facts.add({ ...stated("city", "Springfield"), updatedAt: 1 });
    facts.add({ ...stated("city", "Shelbyville"), updatedAt: 2 });
    expect(facts.byField("city")).toHaveLength(2);
    expect(facts.factFor("city")?.value).toBe("Shelbyville");
  });
});

describe("value comparison", () => {
  test("casing and surrounding whitespace do not make a disagreement", () => {
    expect(sameFactValue(" Ada Testwell ", "ada testwell")).toBe(true);
    expect(sameFactValue("120000", "120,000")).toBe(false);
    expect(sameFactValue("yes", "no")).toBe(false);
  });

  test("non-string values round-trip through text", () => {
    expect(factValueText(6)).toBe("6");
    expect(factValueText("Ada")).toBe("Ada");
  });
});
