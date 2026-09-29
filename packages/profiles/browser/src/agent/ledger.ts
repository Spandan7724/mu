import { createHash } from "node:crypto";
import type { AnyTool, ToolResult } from "@mu/core";
import { classify } from "../actions/classify.ts";
import { hostOf } from "../actions/navigate.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { BrowserState, CommitRecord } from "./state.ts";

const COMMIT_TOOLS = new Set(["click", "click_xy", "type", "press", "select", "fill_form"]);

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
      });
      const before = {
        url: tab?.url ?? "",
        target: typeof input.ref === "string" ? (tab?.refs.label(input.ref) ?? input.ref) : "",
      };
      const result: ToolResult = await tool.execute(toolCallId, args, signal, onUpdate);
      if (scope !== "browser:commit" || result.isError) return result;
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
      const details =
        result.details && typeof result.details === "object"
          ? { ...(result.details as object), commit: record }
          : { commit: record };
      return { ...result, details };
    },
  };
}
