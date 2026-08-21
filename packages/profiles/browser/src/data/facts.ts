import {
  type ApplicantFact,
  type ApplicantFactSensitivity,
  type ApplicantPolicy,
  type ApplicantProfile,
  applicantFactSchema,
  type FactConfidence,
  type FactSource,
} from "../contracts/applicant.ts";
import type { AuthorizedDocument } from "../contracts/documents.ts";
import type { JsonValue } from "../contracts/json.ts";
import type { AuthorizedDocumentId } from "../contracts/primitives.ts";
import {
  isCredentialLabel,
  isProtectedInferenceField,
  isRestrictedField,
} from "../contracts/redaction.ts";
import { fieldSensitivity, isUnsolicitedPersonalField } from "./fields.ts";

// The only derivations that may produce an `inferred` fact. CONTRACTS.md permits
// `inferred` for mechanical transformations only; enumerating them turns that sentence
// into something the store can check, so no caller can smuggle a judgement call through
// by writing a persuasive `method` string.
export const MECHANICAL_DERIVATIONS = [
  "normalize-phone",
  "normalize-email",
  "normalize-url",
  "normalize-date",
  "split-full-name",
  "join-name-parts",
  "years-from-date-range",
] as const;

export type MechanicalDerivation = (typeof MECHANICAL_DERIVATIONS)[number];

const MECHANICAL = new Set<string>(MECHANICAL_DERIVATIONS);

export function isMechanicalDerivation(method: string): method is MechanicalDerivation {
  return MECHANICAL.has(method);
}

export type FactRejectionReason =
  | "credential"
  | "restricted"
  | "solicitation"
  | "unknown-document"
  | "unknown-parent"
  | "non-mechanical-inference"
  | "protected-inference"
  | "duplicate-id"
  | "invalid";

export interface FactRejection {
  field: string;
  reason: FactRejectionReason;
  detail: string;
}

export interface FactCandidate {
  id?: string | undefined;
  field: string;
  value: JsonValue;
  source: FactSource;
  confidence: FactConfidence;
  sensitivity?: ApplicantFactSensitivity | undefined;
  allowedOrigins?: readonly string[] | undefined;
  updatedAt?: number | undefined;
}

export type FactAdmission =
  | { ok: true; fact: ApplicantFact }
  | { ok: false; rejection: FactRejection };

export interface DerivationInput {
  field: string;
  value: JsonValue;
  from: readonly string[];
  method: MechanicalDerivation;
  sensitivity?: ApplicantFactSensitivity | undefined;
  allowedOrigins?: readonly string[] | undefined;
  id?: string | undefined;
}

export interface FactProvenance {
  factId: string;
  field: string;
  kind: FactSource["kind"];
  // Every id on the path back to a stated fact, this one first.
  chain: string[];
  documentIds: AuthorizedDocumentId[];
  userStated: boolean;
  method?: string | undefined;
  grounded: boolean;
}

export interface FactStoreOptions {
  documents?: readonly AuthorizedDocument[] | undefined;
  policy?: ApplicantPolicy | undefined;
  now?: (() => number) | undefined;
}

// Read side of the store, so matching and planning can consume facts without holding a
// handle able to mutate them.
export interface FactLookup {
  get(id: string): ApplicantFact | undefined;
  byField(field: string): ApplicantFact[];
  factFor(field: string): ApplicantFact | undefined;
  documents(): AuthorizedDocument[];
  trace(fact: ApplicantFact): FactProvenance;
}

function rejection(field: string, reason: FactRejectionReason, detail: string): FactAdmission {
  return { ok: false, rejection: { field, reason, detail } };
}

export class FactStore implements FactLookup {
  readonly #facts = new Map<string, ApplicantFact>();
  // Policy answers are facts too, and a disclosure ledger has to be able to resolve the id
  // it recorded. They stay out of #facts because ApplicantProfile keeps `policy` and
  // `facts` separate, so they are indexed for lookup only.
  readonly #policyFacts = new Map<string, ApplicantFact>();
  readonly #documents = new Map<string, AuthorizedDocument>();
  readonly #now: () => number;
  #policy: ApplicantPolicy;
  #sequence = 0;

  constructor(options: FactStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#policy = options.policy ?? {};
    this.#indexPolicy();
    for (const document of options.documents ?? []) this.#documents.set(document.id, document);
  }

