import { createHash } from "node:crypto";
import type { AnyTool, ToolResult } from "@mu/core";
import { classify, commitStrength } from "../actions/classify.ts";
import { hostOf } from "../actions/navigate.ts";
import { submissionContent } from "../actions/submission.ts";
import type { OutcomeKind } from "../actions/types.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { Tab } from "../browser/tabs.ts";
import { activatedRef, retryKey } from "../tools/gate.ts";
import type { BrowserState, CommitDetails, CommitRecord } from "./state.ts";

const COMMIT_TOOLS = new Set(["click", "click_xy", "type", "press", "select", "fill_form"]);
// Failures that happen before any input is dispatched, so the approval still stands.
const NOT_DISPATCHED = new Set<OutcomeKind>([
  "occluded",
  "blocked-by-dialog",
  "not-interactable",
  "stale-ref",
]);
const RETRY_WINDOW = 3;

function digest(args: Record<string, unknown>): string | undefined {
  const values =
    args.text ??
    args.options ??
    (Array.isArray(args.fields)
      ? (args.fields as { value: unknown }[]).map((field) => field.value)
      : undefined);
  if (values === undefined) return undefined;
  return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 12);
}

// Icon fonts put private-use glyphs into accessible names.
function cleanName(name: string | undefined): string | undefined {
  const cleaned = name
    ?.replace(/[\u200B-\u200D\uFEFF\uE000-\uF8FF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

// What a form fill sends, from its own arguments: the page still holds the old
// values until the fill runs.
function filledFields(args: Record<string, unknown>, tab: Tab | undefined): string[] | undefined {
  if (!Array.isArray(args.fields)) return undefined;
  return (args.fields as { ref?: unknown; value?: unknown }[]).flatMap((field) => {
    if (typeof field.ref !== "string") return [];
    const meta = tab?.refs.meta(field.ref);
    const label = cleanName(meta?.name) ?? field.ref;
    const secret = meta?.editable === "secret" || meta?.editable === "otp";
    const value = secret
      ? "••••"
      : typeof field.value === "boolean"
        ? field.value
          ? "checked"
          : "unchecked"
        : Array.isArray(field.value)
          ? field.value.join(", ")
          : String(field.value ?? "");
    return [`${label}: ${value.length > 80 ? `${value.slice(0, 79)}…` : value}`];
  });
}

function fillsSecret(args: Record<string, unknown>, tab: Tab | undefined): boolean {
  if (!Array.isArray(args.fields)) return false;
  return (args.fields as { ref?: unknown }[]).some((field) => {
    const editable =
      typeof field.ref === "string" ? tab?.refs.meta(field.ref)?.editable : undefined;
    return editable === "secret" || editable === "otp";
  });
}

// Records every consequential action that went through, so compaction or a
// resumed session never repeats a send.
export function recordingCommits(
  tool: AnyTool,
  browser: BrowserManager,
  state: BrowserState,
): AnyTool {
  if (!COMMIT_TOOLS.has(tool.name)) return tool;
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const tab = browser.currentTab();
      const input = (args ?? {}) as Record<string, unknown>;
      const { scope } = classify({
        tool: tool.name,
        args: input,
        meta: (ref) => tab?.refs.meta(ref),
        page: tab ? { url: tab.url, title: tab.title } : undefined,
      });
      const before = {
        url: tab?.url ?? "",
        target: typeof input.ref === "string" ? (tab?.refs.label(input.ref) ?? input.ref) : "",
      };
      const activated = scope === "browser:commit" ? activatedRef(input) : undefined;
      const meta = activated ? tab?.refs.meta(activated) : undefined;
      const name = cleanName(meta?.name);
      // Enter or a typed submit activates the form's submit button, not the field.
      const names = [
        name,
        tool.name === "press" || tool.name === "type" ? meta?.form?.submitLabel : undefined,
      ];
      const page = { url: tab?.url ?? "", title: tab?.title ?? "" };
      // Only a final action shows what it sent. Read before acting: a send usually
      // clears or replaces the form it sent.
      const read =
        scope === "browser:commit" &&
        tool.name !== "fill_form" &&
        tab &&
        activated &&
        commitStrength(names, page) === "final"
          ? await submissionContent(tab, activated)
          : undefined;
      const sends =
        scope !== "browser:commit"
          ? undefined
          : tool.name === "fill_form"
            ? filledFields(input, tab)
            : read?.kind === "fields"
              ? read.lines
              : undefined;
      const credentials =
        read?.credentials === true || (tool.name === "fill_form" && fillsSecret(input, tab));
      const retry = browser.approvedRetry;
      browser.approvedRetry =
        retry && retry.remaining > 1 ? { ...retry, remaining: retry.remaining - 1 } : undefined;
      const result: ToolResult = await tool.execute(toolCallId, args, signal, onUpdate);
      if (scope !== "browser:commit") return result;
      if (result.isError) {
        const kind = (result.details as { kind?: OutcomeKind } | undefined)?.kind;
        if (kind && NOT_DISPATCHED.has(kind))
          browser.approvedRetry = {
            key: retryKey(tool.name, input),
            url: before.url,
            remaining: RETRY_WINDOW,
          };
        return result;
      }
      browser.approvedRetry = undefined;
      const target =
        before.target ||
        (typeof input.submitRef === "string"
          ? (tab?.refs.label(input.submitRef) ?? input.submitRef)
          : "") ||
        (tool.name === "click_xy" ? `(${input.x}, ${input.y})` : "");
      const valuesDigest = digest(input);
      const record: CommitRecord = {
        id: toolCallId,
        at: Date.now(),
        host: hostOf(before.url),
        url: before.url,
        action: tool.name,
        target,
        ...(valuesDigest ? { valuesDigest } : {}),
      };
      state.ledger.append(record);
      const landed = (result.details as { details?: { url?: string; title?: string } } | undefined)
        ?.details;
      const commit: CommitDetails = {
        ...record,
        ...(name ? { name } : {}),
        ...(sends?.length ? { sends } : {}),
        strength: commitStrength(
          names,
          page,
          landed?.url !== undefined ? { url: landed.url, title: landed.title ?? "" } : undefined,
          credentials,
        ),
      };
      const details =
        result.details && typeof result.details === "object"
          ? { ...(result.details as object), commit }
          : { commit };
      return { ...result, details };
    },
  };
}
