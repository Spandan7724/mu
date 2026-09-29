import type { ToolPermissionDetails } from "@mu/core";
import { classify } from "../actions/classify.ts";
import { hostOf } from "../actions/navigate.ts";
import type { BrowserToolDeps } from "./shared.ts";

const MASK = "••••";

export function scopeFor(
  deps: BrowserToolDeps,
  tool: string,
  args: Record<string, unknown>,
): string {
  const tab = deps.browser.currentTab();
  return classify({ tool, args, meta: (ref) => tab?.refs.meta(ref) }).scope;
}

function describeValue(value: unknown, secret: boolean): string {
  if (secret) return MASK;
  if (typeof value === "string")
    return JSON.stringify(value.length > 120 ? `${value.slice(0, 119)}…` : value);
  return JSON.stringify(value);
}

// What the user sees when asked to approve a gated browser action.
export function detailsFor(
  deps: BrowserToolDeps,
  tool: string,
  args: Record<string, unknown>,
): ToolPermissionDetails {
  const tab = deps.browser.currentTab();
  const meta = (ref: string) => tab?.refs.meta(ref);
  const label = (ref: string) => tab?.refs.label(ref) ?? ref;
  const { scope, reason } = classify({ tool, args, meta });
  const lines: string[] = [];
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
    case "upload":
      lines.push(
        `action: upload ${(args.paths as string[] | undefined)?.join(", ") ?? ""} to ${ref ? label(ref) : "file input"}`,
      );
      break;
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
  if (reason) lines.push(`why this asks: ${reason}`);
  if (typeof args.reason === "string" && args.reason) lines.push(`agent's reason: ${args.reason}`);
  const verb =
    scope === "browser:commit"
      ? "Consequential browser action"
      : scope === "browser:secret"
        ? "Enter a secret"
        : scope === "browser:upload"
          ? "Upload files"
          : scope === "browser:script"
            ? "Run a script in the page"
            : "Browser action";
  return {
    description: `${verb} on ${hostOf(tab?.url ?? "") || "the page"}`,
    preview: { kind: "text", lines },
  };
}
