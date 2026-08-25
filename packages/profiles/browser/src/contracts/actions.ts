import { z } from "zod";
import { type SubmitIntent, submitIntentSchema } from "./intent.ts";
import { BROWSER_LIMITS, type JsonValue, jsonValueSchema } from "./json.ts";
import {
  type BrowserElementRef,
  browserElementRefSchema,
  type ObservationRevision,
  observationRevisionSchema,
} from "./observation.ts";
import {
  type AuthorizedDocumentId,
  authorizedDocumentIdSchema,
  basenameSchema,
  identifierSchema,
  observedUrlSchema,
  sha256Schema,
  webUrlSchema,
} from "./primitives.ts";
import { type ReceiptCandidate, receiptCandidateSchema } from "./receipt.ts";

export interface ObserveRequest {
  tabId?: string | undefined;
  screenshot?: "none" | "viewport" | "full-page" | undefined;
  // Literal false: hidden nodes are never a requestable surface.
  includeHidden?: false | undefined;
  maxNodes?: number | undefined;
  maxTextChars?: number | undefined;
  /** INTERNAL: zero-based continuation into the canonical semantic element list. */
  sourceOffset?: number | undefined;
}

export const observeRequestSchema = z.strictObject({
  tabId: identifierSchema.optional(),
  screenshot: z.enum(["none", "viewport", "full-page"]).optional(),
  includeHidden: z.literal(false).optional(),
  maxNodes: z.number().int().positive().max(BROWSER_LIMITS.maxElements).optional(),
  maxTextChars: z.number().int().positive().max(BROWSER_LIMITS.maxSnapshotChars).optional(),
  sourceOffset: z
    .number()
    .int()
    .nonnegative()
    .max(BROWSER_LIMITS.maxSemanticSourceElements)
    .optional(),
});

export type NavigateRequest =
  | { kind: "url"; url: string; tabId?: string | undefined }
  | { kind: "back"; tabId?: string | undefined }
  | { kind: "forward"; tabId?: string | undefined }
  | { kind: "reload"; tabId?: string | undefined };

export const navigateRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("url"),
    url: webUrlSchema,
    tabId: identifierSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("back"), tabId: identifierSchema.optional() }),
  z.strictObject({ kind: z.literal("forward"), tabId: identifierSchema.optional() }),
  z.strictObject({ kind: z.literal("reload"), tabId: identifierSchema.optional() }),
]);

// BD12: no member of this union commits anything externally. Submission, sending,
// purchase, deletion, consent and account changes exist only on SubmitRequest.
export type BrowserAction =
  | { kind: "click"; target: BrowserElementRef; button?: "left" | "right" | undefined }
  | { kind: "fill"; target: BrowserElementRef; value: string; sourceFactId?: string | undefined }
  | { kind: "type"; target: BrowserElementRef; text: string; delayMs?: number | undefined }
  | { kind: "select"; target: BrowserElementRef; values: string[] }
  | { kind: "check"; target: BrowserElementRef }
  | { kind: "uncheck"; target: BrowserElementRef }
  | { kind: "press"; target?: BrowserElementRef | undefined; key: string }
  | { kind: "hover"; target: BrowserElementRef }
  | {
      kind: "scroll";
      target?: BrowserElementRef | undefined;
      deltaX: number;
      deltaY: number;
    }
  | { kind: "drag"; source: BrowserElementRef; target: BrowserElementRef };

export const browserActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("click"),
    target: browserElementRefSchema,
    button: z.enum(["left", "right"]).optional(),
  }),
  z.strictObject({
    kind: z.literal("fill"),
    target: browserElementRefSchema,
    value: z.string().max(BROWSER_LIMITS.maxElementTextChars),
    sourceFactId: identifierSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("type"),
    target: browserElementRefSchema,
    text: z.string().max(BROWSER_LIMITS.maxElementTextChars),
    delayMs: z.number().int().nonnegative().max(10_000).optional(),
  }),
  z.strictObject({
    kind: z.literal("select"),
    target: browserElementRefSchema,
    values: z
      .array(z.string().max(BROWSER_LIMITS.maxElementTextChars))
      .min(1)
      .max(BROWSER_LIMITS.maxOptionsPerElement),
  }),
  z.strictObject({ kind: z.literal("check"), target: browserElementRefSchema }),
  z.strictObject({ kind: z.literal("uncheck"), target: browserElementRefSchema }),
  z.strictObject({
    kind: z.literal("press"),
    target: browserElementRefSchema.optional(),
    key: z.string().min(1).max(64),
  }),
  z.strictObject({ kind: z.literal("hover"), target: browserElementRefSchema }),
  z.strictObject({
    kind: z.literal("scroll"),
    target: browserElementRefSchema.optional(),
    deltaX: z.number().int(),
    deltaY: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal("drag"),
    source: browserElementRefSchema,
    target: browserElementRefSchema,
  }),
]);

