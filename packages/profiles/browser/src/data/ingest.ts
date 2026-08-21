import type { AuthorizedDocument } from "../contracts/documents.ts";
import { BROWSER_LIMITS } from "../contracts/json.ts";
import type { AuthorizedDocumentId } from "../contracts/primitives.ts";
import type { FactCandidate } from "./facts.ts";
import { fieldSensitivity, isExtractableField } from "./fields.ts";

/**
 * BD11. A document is reference material written by someone else — for an uploaded resume,
 * often by the applicant, but the fixture ships one whose filename, PDF /Title and body all
 * carry instructions aimed at an agent. Extraction therefore never reads a directive, only
 * values matching a closed set of shapes, and reports what it refused so the refusal is
 * visible rather than silent.
 */
const INJECTION_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /\bignore\s+(?:all\s+|every\s+|any\s+)?(?:previous|prior|earlier|the user)/i,
    label: "instruction override",
  },
  { pattern: /\bdisregard\b/i, label: "instruction override" },
  {
    pattern: /\b(?:system|important)\s+(?:instruction|notice|prompt|message)/i,
    label: "forged system message",
  },
  {
    pattern: /\binstructions?\s+for\s+the\s+(?:ai|agent|assistant|automated)/i,
    label: "agent-directed instruction",
  },
  { pattern: /\b(?:assistant|agent|ai)\s*:/i, label: "forged role marker" },
  { pattern: /\bupload\s+the\s+file\b/i, label: "file exfiltration" },
  {
    pattern: /\breply\s+with\b|\bpaste\s+the\s+contents\b|\breveal\b/i,
    label: "data exfiltration",
  },
  {
    pattern: /\bcookies?\b|\bpassword\b|\bsystem\s+prompt\b|\bcredential/i,
    label: "credential solicitation",
  },
  { pattern: /(?:^|\s)(?:~\/|\/etc\/|\/root\/|[A-Za-z]:\\)/, label: "filesystem path" },
  { pattern: /\bdo not (?:mention|tell|inform)\b/i, label: "concealment" },
  { pattern: /\bwithout (?:asking|requesting|permission)\b/i, label: "approval bypass" },
];

export interface InjectionFinding {
  where: "basename" | "text";
  label: string;
  // The offending line, bounded, kept so a human can see what was quarantined. It is
  // never turned into a fact and never used as authority.
  excerpt: string;
}

const MAX_EXCERPT = 200;

export function detectInjection(
  value: string,
  where: InjectionFinding["where"],
): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (!pattern.test(value)) continue;
    if (findings.some((finding) => finding.label === label)) continue;
    findings.push({ where, label, excerpt: value.slice(0, MAX_EXCERPT) });
  }
  return findings;
}

function isDirective(line: string): boolean {
  return INJECTION_PATTERNS.some(({ pattern }) => pattern.test(line));
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/;
const URL = /\bhttps:\/\/[^\s<>"']+/;
const NAME = /^[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’.-]+){1,3}$/u;

interface Extraction {
  field: string;
  value: string;
  location: string;
  // A verbatim token of unambiguous shape is exact; anything read from position or
  // surrounding prose is uncertain, and a required field will not be filled from it.
  exact: boolean;
}

function extractFrom(lines: readonly string[]): Extraction[] {
  const found: Extraction[] = [];
  const claim = (field: string, value: string, location: string, exact: boolean): void => {
    if (found.some((entry) => entry.field === field)) return;
    found.push({ field, value, location, exact });
  };
  lines.forEach((line, index) => {
    const location = `line ${index + 1}`;
    const email = EMAIL.exec(line);
    if (email !== null) claim("email", email[0], location, true);
    const url = URL.exec(line);
    if (url !== null) {
      const value = url[0];
      const host = safeHost(value);
      if (host === undefined) {
        // not a usable URL
      } else if (host.endsWith("linkedin.com")) claim("linkedin_url", value, location, true);
      else if (host.endsWith("github.com")) claim("github_url", value, location, true);
      else claim("portfolio_url", value, location, true);
    }
    // A phone number is only credible when the line says so or holds nothing else; digits
    // inside a date range or an address are not a contact number.
    const withoutEmail = line.replace(EMAIL, " ").replace(URL, " ");
    const phone = PHONE.exec(withoutEmail);
    if (
      phone !== null &&
      /[+(]|\d[\s.-]\d/.test(phone[0]) &&
      phone[0].replace(/\D/g, "").length >= 7
    ) {
      claim("phone", phone[0].trim(), location, false);
    }
    const trimmed = line.trim();
    if (index < 5 && NAME.test(trimmed)) claim("full_name", trimmed, location, false);
  });
  return found;
}

function safeHost(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export interface DocumentIngestion {
  documentId: AuthorizedDocumentId;
  candidates: FactCandidate[];
  findings: InjectionFinding[];
  quarantinedLines: number;
  // The document text a model may see, with directive lines removed and the whole thing
  // tagged as reference material rather than instruction.
  referenceText: string;
  skipped: { field: string; reason: string }[];
}

export interface IngestOptions {
  maxChars?: number | undefined;
}

/**
 * Reads candidate facts out of an already-authorized document (BD16 — the caller supplies
 * an AuthorizedDocument, never a model-named path). Callers pass the candidates to
 * FactStore.add, which applies the credential/restricted/inference rules again.
 */
export function ingestDocument(
  document: AuthorizedDocument,
  options: IngestOptions = {},
): DocumentIngestion {
  const findings = detectInjection(document.basename, "basename");
  const skipped: { field: string; reason: string }[] = [];
  if (!document.purposes.includes("reference")) {
    return {
      documentId: document.id,
      candidates: [],
      findings,
      quarantinedLines: 0,
      referenceText: "",
      skipped: [{ field: "*", reason: "this document is authorized for upload only" }],
    };
  }
  const limit = options.maxChars ?? BROWSER_LIMITS.maxSnapshotChars;
  const raw = (document.extractedText ?? "").slice(0, limit);
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let quarantinedLines = 0;
  for (const line of lines) {
    if (isDirective(line)) {
      quarantinedLines += 1;
      for (const finding of detectInjection(line, "text")) {
        if (!findings.some((f) => f.where === "text" && f.label === finding.label)) {
          findings.push(finding);
        }
      }
      continue;
    }
    kept.push(line);
  }

  const candidates: FactCandidate[] = [];
  for (const extraction of extractFrom(kept)) {
    if (!isExtractableField(extraction.field)) {
      skipped.push({
        field: extraction.field,
        reason: "eligibility, compensation and demographic answers never come from a document",
      });
      continue;
    }
    candidates.push({
      field: extraction.field,
      value: extraction.value,
      source: { kind: "document", documentId: document.id, location: extraction.location },
      confidence: extraction.exact ? "exact" : "uncertain",
      sensitivity: fieldSensitivity(extraction.field),
    });
  }

  return {
    documentId: document.id,
    candidates,
    findings,
    quarantinedLines,
    referenceText: kept.join("\n").trim(),
    skipped,
  };
}

export function ingestDocuments(
  documents: readonly AuthorizedDocument[],
  options: IngestOptions = {},
): DocumentIngestion[] {
  return documents.map((document) => ingestDocument(document, options));
}
