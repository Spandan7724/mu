// DESIGN.md §Permission Experience, made into a value. The policy layer already
// decided *whether* to ask; this decides what the person is shown when it does.
//
// Two rules here are load-bearing rather than presentational:
//
//  1. SECURITY §9 — if the preview cannot be produced, the action cannot be offered
//     as remembered or automatic. `previewComplete === false` removes the
//     task-scope choice structurally, not by convention.
//  2. SECURITY §8/§11 — no password, one-time code, cookie, token or full hidden
//     value reaches a rendered line, compact or expanded.
import type { ApplicantFact, Sensitivity } from "../contracts/applicant.ts";
import type { AuthorizedDocumentSummary } from "../contracts/documents.ts";
import type { SubmitIntent } from "../contracts/intent.ts";
import {
  type BrowserElement,
  type BrowserObservation,
  isCredentialElement,
} from "../contracts/observation.ts";
import { isRestrictedField } from "../contracts/redaction.ts";
import { describeOrigin } from "../policy/origin.ts";
import { classifyElement } from "../policy/risk.ts";
import {
  type BrowserScope,
  NEVER_AUTO_ALLOWED_SCOPES,
  sanitizePatternPart,
  UNKNOWN_ORIGIN_PATTERN,
} from "../policy/scopes.ts";
import {
  boundedList,
  bytesLabel,
  clampLine,
  countLabel,
  joinParts,
  partitionRenderableFields,
  RENDER_LIMITS,
  safeLines,
  shaPrefix,
} from "./text.ts";

export type BrowserApprovalKind =
  | "navigate"
  | "interact"
  | "disclose"
  | "upload"
  | "submit"
  | "unknown";

/** Ordered as they are offered, so focus order is stable across every card. */
export type BrowserApprovalChoiceId = "review" | "allow-once" | "allow-task" | "deny";

export interface BrowserApprovalChoice {
  id: BrowserApprovalChoiceId;
  /** Single, unmodified key. Keyboard-only operation is a requirement, not a nicety. */
  key: string;
  label: string;
  detail: string;
}

/**
 * There is no `default` and no `expiresAt` on a choice, and no timer anywhere in
 * this module: DESIGN.md forbids a countdown or a pre-selected answer that
 * pressures approval, and the shape is where that is enforced.
 */
const CHOICES: Readonly<Record<BrowserApprovalChoiceId, BrowserApprovalChoice>> = {
  review: {
    id: "review",
    key: "r",
    label: "review in browser",
    detail: "pauses automation and hands you the visible browser",
  },
  "allow-once": {
    id: "allow-once",
    key: "a",
    label: "allow once",
    detail: "this action only",
  },
  "allow-task": {
    id: "allow-task",
    key: "t",
    label: "allow for this task",
    detail: "expires with this task; never a saved preference",
  },
  deny: { id: "deny", key: "d", label: "deny", detail: "nothing is sent" },
};

export type Reversibility = "reversible" | "irreversible" | "unknown";

const REVERSIBILITY_LABEL: Record<Reversibility, string> = {
  reversible: "reversible · Mu can change this back on the page",
  irreversible: "irreversible · Mu cannot undo this once it is sent",
  unknown: "reversibility unknown · treat it as irreversible",
};

export interface BrowserApprovalField {
  label: string;
  sensitivity: Sensitivity;
  /** Absent whenever the value is withheld; there is no field to leak into. */
  value?: string | undefined;
  withheld: boolean;
  provenance?: string | undefined;
}

export interface BrowserApprovalDocument {
  documentId: string;
  basename: string;
  mimeType: string;
  bytes: number;
  sha256Prefix: string;
}

export interface BrowserApprovalCard {
  kind: BrowserApprovalKind;
  /** User-level verb, never a Playwright or DOM term (DESIGN invariant 6). */
  action: string;
  /** SECURITY §6: the whole origin, never collapsed to a brand name. */
  origin: string;
  url?: string | undefined;
  title?: string | undefined;
  scopes: readonly BrowserScope[];
  pattern: string;
  intent?: SubmitIntent | undefined;
  reversibility: Reversibility;
  fields: readonly BrowserApprovalField[];
  /** Field names that exist but are never named on screen (credential-shaped). */
  suppressedFieldCount: number;
  documents: readonly BrowserApprovalDocument[];
  warnings: readonly string[];
  choices: readonly BrowserApprovalChoice[];
  previewComplete: boolean;
  incompleteReasons: readonly string[];
  /** SECURITY §9: false whenever the preview is incomplete or the scope may never auto-allow. */
  offersTaskScope: boolean;
  /** Values that must not survive into any rendered line. */
  redactValues: readonly string[];
}

