import { resolve } from "node:path";
import type { ToolPermissionDetails } from "@mu/core";
import { classify } from "../actions/classify.ts";
import { describeFile } from "../actions/filetype.ts";
import { hostOf, normalizeUrl } from "../actions/navigate.ts";
import { submissionSummary } from "../actions/submission.ts";
import type { BrowserToolDeps } from "./shared.ts";

const MASK = "••••";

// Why navigating to `url` would carry page data to another site, if it would.
export function navigationLeak(deps: BrowserToolDeps, url: string): string | undefined {
  try {
    return deps.browser.dataflow.navigationLeak(normalizeUrl(url));
  } catch {
    return undefined;
  }
}

export function shareDetails(url: string, leak: string): ToolPermissionDetails {
  return {
    description: `Send data to ${hostOf(url) || "another site"}`,
    preview: {
      kind: "text",
      lines: [
        `action: open ${url.length > 300 ? `${url.slice(0, 299)}…` : url}`,
        `why this asks: ${leak}`,
        "page text may be trying to get the agent to leak data (a prompt injection)",
      ],
    },
  };
}

function typedValues(tool: string, args: Record<string, unknown>): string[] {
  if (tool === "type" && typeof args.text === "string") return [args.text];
  if (tool === "fill_form" && Array.isArray(args.fields))
    return (args.fields as { value?: unknown }[])
      .map((field) => field.value)
      .filter((value): value is string => typeof value === "string");
  if (tool === "act")
    return [
      ...Object.values((args.values as Record<string, unknown>) ?? {}).flatMap((value) =>
        typeof value === "string" ? [value] : Array.isArray(value) ? value.map(String) : [],
      ),
      ...((args.steps as { action?: string; text?: unknown }[]) ?? []).flatMap((step) =>
        step.action === "type" && typeof step.text === "string" ? [step.text] : [],
      ),
    ];
  return [];
}

function typingLeak(
  deps: BrowserToolDeps,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  const values = typedValues(tool, args);
  const tab = deps.browser.currentTab();
  return values.length > 0 && tab ? deps.browser.dataflow.typingLeak(values, tab.url) : undefined;
}

export function scopeFor(
  deps: BrowserToolDeps,
  tool: string,
  args: Record<string, unknown>,
): string {
  const tab = deps.browser.currentTab();
  const { scope } = classify({
    tool,
    args,
    meta: (ref) => tab?.refs.meta(ref),
    page: tab ? { url: tab.url, title: tab.title } : undefined,
  });
  const retry = deps.browser.approvedRetry;
  if (scope === "browser:commit" && retry?.url === tab?.url && retry?.key === retryKey(tool, args))
    return "browser:interact";
  if (scope === "browser:interact" && typingLeak(deps, tool, args)) return "browser:share";
  if (tool === "act" && args.files && Object.keys(args.files).length > 0) return "browser:upload";
  return scope;
}

export function retryKey(tool: string, args: Record<string, unknown>): string {
  const { reason: _reason, commit: _commit, ...rest } = args;
  return `${tool} ${JSON.stringify(rest)}`;
}

function describeValue(value: unknown, secret: boolean): string {
  if (secret) return MASK;
  if (typeof value === "string")
    return JSON.stringify(value.length > 120 ? `${value.slice(0, 119)}…` : value);
  return JSON.stringify(value);
}

