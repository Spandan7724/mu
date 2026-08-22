// DESIGN.md's browser tool-cell table. Cells speak user-level verbs — observed,
// opened, filled, attached, submitted — and expose URLs, revisions, provenance and
// approval scope only on expansion. Playwright and DOM vocabulary never appear
// (DESIGN invariant 6).
//
// Written against the kernel's `ToolRenderer`, which returns plain strings, so the
// profile keeps its dependency direction (profile → sdk → core) and the terminal
// keeps ownership of colour. Every state is therefore carried by a word, which is
// also what DESIGN §Accessibility requires.
import type { ToolRenderer, ToolResult } from "@mu/core";
import { z } from "zod";
import { RECEIPT_STATUS_SUMMARY, receiptStatusSchema } from "../contracts/receipt.ts";
import { BROWSER_STATUS_TOOL } from "../profile/tools.ts";
import { boundedList, bytesLabel, clampLine, joinParts, RENDER_LIMITS, safeLines } from "./text.ts";

// TOOLS.md is normative for these names. They are declared here rather than
// imported so a renderer never becomes a build dependency of the tool layer.
export const BROWSER_TOOL_NAMES = {
  observe: "browser_observe",
  navigate: "browser_navigate",
  tabs: "browser_tabs",
  act: "browser_act",
  upload: "browser_upload",
  submit: "browser_submit",
  wait: "browser_wait",
  takeover: "browser_takeover",
} as const;

/**
 * The optional structured detail a browser tool may attach to its result. Every
 * field is optional: a cell degrades to the result's own text when a tool supplies
 * nothing, which is what keeps this renderer independent of the tool layer's
 * internals. Nothing here can hold a value — only labels, counts and identifiers.
 */
export const browserCellDetailsSchema = z
  .object({
    kind: z
      .enum(["observe", "navigate", "act", "upload", "submit", "wait", "takeover", "tabs"])
      .optional(),
    title: z.string().max(400).optional(),
    url: z.string().max(2_000).optional(),
    finalUrl: z.string().max(2_000).optional(),
    origin: z.string().max(400).optional(),
    frame: z.string().max(200).optional(),
    revision: z.number().int().nonnegative().optional(),
    controlCount: z.number().int().nonnegative().optional(),
    redirects: z.array(z.string().max(2_000)).max(20).optional(),
    fieldLabel: z.string().max(400).optional(),
    fieldLabels: z.array(z.string().max(400)).max(200).optional(),
    provenance: z.string().max(400).optional(),
    validation: z.string().max(400).optional(),
    option: z.string().max(400).optional(),
    selected: z.string().max(400).optional(),
    documents: z
      .array(
        z.object({
          documentId: z.string().max(200),
          basename: z.string().max(400),
          mimeType: z.string().max(200).optional(),
          bytes: z.number().int().nonnegative().optional(),
        }),
      )
      .max(50)
      .optional(),
    condition: z.string().max(200).optional(),
    deadlineMs: z.number().int().nonnegative().optional(),
    lastObserved: z.string().max(400).optional(),
    approvalScope: z.string().max(200).optional(),
    approvalGrant: z.enum(["allow-once", "allow-task", "mode"]).optional(),
    receiptId: z.string().max(200).optional(),
    receiptStatus: receiptStatusSchema.optional(),
    evidence: z.array(z.string().max(400)).max(20).optional(),
    takeoverReason: z.string().max(100).optional(),
    resumeCriteria: z.string().max(400).optional(),
    warnings: z.array(z.string().max(400)).max(20).optional(),
    tabs: z
      .array(
        z.object({
          id: z.string().max(200),
          title: z.string().max(400).optional(),
          url: z.string().max(2_000).optional(),
          active: z.boolean().optional(),
          attached: z.boolean().optional(),
        }),
      )
      .max(200)
      .optional(),
  })
  .strip();

export type BrowserCellDetails = z.infer<typeof browserCellDetailsSchema>;

export function browserCellDetails(result: ToolResult | undefined): BrowserCellDetails {
  const parsed = browserCellDetailsSchema.safeParse(result?.details ?? {});
  return parsed.success ? parsed.data : {};
}