export function actionTargets(action: BrowserAction): BrowserElementRef[] {
  if (action.kind === "drag") return [action.source, action.target];
  return action.target === undefined ? [] : [action.target];
}

export function actionDisclosesValue(action: BrowserAction): boolean {
  return action.kind === "fill" || action.kind === "type" || action.kind === "select";
}

/**
 * A dialog the page raised while an action was in flight. It is never left pending: a
 * modal blocks every subsequent call, so a driver answers it within the action that
 * raised it and reports what it answered here. `message` is the page's own words and is
 * therefore untrusted — the question is written by whoever wrote the page.
 */
export interface BrowserDialog {
  // "unknown" when the browser announced a modal it did not classify. Guessing a kind
  // would be worse than saying so: the caller decides what to do about a dialog by
  // reading its message anyway.
  kind: "alert" | "confirm" | "prompt" | "beforeunload" | "unknown";
  message: string;
  handled: "dismissed" | "accepted";
}

export const browserDialogSchema = z.strictObject({
  kind: z.enum(["alert", "confirm", "prompt", "beforeunload", "unknown"]),
  message: z.string().max(BROWSER_LIMITS.maxSummaryChars),
  handled: z.enum(["dismissed", "accepted"]),
});

/**
 * Accepting a dialog is pre-authorized, never decided after the fact: by the time a
 * caller could react, the modal is already blocking the connection. `expectedMessage`
 * is the text the user was shown when they approved — a driver that meets a different
 * message dismisses instead, so acceptance can never be moved onto a question nobody
 * read.
 */
export interface DialogAcceptance {
  accept: true;
  expectedMessage: string;
  promptText?: string | undefined;
}

export const dialogAcceptanceSchema = z.strictObject({
  accept: z.literal(true),
  expectedMessage: z.string().min(1).max(BROWSER_LIMITS.maxSummaryChars),
  promptText: z.string().max(BROWSER_LIMITS.maxElementTextChars).optional(),
});

export interface SubmitRequest {
  target: BrowserElementRef;
  intent: SubmitIntent;
  expectedOutcome?: string | undefined;
  dialog?: DialogAcceptance | undefined;
}

export const submitRequestSchema = z.strictObject({
  target: browserElementRefSchema,
  intent: submitIntentSchema,
  expectedOutcome: z.string().max(BROWSER_LIMITS.maxSummaryChars).optional(),
  dialog: dialogAcceptanceSchema.optional(),
});

// BD16: ids only. The model never names a path, and a path-shaped id is rejected
// by authorizedDocumentIdSchema before the runtime ever resolves it.
export interface UploadRequest {
  target: BrowserElementRef;
  documentIds: AuthorizedDocumentId[];
}

export const uploadRequestSchema = z.strictObject({
  target: browserElementRefSchema,
  documentIds: z.array(authorizedDocumentIdSchema).min(1).max(20),
});

export type WaitCondition = "time" | "text" | "url" | "element" | "network-idle";

export interface WaitRequest {
  condition: WaitCondition;
  value?: string | number | BrowserElementRef | undefined;
  timeoutMs?: number | undefined;
}

export const MAX_WAIT_MS = 120_000;

export const waitRequestSchema = z
  .strictObject({
    condition: z.enum(["time", "text", "url", "element", "network-idle"]),
    value: z
      .union([
        z.string().max(BROWSER_LIMITS.maxElementTextChars),
        z.number(),
        browserElementRefSchema,
      ])
      .optional(),
    timeoutMs: z.number().int().positive().max(MAX_WAIT_MS).optional(),
  })
  .superRefine((request, ctx) => {
    const { condition, value } = request;
    const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["value"], message });
    switch (condition) {
      case "time":
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          issue("waiting for time needs a non-negative millisecond value");
        }
        break;
      case "text":
      case "url":
        if (typeof value !== "string" || value.length === 0) {
          issue(`waiting for ${condition} needs a non-empty string`);
        }
        break;
      case "element":
        if (typeof value !== "object" || value === null) {
          issue("waiting for an element needs an element reference");
        }
        break;
      case "network-idle":
        if (value !== undefined) issue("network-idle takes no value");
        break;
    }
  });

export type ActionStatus = "completed" | "blocked" | "stale" | "takeover" | "unknown" | "failed";

export const actionStatusSchema = z.enum([
  "completed",
  "blocked",
  "stale",
  "takeover",
  "unknown",
  "failed",
]);

export interface ActionSnapshot {
  tabId: string;
  revision: ObservationRevision;
  url: string;
}

