import { z } from "zod";
import { type AuthorizedDocument, authorizedDocumentSchema } from "./documents.ts";
import { type JsonValue, jsonValueSchema } from "./json.ts";
import {
  type AuthorizedDocumentId,
  authorizedDocumentIdSchema,
  identifierSchema,
  originSchema,
  timestampSchema,
} from "./primitives.ts";
import { isCredentialLabel, isProtectedInferenceField, isRestrictedField } from "./redaction.ts";

export type FactSource =
  | { kind: "user"; label?: string | undefined }
  | { kind: "document"; documentId: AuthorizedDocumentId; location?: string | undefined }
  | { kind: "derived"; factIds: string[]; method: string };

export const factSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), label: z.string().max(256).optional() }),
  z.strictObject({
    kind: z.literal("document"),
    documentId: authorizedDocumentIdSchema,
    location: z.string().max(256).optional(),
  }),
  z.strictObject({
    kind: z.literal("derived"),
    factIds: z.array(identifierSchema).min(1).max(50),
    method: z.string().min(1).max(256),
  }),
]);

export type Sensitivity = "public" | "personal" | "sensitive" | "restricted";

export const sensitivitySchema = z.enum(["public", "personal", "sensitive", "restricted"]);

// SECURITY.md §7: restricted values are not accepted into the generic profile in
// v1, so a fact cannot structurally carry that classification.
export type ApplicantFactSensitivity = Exclude<Sensitivity, "restricted">;

export const applicantFactSensitivitySchema = z.enum(["public", "personal", "sensitive"]);

export type FactConfidence = "exact" | "inferred" | "uncertain";

export const factConfidenceSchema = z.enum(["exact", "inferred", "uncertain"]);

export interface ApplicantFact {
  id: string;
  field: string;
  value: JsonValue;
  source: FactSource;
  confidence: FactConfidence;
  sensitivity: ApplicantFactSensitivity;
  allowedOrigins?: string[] | undefined;
  updatedAt: number;
}

export const applicantFactSchema = z
  .strictObject({
    id: identifierSchema,
    field: z.string().min(1).max(256),
    value: jsonValueSchema,
    source: factSourceSchema,
    confidence: factConfidenceSchema,
    sensitivity: applicantFactSensitivitySchema,
    allowedOrigins: z.array(originSchema).max(200).optional(),
    updatedAt: timestampSchema,
  })
  .superRefine((fact, ctx) => {
    if (isCredentialLabel(fact.field)) {
      ctx.addIssue({
        code: "custom",
        path: ["field"],
        message: "passwords, passkeys, MFA codes and security answers are takeover-only (BD14)",
      });
    }
    if (isRestrictedField(fact.field)) {
      ctx.addIssue({
        code: "custom",
        path: ["field"],
        message: "restricted identifiers are not accepted into the applicant profile in v1",
      });
    }
    if (fact.confidence === "inferred" && isProtectedInferenceField(fact.field)) {
      ctx.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "legal status, demographics, compensation and consent are never inferred",
      });
    }
    if (fact.confidence === "inferred" && fact.source.kind !== "derived") {
      ctx.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "an inferred fact must record the mechanical derivation that produced it",
      });
    }
    if (fact.source.kind === "derived" && fact.source.factIds.includes(fact.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["source", "factIds"],
        message: "a fact cannot derive from itself",
      });
    }
  });

export type DemographicBehavior = "ask" | "decline" | "omit-when-optional";

export const demographicBehaviorSchema = z.enum(["ask", "decline", "omit-when-optional"]);

// A policy answer is a fact like any other. It lives exactly once, in
// ApplicantProfile.facts, and the policy references it by id — so disclosure,
// replay, provenance and receipts all resolve it through the same lookup.
export interface ApplicantPolicy {
  workAuthorizationFactId?: string | undefined;
  sponsorshipFactId?: string | undefined;
  relocationFactId?: string | undefined;
  compensationFactId?: string | undefined;
  demographicAnswerFactIds?: string[] | undefined;
  defaultDemographicBehavior?: DemographicBehavior | undefined;
}

