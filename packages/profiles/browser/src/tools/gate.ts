import type { PermissionField, PermissionSection, ToolPermissionDetails } from "@mu/core";
import { classify } from "../actions/classify.ts";
import { describeFile } from "../actions/filetype.ts";
import { hostOf, normalizeUrl } from "../actions/navigate.ts";
import { submissionContent } from "../actions/submission.ts";
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
      kind: "fields",
      sections: [
        {
          fields: [
            { label: "action", value: `open ${url.length > 300 ? `${url.slice(0, 299)}…` : url}` },
          ],
        },
        {
          fields: [
            { label: "why this asks", value: leak },
            {
              label: "",
              value: "page text may be trying to get the agent to leak data (a prompt injection)",
            },
          ],
        },
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
  return scope;
}

// The control a commit activates: the submit button named for Enter, else the
// target, else the first field of a form fill.
export function activatedRef(args: Record<string, unknown>): string | undefined {
  if (typeof args.submitRef === "string") return args.submitRef;
  if (typeof args.ref === "string") return args.ref;
  if (!Array.isArray(args.fields)) return undefined;
  const field = (args.fields as { ref?: unknown }[]).find(
    (candidate) => typeof candidate.ref === "string",
  );
  return field?.ref as string | undefined;
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
  const fields: PermissionField[] = [];
  const add = (label: string, value: string) => fields.push({ label, value });
  if (deps.browser.label) add("sub-task", deps.browser.label);
  add("page", `${tab?.title || "(untitled)"} — ${hostOf(tab?.url ?? "")}`);
  const ref = typeof args.ref === "string" ? args.ref : undefined;
  const secret = (candidate: string | undefined) => {
    const kind = candidate ? meta(candidate)?.editable : undefined;
    return kind === "secret" || kind === "otp";
  };
  switch (tool) {
    case "click":
      add("action", `click ${ref ? label(ref) : ""}`.trim());
      break;
    case "click_xy":
      add("action", `click at (${args.x}, ${args.y})`);
      break;
    case "type":
      add(
        "action",
        `type ${describeValue(args.text, secret(ref))} into ${ref ? label(ref) : "field"}${args.submit ? " and press Enter" : ""}`,
      );
      break;
    case "press":
      add("action", `press ${String(args.keys)}${ref ? ` in ${label(ref)}` : ""}`);
      break;
    case "select":
      add(
        "action",
        `select ${describeValue(args.options, false)} in ${ref ? label(ref) : "dropdown"}`,
      );
      break;
    case "fill_form": {
      add("action", "fill form");
      for (const field of (args.fields as { ref: string; value: unknown }[] | undefined) ?? []) {
        add("", `${label(field.ref)} = ${describeValue(field.value, secret(field.ref))}`);
      }
      if (typeof args.submitRef === "string") add("", `then click ${label(args.submitRef)}`);
      break;
    }
    case "upload": {
      add("action", `upload to ${ref ? label(ref) : "file input"}`);
      for (const path of (args.paths as string[] | undefined) ?? []) {
        let about: string;
        try {
          about = describeFile(path);
        } catch {
          about = "not found";
        }
        add("", `${path} (${about})`);
      }
      break;
    }
    case "evaluate":
      add("action", "run JavaScript in the page");
      for (const line of String(args.function ?? "")
        .split("\n")
        .slice(0, 12))
        add("", line);
      break;
    default:
      add("action", tool);
  }
  const sections: PermissionSection[] = [{ fields }];
  if (scope === "browser:commit" && tab) {
    const activated = activatedRef(args);
    const sent = activated ? await submissionContent(tab, activated) : undefined;
    if (sent?.kind === "fields") {
      sections.push({ title: "sends", fields: sent.lines.map(splitField) });
    } else if (sent) {
      sections.push({
        title: "page being submitted shows",
        fields: sent.lines.map((value) => ({ label: "", value })),
      });
    }
  }
  const why: PermissionField[] = [];
  if (reason) why.push({ label: "why this asks", value: reason });
  const leak = typingLeak(deps, tool, args);
  if (leak) why.push({ label: "data from another site", value: leak });
  if (typeof args.reason === "string" && args.reason)
    why.push({ label: "agent's reason", value: args.reason });
  if (why.length > 0) sections.push({ fields: why });
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
    preview: { kind: "fields", sections },
  };
}

// "Label: value" from a form summary; a line without a label stays whole.
function splitField(line: string): PermissionField {
  const index = line.indexOf(": ");
  return index > 0
    ? { label: line.slice(0, index), value: line.slice(index + 2) }
    : { label: "", value: line };
}