export function cardOffersChoice(
  card: BrowserApprovalCard,
  choice: BrowserApprovalChoiceId,
): boolean {
  return card.choices.some((candidate) => candidate.id === choice);
}

function displayOrigin(origin: string | undefined): { origin: string; warnings: string[] } {
  if (origin === undefined || origin.length === 0) {
    return {
      origin: UNKNOWN_ORIGIN_PATTERN,
      warnings: ["the page has no usable web origin, so the destination cannot be shown"],
    };
  }
  const display = describeOrigin(origin);
  return { origin: display.display, warnings: [...display.warnings] };
}

function elementLabel(element: BrowserElement | undefined): string | undefined {
  const raw = element?.label ?? element?.name ?? element?.role;
  return raw === undefined ? undefined : sanitizePatternPart(raw);
}

/**
 * A page-authored option label is shown, never trusted; a credential-shaped field
 * is not shown at all. Sensitive and restricted values are withheld: DESIGN's
 * review view names what was used, and the browser shows the value itself.
 */
export function approvalField(input: {
  label: string;
  sensitivity: Sensitivity;
  value?: string | undefined;
  provenance?: string | undefined;
}): BrowserApprovalField | undefined {
  const label = sanitizePatternPart(input.label);
  if (label === undefined) return undefined;
  const { renderable } = partitionRenderableFields([label]);
  if (renderable.length === 0) return undefined;
  const withheld =
    input.value === undefined ||
    input.sensitivity === "sensitive" ||
    input.sensitivity === "restricted" ||
    isRestrictedField(label);
  return {
    label,
    sensitivity: input.sensitivity,
    withheld,
    ...(withheld ? {} : { value: clampLine(input.value as string, 120) }),
    ...(input.provenance === undefined ? {} : { provenance: clampLine(input.provenance, 120) }),
  };
}

export function fieldFromFact(fact: ApplicantFact, label?: string): BrowserApprovalField | undefined {
  const provenance =
    fact.source.kind === "document"
      ? `from ${fact.source.documentId}`
      : fact.source.kind === "user"
        ? "you told Mu"
        : `derived · ${fact.source.method}`;
  return approvalField({
    label: label ?? fact.field,
    sensitivity: fact.sensitivity,
    ...(typeof fact.value === "string" ? { value: fact.value } : {}),
    provenance,
  });
}

export function documentSummaryForCard(
  document: AuthorizedDocumentSummary,
): BrowserApprovalDocument {
  return {
    documentId: document.id,
    basename: document.basename,
    mimeType: document.mimeType,
    bytes: document.bytes,
    sha256Prefix: shaPrefix(document.sha256),
  };
}

export interface ApprovalCardInput {
  kind: BrowserApprovalKind;
  action: string;
  scopes: readonly BrowserScope[];
  pattern: string;
  origin?: string | undefined;
  url?: string | undefined;
  title?: string | undefined;
  intent?: SubmitIntent | undefined;
  reversibility?: Reversibility | undefined;
  fields?: readonly (BrowserApprovalField | undefined)[] | undefined;
  suppressedFieldCount?: number | undefined;
  documents?: readonly BrowserApprovalDocument[] | undefined;
  warnings?: readonly string[] | undefined;
  /** Anything the runtime could not establish. Non-empty means no task scope. */
  incompleteReasons?: readonly string[] | undefined;
  offerReview?: boolean | undefined;
  redactValues?: readonly string[] | undefined;
}

