import { describe, expect, test } from "bun:test";
import { sampleApplicantProfile, sampleDocument, sampleFact } from "../testing/samples.ts";
import {
  applicantFactSchema,
  applicantProfileSchema,
  factAllowsOrigin,
  factsForField,
  redactFactValue,
  sensitivitySchema,
} from "./applicant.ts";

function rejects(fact: unknown): boolean {
  return !applicantFactSchema.safeParse(fact).success;
}

describe("applicant fact", () => {
  test("accepts a provenanced personal fact", () => {
    expect(applicantFactSchema.safeParse(sampleFact()).success).toBe(true);
  });

  test("a credential has no home in the profile", () => {
    for (const field of [
      "password",
      "Account Password",
      "passkey",
      "mfa_code",
      "one-time code",
      "security answer",
      "2FA",
      "cvv",
    ]) {
      expect(rejects(sampleFact({ field, value: "hunter2" }))).toBe(true);
    }
  });

  test("restricted identifiers are not accepted into the generic profile in v1", () => {
    for (const field of [
      "ssn",
      "social security number",
      "passport number",
      "bank account",
      "credit card",
      "routing number",
    ]) {
      expect(rejects(sampleFact({ field }))).toBe(true);
    }
  });

  test("the restricted sensitivity is not representable on a fact", () => {
    expect(sensitivitySchema.safeParse("restricted").success).toBe(true);
    expect(rejects(sampleFact({ sensitivity: "restricted" as never }))).toBe(true);
  });

  test("legal status, demographics, compensation and consent are never inferred", () => {
    for (const field of [
      "work_authorization",
      "sponsorship",
      "visa status",
      "gender",
      "race",
      "veteran status",
      "disability",
      "criminal history",
      "desired salary",
      "consent",
    ]) {
      const fact = sampleFact({
        id: "fact-guess",
        field,
        confidence: "inferred",
        source: { kind: "derived", factIds: ["fact-name"], method: "guessed" },
      });
      expect(rejects(fact)).toBe(true);
      // The same field is fine when the user or a document stated it.
      expect(rejects(sampleFact({ id: "fact-stated", field }))).toBe(false);
    }
  });

  test("a mechanical derivation is allowed and must record how it was derived", () => {
    const derived = sampleFact({
      id: "fact-phone-e164",
      field: "phone_e164",
      confidence: "inferred",
      source: { kind: "derived", factIds: ["fact-phone"], method: "normalize to E.164" },
    });
    expect(applicantFactSchema.safeParse(derived).success).toBe(true);
    expect(rejects({ ...derived, source: { kind: "user" } })).toBe(true);
  });

  test("a fact cannot derive from itself", () => {
    const fact = sampleFact({
      field: "years_experience",
      confidence: "inferred",
      source: { kind: "derived", factIds: ["fact-name"], method: "self" },
    });
    expect(fact.id).toBe("fact-name");
    expect(rejects(fact)).toBe(true);
  });

  test("allowed origins must be normalized origins", () => {
    expect(rejects(sampleFact({ allowedOrigins: ["https://jobs.example.com/apply"] }))).toBe(true);
    expect(rejects(sampleFact({ allowedOrigins: ["jobs.example.com"] }))).toBe(true);
    expect(rejects(sampleFact({ allowedOrigins: ["https://jobs.example.com"] }))).toBe(false);
  });

  test("an origin-scoped fact is disclosable nowhere else", () => {
    const scoped = sampleFact({ allowedOrigins: ["https://jobs.example.com"] });
    expect(factAllowsOrigin(scoped, "https://jobs.example.com")).toBe(true);
    expect(factAllowsOrigin(scoped, "https://evil.example.com")).toBe(false);
    expect(factAllowsOrigin(sampleFact(), "https://anywhere.example.com")).toBe(true);
  });

  test("a sensitive value is withheld from previews and receipts", () => {
    expect(redactFactValue(sampleFact({ sensitivity: "sensitive" }))).toBe("[withheld]");
    expect(redactFactValue(sampleFact())).toBe("Ada Lovelace");
  });

  test("a fact value cannot be a live handle or a cyclic object", () => {
    expect(rejects(sampleFact({ value: { get: () => 1 } as never }))).toBe(true);
  });
});

describe("applicant profile", () => {
  test("accepts the sample profile", () => {
    expect(applicantProfileSchema.safeParse(sampleApplicantProfile()).success).toBe(true);
  });

  test("a fact cannot cite a document that was never authorized", () => {
    const profile = sampleApplicantProfile({
      facts: [sampleFact({ source: { kind: "document", documentId: "doc-other" as never } })],
    });
    expect(applicantProfileSchema.safeParse(profile).success).toBe(false);
  });

  test("a fact cannot derive from a fact that does not exist", () => {
    const profile = sampleApplicantProfile({
      facts: [
        sampleFact({
          id: "fact-derived",
          field: "years_experience",
          confidence: "inferred",
          source: { kind: "derived", factIds: ["fact-missing"], method: "sum of dates" },
        }),
      ],
    });
    expect(applicantProfileSchema.safeParse(profile).success).toBe(false);
  });

  test("two facts may not share an id", () => {
    const profile = sampleApplicantProfile({ facts: [sampleFact(), sampleFact()] });
    expect(applicantProfileSchema.safeParse(profile).success).toBe(false);
  });

  test("an unknown top-level key is rejected", () => {
    const profile = { ...sampleApplicantProfile(), password: "hunter2" };
    expect(applicantProfileSchema.safeParse(profile).success).toBe(false);
  });

  test("facts are looked up by field name", () => {
    const profile = sampleApplicantProfile({
      facts: [sampleFact(), sampleFact({ id: "fact-email", field: "email" })],
      documents: [sampleDocument()],
    });
    expect(factsForField(profile, "email").map((fact) => fact.id)).toEqual(["fact-email"]);
    expect(factsForField(profile, "nothing")).toHaveLength(0);
  });
});
