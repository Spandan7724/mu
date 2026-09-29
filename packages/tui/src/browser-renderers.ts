import { type ToolTone, toolCell } from "./cells.ts";
import { codingRenderers, type ToolRendererFn, type ToolRenderInfo } from "./registry.ts";

// Renderers for the browser profile's tools, as data (the TUI does not import the
// profile). One row per action: verb, target, host, duration; the page state the
// tool returned stays behind the usual expand disclosure.

interface BrowserOutcome {
  summary?: string;
  kind?: string;
  commit?: unknown;
  details?: { url?: string; timings?: { totalMs?: number } };
  timings?: { totalMs?: number };
  url?: string;
}

const OBSERVE = new Set([
  "snapshot",
  "screenshot",
  "read_page",
  "find",
  "wait",
  "downloads",
  "tabs",
]);
const STATE = new Set(["navigate", "notes"]);

function tone(toolName: string): ToolTone {
  if (OBSERVE.has(toolName)) return "read";
  if (STATE.has(toolName)) return "state";
  if (toolName === "evaluate") return "exec";
  return "mutate";
}

function host(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function argString(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

// What the call targets, from its arguments, while it runs.
function pendingTarget(info: ToolRenderInfo): string | undefined {
  const args = info.args;
  const ref = argString(args, "ref");
  switch (info.toolName) {
    case "navigate":
      return argString(args, "url");
    case "type": {
      const text = argString(args, "text");
      return [
        ref,
        text !== undefined ? JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text) : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "press":
      return argString(args, "keys");
    case "find":
      return argString(args, "text") ?? argString(args, "regex");
    case "tabs":
      return argString(args, "action");
    case "notes":
      return argString(args, "action");
    default:
      return ref;
  }
}

// The outcome line minus its leading verb: `clicked button "Send" [e14]` → `button "Send" [e14]`.
function outcomeTarget(summary: string, toolName: string): string {
  const withoutVerb = summary.replace(
    /^(clicked|right-clicked|double-clicked|typed|pressed|selected|filled|hovered|dragged|scrolled|navigated|went|reloaded|attached|chose|accepted|dismissed|waited|ran|opened|switched to|closed|snapshot|screenshot of|read_page|find|listed|appended to|replaced|read|cleared|checked|unchecked|did not click)\s*/,
    "",
  );
  return toolName === "click" || toolName === "type" ? withoutVerb : withoutVerb || summary;
}

const browserRenderer: ToolRendererFn = (info, ctx) => {
  const outcome = (info.result?.details ?? {}) as BrowserOutcome;
  const summary = outcome.summary;
  const target = summary
    ? outcomeTarget(summary.split("\n")[0] ?? "", info.toolName)
    : pendingTarget(info);
  const meta: string[] = [];
  if (info.running) meta.push("running");
  else {
    const where = host(outcome.details?.url ?? outcome.url);
    if (where) meta.push(where);
    const ms = outcome.details?.timings?.totalMs ?? outcome.timings?.totalMs ?? info.elapsedMs;
    if (ms !== undefined) meta.push(`${Math.round(ms)} ms`);
    if (outcome.commit) meta.push("committed");
  }
  return toolCell(
    {
      name: info.toolName,
      tone: tone(info.toolName),
      ...(target ? { primaryArg: target } : {}),
      ...(meta.length > 0 ? { summary: meta.join(" · ") } : {}),
      ...(info.result?.isError ? { isError: true } : info.result ? { isSuccess: true } : {}),
    },
    ctx,
  );
};

const TOOLS = [
  "navigate",
  "click",
  "type",
  "fill_form",
  "select",
  "press",
  "scroll",
  "hover",
  "drag",
  "upload",
  "dialog",
  "tabs",
  "snapshot",
  "screenshot",
  "read_page",
  "find",
  "wait",
  "evaluate",
  "click_xy",
  "downloads",
  "notes",
];

export const browserRenderers: Record<string, ToolRendererFn> = {
  ...Object.fromEntries(TOOLS.map((name) => [name, browserRenderer])),
  ...(codingRenderers.todo ? { todo: codingRenderers.todo } : {}),
};