export function buildApprovalCard(input: ApprovalCardInput): BrowserApprovalCard {
  const origin = displayOrigin(input.origin);
  const fields = (input.fields ?? []).filter(
    (field): field is BrowserApprovalField => field !== undefined,
  );
  const incompleteReasons = [...(input.incompleteReasons ?? []), ...(input.origin === undefined ? origin.warnings.slice(0, 1) : [])];
  const previewComplete = incompleteReasons.length === 0;
  const neverAuto = input.scopes.some((scope) => NEVER_AUTO_ALLOWED_SCOPES.includes(scope));
  const offersTaskScope = previewComplete && !neverAuto;

  const warnings = [
    ...origin.warnings,
    ...(input.warnings ?? []),
    ...(neverAuto
      ? ["this action class always asks; it can never be pre-authorized for a task"]
      : []),
    ...incompleteReasons.map(
      (reason) => `${reason} — so this cannot be allowed for the whole task`,
    ),
  ];

  const choices: BrowserApprovalChoice[] = [
    ...(input.offerReview === false ? [] : [CHOICES.review]),
    CHOICES["allow-once"],
    ...(offersTaskScope ? [CHOICES["allow-task"]] : []),
    CHOICES.deny,
  ];

  return {
    kind: input.kind,
    action: clampLine(input.action, 160),
    origin: origin.origin,
    ...(input.url === undefined ? {} : { url: clampLine(input.url, 300) }),
    ...(input.title === undefined ? {} : { title: clampLine(input.title, 160) }),
    scopes: [...input.scopes],
    pattern: input.pattern,
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    reversibility: input.reversibility ?? "unknown",
    fields,
    suppressedFieldCount: input.suppressedFieldCount ?? 0,
    documents: [...(input.documents ?? [])],
    warnings: [...new Set(warnings)].slice(0, RENDER_LIMITS.maxWarnings),
    choices,
    previewComplete,
    incompleteReasons: [...new Set(incompleteReasons)],
    offersTaskScope,
    redactValues: [...new Set(input.redactValues ?? [])],
  };
}

const NAVIGATION_REVERSIBILITY: Reversibility = "reversible";

export interface NavigateCardInput {
  scopes: readonly BrowserScope[];
  pattern: string;
  destinationUrl: string;
  destinationOrigin?: string | undefined;
  fromUrl?: string | undefined;
  /** Link or control text that led here. Page-authored: shown, never trusted. */
  label?: string | undefined;
  reasons?: readonly string[] | undefined;
}

export function navigateApprovalCard(input: NavigateCardInput): BrowserApprovalCard {
  const label = sanitizePatternPart(input.label);
  return buildApprovalCard({
    kind: "navigate",
    action: joinParts(["open a new origin", label === undefined ? undefined : `from "${label}"`]),
    scopes: input.scopes,
    pattern: input.pattern,
    ...(input.destinationOrigin === undefined ? {} : { origin: input.destinationOrigin }),
    url: input.destinationUrl,
    reversibility: NAVIGATION_REVERSIBILITY,
    warnings: [
      ...(input.reasons ?? []),
      ...(input.fromUrl === undefined ? [] : [`leaving ${input.fromUrl}`]),
    ],
    ...(input.destinationOrigin === undefined
      ? { incompleteReasons: ["the destination origin could not be normalized"] }
      : {}),
  });
}

export interface InteractCardInput {
  scopes: readonly BrowserScope[];
  pattern: string;
  observation: BrowserObservation;
  element?: BrowserElement | undefined;
  actionVerb: string;
  fields?: readonly (BrowserApprovalField | undefined)[] | undefined;
  reasons?: readonly string[] | undefined;
  redactValues?: readonly string[] | undefined;
}

export function interactApprovalCard(input: InteractCardInput): BrowserApprovalCard {
  const label = elementLabel(input.element);
  const disclosing = input.scopes.includes("browser:disclose");
  const incomplete: string[] = [];
  if (input.element === undefined) incomplete.push("the target control could not be resolved");
  if (label === undefined && input.element !== undefined) {
    incomplete.push("the control has no accessible name to show you");
  }
  const classification = input.element === undefined ? undefined : classifyElement(input.element);
  return buildApprovalCard({
    kind: disclosing ? "disclose" : "interact",
    action: joinParts([input.actionVerb, label]),
    scopes: input.scopes,
    pattern: input.pattern,
    ...(input.observation.origin === undefined ? {} : { origin: input.observation.origin }),
    url: input.observation.url,
    title: input.observation.title,
    reversibility: "reversible",
    ...(input.fields === undefined ? {} : { fields: input.fields }),
    warnings: [...(input.reasons ?? []), ...(classification?.reasons ?? [])],
    incompleteReasons: incomplete,
    ...(input.redactValues === undefined ? {} : { redactValues: input.redactValues }),
  });
}

