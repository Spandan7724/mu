// The same permission decision, expressible without a terminal. PROJECT.md's
// SDK-first rule: the TUI is a consumer of the event stream, not a privileged path,
// so a headless or RPC caller receives the whole card as data and answers with a
// structured reply rather than a keystroke.
//
// The kernel's own reply vocabulary is `allow | deny` plus `remember`. This module
// owns the mapping in one place, including the clamp that stops a caller asking for
// authority the card does not offer (SECURITY §9).
import { z } from "zod";
import { assertJsonSerializable, BROWSER_LIMITS } from "../contracts/json.ts";
import { submitIntentSchema } from "../contracts/intent.ts";
import type { TakeoverReason } from "../contracts/takeover.ts";
import { BROWSER_SCOPES } from "../policy/scopes.ts";
import {
  type BrowserApprovalCard,
  type BrowserApprovalChoiceId,
  cardOffersChoice,
  renderApprovalCard,
} from "./card.ts";
import { assertNoSecretInLines } from "./text.ts";

export const BROWSER_APPROVAL_VERSION = 1;

const label = z.string().min(1).max(256);

const approvalFieldSchema = z.strictObject({
  label,
  sensitivity: z.enum(["public", "personal", "sensitive", "restricted"]),
  value: z.string().max(256).optional(),
  withheld: z.boolean(),
  provenance: z.string().max(256).optional(),
});

const approvalDocumentSchema = z.strictObject({
  documentId: label,
  basename: label,
  mimeType: z.string().min(1).max(256),
  bytes: z.number().int().nonnegative(),
  sha256Prefix: z.string().min(1).max(64),
});

export const browserApprovalChoiceSchema = z.enum([
  "review",
  "allow-once",
  "allow-task",
  "deny",
]);

export const browserApprovalRequestSchema = z
  .strictObject({
    version: z.literal(BROWSER_APPROVAL_VERSION),
    requestId: z.string().min(1).max(256),
    kind: z.enum(["navigate", "interact", "disclose", "upload", "submit", "unknown"]),
    action: label,
    origin: label,
    url: z.string().max(2_000).optional(),
    title: z.string().max(1_000).optional(),
    scopes: z.array(z.enum(BROWSER_SCOPES)).min(1),
    pattern: z.string().min(1).max(512),
    intent: submitIntentSchema.optional(),
    reversibility: z.enum(["reversible", "irreversible", "unknown"]),
    fields: z.array(approvalFieldSchema).max(1_000),
    suppressedFieldCount: z.number().int().nonnegative(),
    documents: z.array(approvalDocumentSchema).max(100),
    warnings: z.array(z.string().max(BROWSER_LIMITS.maxSummaryChars)).max(20),
    choices: z.array(browserApprovalChoiceSchema).min(1),
    previewComplete: z.boolean(),
    incompleteReasons: z.array(z.string().max(BROWSER_LIMITS.maxSummaryChars)).max(20),
    offersTaskScope: z.boolean(),
    preview: z.array(z.string().max(BROWSER_LIMITS.maxSummaryChars)).max(200),
  })
  .superRefine((request, ctx) => {
    // SECURITY §9 as a structural invariant: a request that could not produce a
    // preview must not travel with a task-scope offer, whoever assembled it.
    if (request.offersTaskScope && !request.previewComplete) {
      ctx.addIssue({
        code: "custom",
        path: ["offersTaskScope"],
        message: "an action without a complete preview is never offered as remembered",
      });
    }
    if (request.offersTaskScope !== request.choices.includes("allow-task")) {
      ctx.addIssue({
        code: "custom",
        path: ["choices"],
        message: "the offered choices and offersTaskScope must agree",
      });
    }
  });

export type BrowserApprovalRequest = z.infer<typeof browserApprovalRequestSchema>;

export class ApprovalRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequestError";
  }
}

/**
 * The wire form of a card. It carries the rendered preview alongside the structured
 * fields so a non-interactive caller can either decide from the data or show the
 * exact lines a terminal user would have seen.
 */