export interface ActionResultSnapshot extends ActionSnapshot {
  title: string;
}

export interface ActionNavigation {
  from: string;
  to: string;
  newOrigin?: boolean | undefined;
}

export interface ActionOutcome {
  ok: boolean;
  status: ActionStatus;
  message: string;
  before: ActionSnapshot;
  after?: ActionResultSnapshot | undefined;
  navigation?: ActionNavigation | undefined;
  receiptCandidate?: ReceiptCandidate | undefined;
  dialog?: BrowserDialog | undefined;
  details?: JsonValue | undefined;
}

const actionSnapshotSchema = z.strictObject({
  tabId: identifierSchema,
  revision: observationRevisionSchema,
  url: observedUrlSchema,
});

// A download is reported by metadata only. Downloaded bytes are untrusted, stay in
// the private artifact root, and their location is never model-visible, so this
// shape deliberately has nowhere to put a filesystem path.
export interface BrowserDownload {
  basename: string;
  mimeType?: string | undefined;
  bytes?: number | undefined;
  sha256?: string | undefined;
}

export const browserDownloadSchema = z.strictObject({
  basename: basenameSchema,
  mimeType: z.string().min(1).max(256).optional(),
  bytes: z.number().int().nonnegative().optional(),
  sha256: sha256Schema.optional(),
});

export const downloadDetailsSchema = z.strictObject({ download: browserDownloadSchema });

export function downloadDetails(download: BrowserDownload): JsonValue {
  return downloadDetailsSchema.parse({ download }) as unknown as JsonValue;
}

export function readDownloadDetails(details: JsonValue | undefined): BrowserDownload | undefined {
  const parsed = downloadDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data.download : undefined;
}

export const actionOutcomeSchema = z
  .strictObject({
    ok: z.boolean(),
    status: actionStatusSchema,
    message: z.string().min(1).max(BROWSER_LIMITS.maxSummaryChars),
    before: actionSnapshotSchema,
    after: actionSnapshotSchema
      .extend({ title: z.string().max(BROWSER_LIMITS.maxElementTextChars) })
      .optional(),
    navigation: z
      .strictObject({
        from: observedUrlSchema,
        to: observedUrlSchema,
        newOrigin: z.boolean().optional(),
      })
      .optional(),
    receiptCandidate: receiptCandidateSchema.optional(),
    dialog: browserDialogSchema.optional(),
    details: jsonValueSchema.optional(),
  })
  .superRefine((outcome, ctx) => {
    // `unknown` is representable and is never success: BD18 forbids a caller from
    // reading `ok` and retrying.
    if (outcome.ok !== (outcome.status === "completed")) {
      ctx.addIssue({
        code: "custom",
        path: ["ok"],
        message: "ok is true exactly when status is completed",
      });
    }
  });

export interface ActionOutcomeInit {
  message: string;
  before: ActionSnapshot;
  after?: ActionResultSnapshot | undefined;
  navigation?: ActionNavigation | undefined;
  receiptCandidate?: ReceiptCandidate | undefined;
  dialog?: BrowserDialog | undefined;
  details?: JsonValue | undefined;
}

function outcome(status: ActionStatus, init: ActionOutcomeInit): ActionOutcome {
  return {
    ok: status === "completed",
    status,
    message: init.message,
    before: init.before,
    ...(init.after === undefined ? {} : { after: init.after }),
    ...(init.navigation === undefined ? {} : { navigation: init.navigation }),
    ...(init.receiptCandidate === undefined ? {} : { receiptCandidate: init.receiptCandidate }),
    ...(init.dialog === undefined ? {} : { dialog: init.dialog }),
    ...(init.details === undefined ? {} : { details: init.details }),
  };
}

export const completedOutcome = (init: ActionOutcomeInit): ActionOutcome =>
  outcome("completed", init);
export const blockedOutcome = (init: ActionOutcomeInit): ActionOutcome => outcome("blocked", init);
export const staleOutcome = (init: ActionOutcomeInit): ActionOutcome => outcome("stale", init);
export const takeoverOutcome = (init: ActionOutcomeInit): ActionOutcome =>
  outcome("takeover", init);
export const failedOutcome = (init: ActionOutcomeInit): ActionOutcome => outcome("failed", init);
export const unknownOutcome = (init: ActionOutcomeInit): ActionOutcome => outcome("unknown", init);

export function isUnknownOutcome(value: ActionOutcome): boolean {
  return value.status === "unknown";
}

// BD18: an uncertain commitment is reconciled by observation, never by retrying.
export function mayRetry(value: ActionOutcome): boolean {
  return value.status !== "unknown";
}

export function requiresReconciliation(value: ActionOutcome): boolean {
  return value.status === "unknown";
}