export interface UploadCardInput {
  scopes: readonly BrowserScope[];
  pattern: string;
  observation: BrowserObservation;
  element?: BrowserElement | undefined;
  documents: readonly AuthorizedDocumentSummary[];
  /** Ids the runtime could not resolve to an authorized document. */
  unresolvedDocumentIds?: readonly string[] | undefined;
  reasons?: readonly string[] | undefined;
}

export function uploadApprovalCard(input: UploadCardInput): BrowserApprovalCard {
  const label = elementLabel(input.element);
  const incomplete: string[] = [];
  if (input.element === undefined) incomplete.push("the file field could not be resolved");
  for (const id of input.unresolvedDocumentIds ?? []) {
    incomplete.push(`${id} is not an authorized document`);
  }
  if (input.documents.length === 0) incomplete.push("no authorized document was resolved");
  return buildApprovalCard({
    kind: "upload",
    action: joinParts([
      `attach ${countLabel(input.documents.length, "document")}`,
      label === undefined ? undefined : `to ${label}`,
    ]),
    scopes: input.scopes,
    pattern: input.pattern,
    ...(input.observation.origin === undefined ? {} : { origin: input.observation.origin }),
    url: input.observation.url,
    title: input.observation.title,
    reversibility: "unknown",
    documents: input.documents.map(documentSummaryForCard),
    warnings: input.reasons ?? [],
    incompleteReasons: incomplete,
  });
}

const INTENT_ACTION: Record<SubmitIntent, string> = {
  "submit-form": "submit this form",
  send: "send this message",
  purchase: "complete this purchase",
  delete: "delete this",
  consent: "accept these terms",
  "account-change": "change this account",
};

export interface SubmitCardInput {
  scopes: readonly BrowserScope[];
  pattern: string;
  intent: SubmitIntent;
  observation: BrowserObservation;
  element?: BrowserElement | undefined;
  /** Field names disclosed to this origin during the task, in disclosure order. */
  disclosedFieldNames?: readonly string[] | undefined;
  fields?: readonly (BrowserApprovalField | undefined)[] | undefined;
  documents?: readonly AuthorizedDocumentSummary[] | undefined;
  /** Charge shown by the page for a purchase. Page-authored; shown, never trusted. */
  expectedCharge?: string | undefined;
  /** Validation failures and anything the agent is unsure about. */
  validationWarnings?: readonly string[] | undefined;
  unansweredFields?: readonly string[] | undefined;
  reasons?: readonly string[] | undefined;
  redactValues?: readonly string[] | undefined;
}

/**
 * TOOLS.md `browser_submit`: origin, URL and title; the action name; the form
 * summary; the fields disclosed during this task redacted by sensitivity; uploaded
 * filenames; an expected charge where the page shows one; and any uncertainty.
 * Anything missing lands in `incompleteReasons`, which is what withdraws the
 * task-scope offer.
 */