export function browserApprovalRequest(
  card: BrowserApprovalCard,
  requestId: string,
): BrowserApprovalRequest {
  const preview = renderApprovalCard(card);
  const request = {
    version: BROWSER_APPROVAL_VERSION as typeof BROWSER_APPROVAL_VERSION,
    requestId,
    kind: card.kind,
    action: card.action,
    origin: card.origin,
    ...(card.url === undefined ? {} : { url: card.url }),
    ...(card.title === undefined ? {} : { title: card.title }),
    scopes: [...card.scopes],
    pattern: card.pattern,
    ...(card.intent === undefined ? {} : { intent: card.intent }),
    reversibility: card.reversibility,
    fields: card.fields.map((field) => ({
      label: field.label,
      sensitivity: field.sensitivity,
      ...(field.value === undefined ? {} : { value: field.value }),
      withheld: field.withheld,
      ...(field.provenance === undefined ? {} : { provenance: field.provenance }),
    })),
    suppressedFieldCount: card.suppressedFieldCount,
    documents: card.documents.map((document) => ({ ...document })),
    warnings: [...card.warnings],
    choices: card.choices.map((choice) => choice.id),
    previewComplete: card.previewComplete,
    incompleteReasons: [...card.incompleteReasons],
    offersTaskScope: card.offersTaskScope,
    preview,
  };
  const parsed = browserApprovalRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new ApprovalRequestError(parsed.error.issues[0]?.message ?? "invalid approval request");
  }
  assertJsonSerializable(request, "browser approval request");
  // A structured event travels further than a terminal line, so the same gate
  // applies to it: a withheld value must not ride out on the wire either.
  assertNoSecretInLines(
    [JSON.stringify(request)],
    card.redactValues,
    "a browser approval request",
  );
  return parsed.data;
}

export const browserApprovalReplySchema = z.strictObject({
  requestId: z.string().min(1).max(256),
  outcome: browserApprovalChoiceSchema,
  note: z.string().max(1_000).optional(),
});

export type BrowserApprovalReply = z.infer<typeof browserApprovalReplySchema>;

export type ApprovalReplyParse =
  | { ok: true; reply: BrowserApprovalReply }
  | { ok: false; message: string };

export function parseBrowserApprovalReply(value: unknown): ApprovalReplyParse {
  const parsed = browserApprovalReplySchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "invalid approval reply" };
  }
  return { ok: true, reply: parsed.data };
}

export type ApprovalClampReason = "task-scope-not-offered" | "choice-not-offered";

export interface ApprovalResolution {
  /** What the kernel's permission callback is answered with. */
  outcome: "allow" | "deny";
  /** Task-scoped, never a saved preference: the browser profile has no persistence hook. */
  remember: boolean;
  /** The choice actually applied, after clamping. */
  applied: BrowserApprovalChoiceId;
  clamped?: ApprovalClampReason | undefined;
  /** Set when the user chose to operate the browser themselves instead. */
  takeover?: { reason: TakeoverReason; instructions: string } | undefined;
  message: string;
}

const REVIEW_INSTRUCTIONS =
  "Automation is paused. Check the page in the visible browser, edit anything you want to change, then resume — Mu will observe the page again before doing anything else.";

/**
 * A reply may always narrow authority and may never widen it. Asking for task scope
 * on a card that does not offer it is clamped to a single allowance rather than
 * rejected: refusing outright would strand a caller who read a stale request, while
 * escalating would defeat the rule the card exists to carry.
 */
export function resolveApprovalReply(
  card: BrowserApprovalCard,
  reply: BrowserApprovalReply,
): ApprovalResolution {
  if (reply.outcome === "deny") {
    return { outcome: "deny", remember: false, applied: "deny", message: "denied; nothing was sent" };
  }
  if (reply.outcome === "review") {
    if (!cardOffersChoice(card, "review")) {
      return {
        outcome: "deny",
        remember: false,
        applied: "deny",
        clamped: "choice-not-offered",
        message: "this action offers no browser review, so it was denied instead",
      };
    }
    return {
      outcome: "deny",
      remember: false,
      applied: "review",
      takeover: { reason: "user-requested", instructions: REVIEW_INSTRUCTIONS },
      message: "paused for you to review in the browser",
    };
  }
  if (reply.outcome === "allow-task" && !card.offersTaskScope) {
    return {
      outcome: "allow",
      remember: false,
      applied: "allow-once",
      clamped: "task-scope-not-offered",
      message: card.previewComplete
        ? "this action class always asks, so it was allowed once rather than for the task"
        : "the preview is incomplete, so it was allowed once rather than for the task",
    };
  }
  if (reply.outcome === "allow-task") {
    return {
      outcome: "allow",
      remember: true,
      applied: "allow-task",
      message: `allowed for this task on ${card.origin}; it expires with the task and is not saved`,
    };
  }
  return { outcome: "allow", remember: false, applied: "allow-once", message: "allowed once" };
}

/** Convenience for a headless host: parse, resolve, and say why in one step. */
export function decideHeadlessApproval(
  card: BrowserApprovalCard,
  value: unknown,
): { ok: true; resolution: ApprovalResolution } | { ok: false; message: string } {
  const parsed = parseBrowserApprovalReply(value);
  if (!parsed.ok) return parsed;
  return { ok: true, resolution: resolveApprovalReply(card, parsed.reply) };
}

/** The key a terminal user pressed, mapped to the same vocabulary as an RPC reply. */
export function choiceForKey(
  card: BrowserApprovalCard,
  key: string,
): BrowserApprovalChoiceId | undefined {
  const normalized = key.trim().toLowerCase();
  return card.choices.find((choice) => choice.key === normalized)?.id;
}
