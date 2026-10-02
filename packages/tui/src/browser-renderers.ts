import { type ToolTone, toolCell } from "./cells.ts";
import {
  codingRenderers,
  formatDuration,
  type ToolRendererFn,
  type ToolRenderInfo,
} from "./registry.ts";
import { sanitizeUntrusted } from "./sanitize.ts";
import { type ColorDepth, GLYPHS, styleText } from "./style.ts";
import { truncateToWidth } from "./width.ts";

// Renderers for the browser profile's tools, as data (the TUI does not import the
// profile). Actions on one page form a visit; a consequential action stands alone
// as a loud row. The page state each tool returned stays behind the usual expand
// disclosure.

interface BrowserCommit {
  host?: string;
  target?: string;
  name?: string;
  sends?: string[];
}

interface BrowserOutcome {
  summary?: string;
  kind?: string;
  commit?: BrowserCommit;
  details?: { url?: string; title?: string; tabId?: string; timings?: { totalMs?: number } };
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

function outcomeOf(info: ToolRenderInfo): BrowserOutcome {
  const details = info.result?.details;
  return typeof details === "object" && details !== null ? (details as BrowserOutcome) : {};
}

function commitOf(info: ToolRenderInfo): BrowserCommit | undefined {
  const commit = outcomeOf(info).commit;
  return typeof commit === "object" && commit !== null ? commit : undefined;
}

function urlOf(outcome: BrowserOutcome): string | undefined {
  return outcome.details?.url ?? outcome.url;
}

function host(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function durationOf(info: ToolRenderInfo): number | undefined {
  const outcome = outcomeOf(info);
  return outcome.details?.timings?.totalMs ?? outcome.timings?.totalMs ?? info.elapsedMs;
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

// ● Send  To: Alex <alex@example.com> · Subject: Running late · ✓ mail.google.com · 702 ms
// The control's own name leads, so the row says what was pressed, not which tool did it.
function commitRow(
  info: ToolRenderInfo,
  commit: BrowserCommit,
  ctx: Parameters<ToolRendererFn>[1],
) {
  const name = commit.name?.trim() ? truncateToWidth(commit.name.trim(), 32) : "committed";
  const sent = (commit.sends ?? []).slice(0, 2).join(` ${GLYPHS.separator} `);
  const summary = outcomeOf(info).summary?.split("\n")[0];
  const what = sent || commit.target || (summary ? outcomeTarget(summary, info.toolName) : "");
  const meta = [commit.host ?? host(urlOf(outcomeOf(info)))];
  const ms = durationOf(info);
  if (ms !== undefined) meta.push(`${Math.round(ms)} ms`);
  const [first = "", ...rest] = toolCell(
    {
      name,
      tone: "mutate",
      ...(what ? { primaryArg: what } : {}),
      summary: meta.filter(Boolean).join(` ${GLYPHS.separator} `),
      isSuccess: true,
    },
    ctx,
  );
  const rail = styleText(`${GLYPHS.rule} `, { dim: true }, ctx.depth);
  const mark = `${styleText("●", { toolMutate: true }, ctx.depth)} `;
  return [first.replace(rail, `${rail}${mark}`), ...rest];
}

const browserRenderer: ToolRendererFn = (info, ctx) => {
  const commit = commitOf(info);
  if (commit && !info.result?.isError) return commitRow(info, commit, ctx);
  const outcome = outcomeOf(info);
  const summary = outcome.summary;
  const target = summary
    ? outcomeTarget(summary.split("\n")[0] ?? "", info.toolName)
    : pendingTarget(info);
  const meta: string[] = [];
  if (info.running) meta.push("running");
  else {
    const where = host(urlOf(outcome));
    if (where) meta.push(where);
    const ms = durationOf(info);
    if (ms !== undefined) meta.push(`${Math.round(ms)} ms`);
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

// A visit is one document in one tab: the address without its query, so a
// search-as-you-type page stays one visit while an app's routes (paths and
// hash routes) start new ones.
function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.hash}`;
  } catch {
    return url;
  }
}

browserRenderer.activityKind = (info) =>
  info.toolName === "notes" || commitOf(info) ? undefined : "browse";

browserRenderer.activityGroup = (info) => {
  const outcome = outcomeOf(info);
  const url = urlOf(outcome);
  return url ? `${outcome.details?.tabId ?? ""} ${pageKey(url)}` : undefined;
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function fieldCount(info: ToolRenderInfo): number {
  const fields =
    typeof info.args === "object" && info.args !== null
      ? (info.args as Record<string, unknown>).fields
      : undefined;
  return Array.isArray(fields) ? fields.length : 1;
}

// What a visit amounted to, in the order it happened: "opened, 2 clicks, typed into 1 field".
function visitStory(infos: readonly ToolRenderInfo[]): string {
  const counts = new Map<string, number>();
  for (const info of infos) {
    if (info.result?.isError) continue;
    const name = info.toolName === "click_xy" ? "click" : info.toolName;
    const weight = name === "fill_form" ? fieldCount(info) : 1;
    counts.set(name, (counts.get(name) ?? 0) + weight);
  }
  const phrases: string[] = [];
  let read = false;
  for (const [name, count] of counts) {
    if (OBSERVE.has(name)) {
      if (!read) phrases.push("read");
      read = true;
      continue;
    }
    switch (name) {
      case "navigate":
        phrases.push("opened");
        break;
      case "click":
        phrases.push(plural(count, "click"));
        break;
      case "type":
        phrases.push(`typed into ${plural(count, "field")}`);
        break;
      case "fill_form":
        phrases.push(`filled ${plural(count, "field")}`);
        break;
      case "select":
        phrases.push(`chose ${plural(count, "option")}`);
        break;
      case "press":
        phrases.push(plural(count, "key press", "key presses"));
        break;
      case "scroll":
        phrases.push("scrolled");
        break;
      case "upload":
        phrases.push("uploaded");
        break;
      case "dialog":
        phrases.push("answered a dialog");
        break;
      default:
        phrases.push(name);
    }
  }
  return phrases.join(", ");
}

// mail.google.com  Inbox (3) — opened, 2 clicks · 4 actions · 1.9s
function summarizeVisit(infos: readonly ToolRenderInfo[], depth: ColorDepth): string {
  const last = outcomeOf(infos.at(-1) ?? { toolName: "", args: {} });
  const where = host(urlOf(last)) ?? "page";
  const title = sanitizeUntrusted(last.details?.title ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const story = visitStory(infos);
  const failed = infos.filter((info) => info.result?.isError).length;
  const total = infos.reduce((sum, info) => sum + (durationOf(info) ?? 0), 0);
  const dim = (text: string) => styleText(text, { dim: true }, depth);
  const separator = dim(` ${GLYPHS.separator} `);
  return [
    styleText(where, { path: true, bold: true }, depth),
    title ? `  ${truncateToWidth(title, 48)}` : "",
    story ? dim(` — ${story}`) : "",
    separator,
    dim(plural(infos.length, "action")),
    failed > 0 ? `${separator}${styleText(`${failed} failed`, { red: true }, depth)}` : "",
    total > 0 ? `${separator}${dim(formatDuration(total) ?? "")}` : "",
  ].join("");
}

browserRenderer.summarizeActivity = summarizeVisit;

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