export function submitApprovalCard(input: SubmitCardInput): BrowserApprovalCard {
  const label = elementLabel(input.element);
  const incomplete: string[] = [];
  if (input.element === undefined) {
    incomplete.push("the control that performs this action could not be resolved");
  } else if (isCredentialElement(input.element)) {
    incomplete.push("the target is an authentication control and belongs to you, not to Mu");
  }
  if (label === undefined && input.element !== undefined) {
    incomplete.push("the control has no accessible name to show you");
  }
  if (input.observation.origin === undefined) {
    incomplete.push("the page has no usable web origin");
  }
  if (input.intent === "purchase" && input.expectedCharge === undefined) {
    incomplete.push("the page does not show the amount that would be charged");
  }

  const disclosed = partitionRenderableFields(input.disclosedFieldNames ?? []);
  const warnings = [
    ...(input.reasons ?? []),
    ...(input.validationWarnings ?? []),
    ...((input.unansweredFields ?? []).length === 0
      ? []
      : [
          `unanswered or ambiguous: ${boundedList([...(input.unansweredFields ?? [])]).join(", ")}`,
        ]),
    ...(disclosed.suppressed > 0
      ? [
          `${countLabel(disclosed.suppressed, "field")} the page treats as a credential are not listed and were never filled by Mu`,
        ]
      : []),
  ];

  return buildApprovalCard({
    kind: "submit",
    action: joinParts([INTENT_ACTION[input.intent], label === undefined ? undefined : `· "${label}"`]),
    scopes: input.scopes,
    pattern: input.pattern,
    ...(input.observation.origin === undefined ? {} : { origin: input.observation.origin }),
    url: input.observation.url,
    title: input.observation.title,
    intent: input.intent,
    reversibility: "irreversible",
    ...(input.fields === undefined
      ? {
          fields: disclosed.renderable.map((name) =>
            approvalField({ label: name, sensitivity: "personal" }),
          ),
        }
      : { fields: input.fields }),
    suppressedFieldCount: disclosed.suppressed,
    documents: (input.documents ?? []).map(documentSummaryForCard),
    warnings: [
      ...warnings,
      ...(input.expectedCharge === undefined
        ? []
        : [`the page shows a charge of ${clampLine(input.expectedCharge, 80)}`]),
    ],
    incompleteReasons: incomplete,
    ...(input.redactValues === undefined ? {} : { redactValues: input.redactValues }),
  });
}

function fieldLine(field: BrowserApprovalField): string {
  return joinParts([
    field.label,
    field.withheld ? "withheld · shown in the browser only" : field.value,
    field.sensitivity,
    field.provenance,
  ]);
}

/**
 * DESIGN.md's approval card, in Mu's transcript grammar: the action and the whole
 * origin first, the material facts next, the choices last so that a long URL or a
 * long field list wraps above them and never hides them.
 */
export function renderApprovalCard(card: BrowserApprovalCard): string[] {
  const lines: string[] = [joinParts([card.action, card.origin])];
  if (card.url !== undefined && card.url !== card.origin) lines.push(card.url);
  if (card.title !== undefined) lines.push(joinParts(["page", card.title]));
  lines.push(REVERSIBILITY_LABEL[card.reversibility]);

  if (card.fields.length > 0) {
    lines.push(joinParts(["fields", countLabel(card.fields.length, "field")]));
    for (const line of boundedList(card.fields.map(fieldLine))) lines.push(`  ${line}`);
  }
  if (card.suppressedFieldCount > 0) {
    lines.push(
      `${countLabel(card.suppressedFieldCount, "credential field")} are not named here and were never filled by Mu`,
    );
  }
  if (card.documents.length > 0) {
    lines.push(joinParts(["documents", countLabel(card.documents.length, "file")]));
    for (const document of card.documents.slice(0, RENDER_LIMITS.maxListItems)) {
      lines.push(
        `  ${joinParts([
          document.basename,
          document.mimeType,
          bytesLabel(document.bytes),
          `sha256 ${document.sha256Prefix}`,
        ])}`,
      );
    }
  }
  for (const warning of card.warnings) lines.push(joinParts(["warning", warning]));
  if (!card.previewComplete) {
    lines.push("preview incomplete · this action cannot be allowed for the whole task");
  }
  lines.push(
    joinParts(card.choices.map((choice) => `[${choice.key}] ${choice.label}`)),
  );
  for (const choice of card.choices) {
    lines.push(`  ${joinParts([choice.label, choice.detail])}`);
  }
  return safeLines(lines, card.redactValues, "an approval card");
}

/**
 * The kernel-facing projection. `PermissionRequest.preview` is what the TUI overlay,
 * the `permission_asked` event and every RPC client already receive, so the card
 * reaches all three surfaces through one seam rather than a privileged terminal path.
 */
export function approvalPermissionDetails(card: BrowserApprovalCard): {
  description: string;
  preview: { kind: "text"; lines: string[] };
} {
  return {
    description: joinParts([card.action, card.origin]),
    preview: { kind: "text", lines: renderApprovalCard(card) },
  };
}