  #indexPolicy(): void {
    this.#policyFacts.clear();
    const policy = this.#policy;
    const facts = [
      policy.workAuthorization,
      policy.sponsorship,
      policy.relocation,
      policy.compensation,
      ...(policy.demographicAnswers ?? []),
    ];
    for (const fact of facts) {
      if (fact !== undefined) this.#policyFacts.set(fact.id, fact);
    }
  }

  addDocument(document: AuthorizedDocument): void {
    this.#documents.set(document.id, document);
  }

  documents(): AuthorizedDocument[] {
    return [...this.#documents.values()];
  }

  policy(): ApplicantPolicy {
    return this.#policy;
  }

  setPolicy(policy: ApplicantPolicy): void {
    this.#policy = policy;
    this.#indexPolicy();
  }

  add(candidate: FactCandidate): FactAdmission {
    const field = candidate.field.trim();
    if (field.length === 0) return rejection(candidate.field, "invalid", "a fact needs a field");
    if (isCredentialLabel(field)) {
      return rejection(field, "credential", "credentials are a takeover boundary, not a fact");
    }
    if (isRestrictedField(field)) {
      return rejection(field, "restricted", "restricted identifiers stay out of the profile");
    }
    if (isUnsolicitedPersonalField(field)) {
      return rejection(field, "solicitation", "this field is never grounded from applicant data");
    }
    if (candidate.confidence === "inferred") {
      if (candidate.source.kind !== "derived") {
        return rejection(field, "non-mechanical-inference", "an inferred fact must be derived");
      }
      if (!isMechanicalDerivation(candidate.source.method)) {
        return rejection(
          field,
          "non-mechanical-inference",
          `${candidate.source.method} is not a mechanical derivation`,
        );
      }
      if (isProtectedInferenceField(field)) {
        return rejection(
          field,
          "protected-inference",
          "legal status, identity, compensation, demographics and consent are never inferred",
        );
      }
    }
    if (candidate.source.kind === "document" && !this.#documents.has(candidate.source.documentId)) {
      return rejection(field, "unknown-document", `${candidate.source.documentId} is unauthorized`);
    }
    if (candidate.source.kind === "derived") {
      for (const parent of candidate.source.factIds) {
        if (!this.#facts.has(parent)) {
          return rejection(field, "unknown-parent", `derives from unknown fact ${parent}`);
        }
      }
    }
    const id = candidate.id ?? this.#mintId();
    if (this.get(id) !== undefined) {
      return rejection(field, "duplicate-id", `${id} is already stored`);
    }

    const draft: ApplicantFact = {
      id,
      field,
      value: candidate.value,
      source: candidate.source,
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity ?? fieldSensitivity(field),
      updatedAt: candidate.updatedAt ?? this.#now(),
      ...(candidate.allowedOrigins === undefined
        ? {}
        : { allowedOrigins: [...candidate.allowedOrigins] }),
    };
    const parsed = applicantFactSchema.safeParse(draft);
    if (!parsed.success) {
      return rejection(field, "invalid", parsed.error.issues[0]?.message ?? "invalid fact");
    }
    this.#facts.set(id, draft);
    return { ok: true, fact: draft };
  }

  derive(input: DerivationInput): FactAdmission {
    return this.add({
      ...(input.id === undefined ? {} : { id: input.id }),
      field: input.field,
      value: input.value,
      source: { kind: "derived", factIds: [...input.from], method: input.method },
      confidence: "inferred",
      ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
      ...(input.allowedOrigins === undefined ? {} : { allowedOrigins: input.allowedOrigins }),
    });
  }

  get(id: string): ApplicantFact | undefined {
    return this.#facts.get(id) ?? this.#policyFacts.get(id);
  }

  all(): ApplicantFact[] {
    return [...this.#facts.values()];
  }

  byField(field: string): ApplicantFact[] {
    return this.all().filter((fact) => fact.field === field);
  }

  // The single most recent fact for a field. Merge resolution is the caller's job when
  // more than one source disagrees; this returns undefined rather than picking a side.
  factFor(field: string): ApplicantFact | undefined {
    const facts = this.byField(field);
    let best: ApplicantFact | undefined;
    for (const fact of facts) {
      if (best === undefined || fact.updatedAt > best.updatedAt) best = fact;
    }
    return best;
  }

  trace(fact: ApplicantFact): FactProvenance {
    const chain: string[] = [];
    const documentIds: AuthorizedDocumentId[] = [];
    let userStated = false;
    let grounded = true;
    const seen = new Set<string>();
    const pending: ApplicantFact[] = [fact];
    while (pending.length > 0) {
      const current = pending.shift() as ApplicantFact;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      chain.push(current.id);
      switch (current.source.kind) {
        case "user":
          userStated = true;
          break;
        case "document":
          if (!documentIds.includes(current.source.documentId)) {
            documentIds.push(current.source.documentId);
          }
          if (!this.#documents.has(current.source.documentId)) grounded = false;
          break;
        case "derived":
          for (const parentId of current.source.factIds) {
            const parent = this.get(parentId);
            if (parent === undefined) grounded = false;
            else pending.push(parent);
          }
          break;
      }
    }
    return {
      factId: fact.id,
      field: fact.field,
      kind: fact.source.kind,
      chain,
      documentIds,
      userStated,
      grounded,
      ...(fact.source.kind === "derived" ? { method: fact.source.method } : {}),
    };
  }

  profile(): ApplicantProfile {
    return {
      version: 1,
      facts: this.all(),
      policy: this.#policy,
      documents: this.documents(),
    };
  }

  #mintId(): string {
    this.#sequence += 1;
    return `fact-${this.#sequence}`;
  }
}

export function createFactStore(options: FactStoreOptions = {}): FactStore {
  return new FactStore(options);
}

// Two values are the same answer when a form would accept either interchangeably.
// Deliberately narrow: casing and surrounding whitespace only, so "yes"/"no" and
// "120000"/"120,000" stay distinguishable as genuine disagreements.
export function sameFactValue(a: JsonValue, b: JsonValue): boolean {
  return normalizeValue(a) === normalizeValue(b);
}

function normalizeValue(value: JsonValue): string {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
  return JSON.stringify(value) ?? "null";
}

export function factValueText(value: JsonValue): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}