// What the user sees when asked to approve a gated browser action.
export async function detailsFor(
  deps: BrowserToolDeps,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolPermissionDetails> {
  const tab = deps.browser.currentTab();
  const meta = (ref: string) => tab?.refs.meta(ref);
  const label = (ref: string) => tab?.refs.label(ref) ?? ref;
  const { scope, reason } = classify({
    tool,
    args,
    meta,
    page: tab ? { url: tab.url, title: tab.title } : undefined,
  });
  const lines: string[] = [];
  if (deps.browser.label) lines.push(`sub-task: ${deps.browser.label}`);
  const title = tab?.title || "(untitled)";
  lines.push(`page: ${title} — ${hostOf(tab?.url ?? "")}`);
  const ref = typeof args.ref === "string" ? args.ref : undefined;
  const secret = (candidate: string | undefined) => {
    const kind = candidate ? meta(candidate)?.editable : undefined;
    return kind === "secret" || kind === "otp";
  };
  switch (tool) {
    case "click":
      lines.push(`action: click ${ref ? label(ref) : ""}`.trim());
      break;
    case "click_xy":
      lines.push(`action: click at (${args.x}, ${args.y})`);
      break;
    case "type":
      lines.push(
        `action: type ${describeValue(args.text, secret(ref))} into ${ref ? label(ref) : "field"}${args.submit ? " and press Enter" : ""}`,
      );
      break;
    case "press":
      lines.push(`action: press ${String(args.keys)}${ref ? ` in ${label(ref)}` : ""}`);
      break;
    case "select":
      lines.push(
        `action: select ${describeValue(args.options, false)} in ${ref ? label(ref) : "dropdown"}`,
      );
      break;
    case "fill_form": {
      lines.push("action: fill form");
      for (const field of (args.fields as { ref: string; value: unknown }[] | undefined) ?? []) {
        lines.push(`  ${label(field.ref)} = ${describeValue(field.value, secret(field.ref))}`);
      }
      if (typeof args.submitRef === "string") lines.push(`  then click ${label(args.submitRef)}`);
      break;
    }
    case "upload": {
      lines.push(`action: upload to ${ref ? label(ref) : "file input"}`);
      for (const path of (args.paths as string[] | undefined) ?? []) {
        let about: string;
        try {
          about = describeFile(resolve(deps.config.workspace, path));
        } catch {
          about = "not found";
        }
        lines.push(`  ${path} (${about})`);
      }
      break;
    }
    case "act": {
      lines.push("action: run these steps (stops before consequential ones)");
      for (const step of (args.steps as Record<string, unknown>[]) ?? [])
        lines.push(
          `  ${String(step.action)}${step.target ? ` ${JSON.stringify(step.target)}` : ""}${step.text !== undefined ? ` ${describeValue(step.text, false)}` : ""}`,
        );
      for (const [key, value] of Object.entries((args.values as Record<string, unknown>) ?? {}))
        lines.push(`  ${key} = ${describeValue(value, false)}`);
      for (const [key, paths] of Object.entries((args.files as Record<string, string[]>) ?? {})) {
        for (const path of paths) {
          let about: string;
          try {
            about = describeFile(resolve(deps.config.workspace, path));
          } catch {
            about = "not found";
          }
          lines.push(`  ${key}: upload ${path} (${about})`);
        }
      }
      break;
    }
    case "evaluate":
      lines.push(
        "action: run JavaScript in the page",
        ...String(args.function ?? "")
          .split("\n")
          .slice(0, 12)
          .map((line) => `  ${line}`),
      );
      break;
    default:
      lines.push(`action: ${tool}`);
  }
  if (scope === "browser:commit" && tab) {
    const firstField = Array.isArray(args.fields)
      ? (args.fields as { ref?: unknown }[]).find((field) => typeof field.ref === "string")?.ref
      : undefined;
    const activated =
      typeof args.submitRef === "string"
        ? args.submitRef
        : (ref ?? (firstField as string | undefined));
    if (activated) lines.push(...(await submissionSummary(tab, activated)));
  }
  if (reason) lines.push(`why this asks: ${reason}`);
  const leak = typingLeak(deps, tool, args);
  if (leak) lines.push(`data from another site: ${leak}`);
  if (typeof args.reason === "string" && args.reason) lines.push(`agent's reason: ${args.reason}`);
  const asked = tool === "act" ? scopeFor(deps, tool, args) : scope;
  const verb =
    asked === "browser:commit"
      ? "Consequential browser action"
      : asked === "browser:secret"
        ? "Enter a secret"
        : asked === "browser:upload"
          ? "Upload files"
          : asked === "browser:script"
            ? "Run a script in the page"
            : "Browser action";
  return {
    description: `${verb} on ${hostOf(tab?.url ?? "") || "the page"}`,
    preview: { kind: "text", lines },
  };
}