// The canonical field each policy slot must point at, so a policy cannot answer
// "work authorization" with a fact about someone's phone number.
export const POLICY_FACT_FIELDS = {
  workAuthorizationFactId: ["work_authorization"],
  sponsorshipFactId: ["sponsorship"],
  relocationFactId: ["relocation"],
  compensationFactId: ["desired_salary"],
  demographicAnswerFactIds: ["gender", "ethnicity", "veteran_status", "disability_status"],
} as const;

export const applicantPolicySchema = z.strictObject({
  workAuthorizationFactId: identifierSchema.optional(),
  sponsorshipFactId: identifierSchema.optional(),
  relocationFactId: identifierSchema.optional(),
  compensationFactId: identifierSchema.optional(),
  demographicAnswerFactIds: z.array(identifierSchema).max(100).optional(),
  defaultDemographicBehavior: demographicBehaviorSchema.optional(),
});

export interface ApplicantProfile {
  version: 1;
  facts: ApplicantFact[];
  policy: ApplicantPolicy;
  documents: AuthorizedDocument[];
}

export const applicantProfileSchema = z
  .strictObject({
    version: z.literal(1),
    facts: z.array(applicantFactSchema).max(1_000),
    policy: applicantPolicySchema,
    documents: z.array(authorizedDocumentSchema).max(100),
  })
  .superRefine((profile, ctx) => {
    const factIds = new Set<string>();
    for (const fact of profile.facts) {
      if (factIds.has(fact.id)) {
        ctx.addIssue({ code: "custom", path: ["facts"], message: `duplicate fact id ${fact.id}` });
      }
      factIds.add(fact.id);
    }
    const documentIds = new Set(profile.documents.map((document) => document.id));
    for (const fact of profile.facts) {
      if (fact.source.kind === "document" && !documentIds.has(fact.source.documentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["facts"],
          message: `fact ${fact.id} cites an unauthorized document`,
        });
      }
      if (fact.source.kind === "derived") {
        for (const id of fact.source.factIds) {
          if (!factIds.has(id)) {
            ctx.addIssue({
              code: "custom",
              path: ["facts"],
              message: `fact ${fact.id} derives from unknown fact ${id}`,
            });
          }
        }
      }
    }
    const byId = new Map(profile.facts.map((fact) => [fact.id, fact]));
    for (const [slot, fields] of Object.entries(POLICY_FACT_FIELDS)) {
      const value = profile.policy[slot as keyof typeof POLICY_FACT_FIELDS];
      const ids = value === undefined ? [] : Array.isArray(value) ? value : [value];
      for (const id of ids) {
        const fact = byId.get(id);
        if (fact === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["policy", slot],
            message: `policy references unknown fact ${id}`,
          });
          continue;
        }
        if (!(fields as readonly string[]).includes(fact.field)) {
          ctx.addIssue({
            code: "custom",
            path: ["policy", slot],
            message: `fact ${id} has field "${fact.field}", which ${slot} cannot answer`,
          });
        }
      }
    }
  });

export function factsForField(profile: ApplicantProfile, field: string): ApplicantFact[] {
  return profile.facts.filter((fact) => fact.field === field);
}

// A fact restricted to specific origins is disclosable nowhere else, whatever a
// page or the model claims.
export function factAllowsOrigin(fact: ApplicantFact, origin: string): boolean {
  return fact.allowedOrigins === undefined || fact.allowedOrigins.includes(origin);
}

// Rendering rule for transcripts, previews and receipts.
export function redactFactValue(fact: ApplicantFact): JsonValue {
  return fact.sensitivity === "sensitive" ? "[withheld]" : fact.value;
}

export const EMPTY_APPLICANT_PROFILE: ApplicantProfile = {
  version: 1,
  facts: [],
  policy: {},
  documents: [],
};