export function resultLines(result: ToolResult | undefined): string[] {
  return (result?.content ?? [])
    .map((block) =>
      block.type === "text" ? block.text : `[image · ${block.mimeType} · not shown here]`,
    )
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function headline(fallback: string, lines: readonly string[]): string {
  return clampLine(lines[0] ?? fallback);
}

function detailLines(details: BrowserCellDetails, own: readonly (string | undefined)[]): string[] {
  const warnings = (details.warnings ?? []).map((warning) => joinParts(["warning", warning]));
  return [...own, ...warnings].filter(
    (line): line is string => line !== undefined && line.length > 0,
  );
}

/**
 * A cell is compact by default and expands in place. The compact head is always
 * present, so a truncated terminal still shows what happened; the detail rows are
 * indented under it rather than replacing it.
 */
function cell(head: string, details: readonly string[]): string[] {
  return safeLines(
    [head, ...details.slice(0, RENDER_LIMITS.maxCellLines).map((line) => `  ${line}`)],
    [],
    "a browser tool cell",
  );
}

function observeCell(result: ToolResult | undefined): string[] {
  const details = browserCellDetails(result);
  const lines = resultLines(result);
  const head = joinParts([
    "observed",
    details.title ?? headline("a page", lines),
    details.controlCount === undefined ? undefined : `${details.controlCount} controls`,
  ]);
  return cell(
    head,
    detailLines(details, [
      details.url,
      details.origin === undefined ? undefined : joinParts(["origin", details.origin]),
      details.frame === undefined ? undefined : joinParts(["frame", details.frame]),
      details.revision === undefined ? undefined : `revision ${details.revision}`,
    ]),
  );
}

function navigateCell(result: ToolResult | undefined): string[] {
  const details = browserCellDetails(result);
  const lines = resultLines(result);
  const destination = details.finalUrl ?? details.url;
  const head = joinParts(["opened", destination ?? headline("a page", lines)]);
  const redirects = details.redirects ?? [];
  return cell(
    head,
    detailLines(details, [
      details.url === undefined ? undefined : joinParts(["requested", details.url]),
      details.finalUrl === undefined ? undefined : joinParts(["arrived at", details.finalUrl]),
      redirects.length === 0 ? undefined : joinParts(["redirects", ...boundedList(redirects, 5)]),
      details.revision === undefined ? undefined : `revision ${details.revision}`,
    ]),
  );
}

function tabsCell(result: ToolResult | undefined): string[] {
  const details = browserCellDetails(result);
  const tabs = details.tabs ?? [];
  if (tabs.length === 0) return cell("tabs", detailLines(details, resultLines(result).slice(0, 5)));
  const head = joinParts(["tabs", `${tabs.length} controlled`]);
  return cell(
    head,
    detailLines(
      details,
      tabs
        .slice(0, RENDER_LIMITS.maxListItems)
        .map((tab) =>
          joinParts([
            tab.active === true ? "active" : "background",
            tab.title,
            tab.url,
            tab.attached === false ? "not attached" : undefined,
          ]),
        ),
    ),
  );
}

const ACT_VERB: Readonly<Record<string, string>> = {
  fill: "filled",
  type: "typed into",
  select: "selected",
  check: "checked",
  uncheck: "unchecked",
  click: "clicked",
  hover: "hovered",
  press: "pressed",
  scroll: "scrolled",
  drag: "dragged",
};

function actKind(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value =
    (args as { action?: unknown; kind?: unknown }).action ?? (args as { kind?: unknown }).kind;
  return typeof value === "string" ? value : undefined;
}

/**
 * DESIGN's Fill and Select rows. The value itself is not in the compact line and
 * not in the expanded one either: what changed is the field, and what matters is
 * where the answer came from.
 */
function actCell(info: { args: unknown; result?: ToolResult }): string[] {
  const details = browserCellDetails(info.result);
  const lines = resultLines(info.result);
  const kind = actKind(info.args);
  const verb = kind === undefined ? "acted on" : (ACT_VERB[kind] ?? kind);
  const field = details.fieldLabel ?? headline("a control", lines);
  const head = joinParts([
    verb,
    details.selected === undefined ? field : `${field}: ${details.selected}`,
  ]);
  return cell(
    head,
    detailLines(details, [
      details.origin,
      details.fieldLabel === undefined ? undefined : joinParts(["field", details.fieldLabel]),
      details.provenance === undefined ? undefined : joinParts(["source", details.provenance]),
      details.option === undefined ? undefined : joinParts(["available option", details.option]),
      details.validation === undefined ? undefined : joinParts(["validation", details.validation]),
      details.revision === undefined ? undefined : `revision ${details.revision}`,
    ]),
  );
}

function uploadCell(result: ToolResult | undefined): string[] {
  const details = browserCellDetails(result);
  const documents = details.documents ?? [];
  const names = documents.map((document) => document.basename);
  const head = joinParts([
    "attached",
    names.length === 0 ? headline("a document", resultLines(result)) : names.join(", "),
  ]);
  return cell(
    head,
    detailLines(details, [
      details.fieldLabel === undefined ? undefined : joinParts(["field", details.fieldLabel]),
      ...documents
        .slice(0, RENDER_LIMITS.maxListItems)
        .map((document) =>
          joinParts([
            document.documentId,
            document.mimeType,
            document.bytes === undefined ? undefined : bytesLabel(document.bytes),
          ]),
        ),
      "attaching a file is not submitting the form",
    ]),
  );
}

function waitCell(result: ToolResult | undefined): string[] {
  const details = browserCellDetails(result);
  const head = joinParts([
    "waiting",
    details.condition ?? headline("for the page", resultLines(result)),
  ]);
  return cell(
    head,
    detailLines(details, [
      details.condition === undefined ? undefined : joinParts(["condition", details.condition]),
      details.deadlineMs === undefined ? undefined : `deadline ${details.deadlineMs}ms`,
      details.lastObserved === undefined
        ? undefined
        : joinParts(["last observed", details.lastObserved]),
    ]),
  );
}

const GRANT_LABEL: Readonly<Record<NonNullable<BrowserCellDetails["approvalGrant"]>, string>> = {
  "allow-once": "you allowed this once",
  "allow-task": "you allowed this for the task",
  mode: "the permission mode allowed this",
};

/**
 * DESIGN's Submit row and §Outcome and Receipts. The verb never claims success:
 * the receipt status is the claim, and BD32's `unconfirmed` and `unknown` are
 * reported as the different next steps they are.
 */
function submitCell(result: ToolResult | undefined): string[] {
  const details = browserCellDetails(result);
  const lines = resultLines(result);
  const status = details.receiptStatus;
  const head = joinParts([
    status === "confirmed" ? "submitted" : "submitted, unconfirmed",
    details.title ?? headline("the form", lines),
    status === undefined ? undefined : status,
  ]);
  return cell(
    head,
    detailLines(details, [
      status === undefined ? undefined : RECEIPT_STATUS_SUMMARY[status],
      details.finalUrl ?? details.url,
      details.approvalScope === undefined
        ? undefined
        : joinParts([
            "approval",
            details.approvalScope,
            details.approvalGrant === undefined ? undefined : GRANT_LABEL[details.approvalGrant],
          ]),
      (details.evidence ?? []).length === 0
        ? undefined
        : joinParts(["evidence", ...boundedList(details.evidence ?? [], 4)]),
      details.receiptId === undefined
        ? undefined
        : joinParts([`receipt ${details.receiptId}`, "/receipt to see it"]),
      status === "unconfirmed" || status === "unknown"
        ? "Mu will not repeat this action; check the site before doing so yourself"
        : undefined,
    ]),
  );
}

function takeoverCell(result: ToolResult | undefined): string[] {
  const details = browserCellDetails(result);
  const lines = resultLines(result);
  const head = joinParts(["waiting for you in the browser", details.takeoverReason]);
  return cell(
    head,
    detailLines(details, [
      lines[0],
      details.origin === undefined ? undefined : joinParts(["origin", details.origin]),
      details.url,
      details.resumeCriteria ?? "/browser resume when you are done",
    ]),
  );
}

function statusCell(result: ToolResult | undefined): string[] {
  const lines = resultLines(result);
  if (lines.length === 0) return ["browser · checking the connection"];
  return cell(joinParts(["browser", lines[0]]), lines.slice(1));
}

function renderer(render: (info: Parameters<ToolRenderer["render"]>[0]) => string[]): ToolRenderer {
  return { render };
}

export const browserToolRenderers: Record<string, ToolRenderer> = {
  [BROWSER_STATUS_TOOL]: renderer((info) => statusCell(info.result)),
  [BROWSER_TOOL_NAMES.observe]: renderer((info) => observeCell(info.result)),
  [BROWSER_TOOL_NAMES.navigate]: renderer((info) => navigateCell(info.result)),
  [BROWSER_TOOL_NAMES.tabs]: renderer((info) => tabsCell(info.result)),
  [BROWSER_TOOL_NAMES.act]: renderer((info) =>
    actCell({ args: info.args, ...(info.result === undefined ? {} : { result: info.result }) }),
  ),
  [BROWSER_TOOL_NAMES.upload]: renderer((info) => uploadCell(info.result)),
  [BROWSER_TOOL_NAMES.submit]: renderer((info) => submitCell(info.result)),
  [BROWSER_TOOL_NAMES.wait]: renderer((info) => waitCell(info.result)),
  [BROWSER_TOOL_NAMES.takeover]: renderer((info) => takeoverCell(info.result)),
};
