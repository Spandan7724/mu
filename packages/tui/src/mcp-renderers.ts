import { type RenderContext, type ToolCellOptions, toolCell } from "./cells.ts";
import type { ToolRendererFn, ToolRenderInfo } from "./registry.ts";
import { sanitizeUntrusted } from "./sanitize.ts";
import { type ColorDepth, GLYPHS, MARGIN, styleText } from "./style.ts";
import { stringWidth, truncateToWidth } from "./width.ts";

// Renderers for the built-in skills and MCP extensions' tools. A server's
// consecutive open, lookups and calls fold into one row that marks each tool it
// called; expanding it shows one row per call. Server and tool names come from
// the server, so everything shown is sanitized.

type Args = Record<string, unknown>;

function record(value: unknown): Args {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Args)
    : {};
}

function stringField(value: unknown, key: string): string {
  const field = record(value)[key];
  return typeof field === "string" ? field : "";
}

function firstResultLine(info: ToolRenderInfo): string {
  const block = info.result?.content.find((candidate) => candidate.type === "text");
  return block?.type === "text" ? (block.text.split("\n")[0] ?? "") : "";
}

function failure(info: ToolRenderInfo): Partial<ToolCellOptions> | undefined {
  return info.result?.isError
    ? { isError: true, summary: firstResultLine(info), summaryError: true }
    : undefined;
}

function compactArguments(value: unknown): string {
  return Object.entries(record(value))
    .map(([key, item]) => {
      const shown =
        typeof item === "string"
          ? item
          : Array.isArray(item)
            ? item
                .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
                .join(", ")
            : JSON.stringify(item);
      return `${key} ${truncateToWidth((shown ?? "").replace(/\s+/g, " "), 36)}`;
    })
    .join(", ");
}

// The summary (arguments or an error) yields before the names do: a long
// error must not cut the tool it is about down to `do…`.
function row(options: ToolCellOptions, ctx: RenderContext): string[] {
  if (!options.summary) return toolCell(options, ctx);
  const names = `${options.name} ${options.primaryArg ?? ""}`;
  const fixed = MARGIN.length + 2 + stringWidth(sanitizeUntrusted(names)) + 3;
  const status = options.isError || options.isSuccess ? 2 : 0;
  const budget = Math.max(8, ctx.width - fixed - status);
  return toolCell(
    { ...options, summary: truncateToWidth(sanitizeUntrusted(options.summary), budget) },
    ctx,
  );
}

const homePath = (path: string) => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");

const skillRenderer: ToolRendererFn = (info, ctx) => {
  const directory = stringField(info.result?.details, "directory");
  const loaded = info.result && !info.result.isError;
  return row(
    {
      name: loaded ? "loaded skill" : "skill",
      tone: "read",
      primaryArg: stringField(info.args, "name"),
      primaryRole: "code",
      ...(failure(info) ?? (directory ? { summary: homePath(directory) } : {})),
    },
    ctx,
  );
};

const openRenderer: ToolRendererFn = (info, ctx) => {
  const tools = record(info.result?.details).tools;
  return row(
    {
      name: "opened",
      tone: "read",
      primaryArg: stringField(info.args, "server"),
      primaryRole: "path",
      ...(failure(info) ??
        (typeof tools === "number" ? { summary: `${tools} tool${tools === 1 ? "" : "s"}` } : {})),
    },
    ctx,
  );
};

const describeRenderer: ToolRendererFn = (info, ctx) => {
  const tools = record(info.args).tools;
  return row(
    {
      name: "looked up",
      tone: "read",
      primaryArg: stringField(info.args, "server"),
      primaryRole: "path",
      ...(failure(info) ?? (Array.isArray(tools) ? { summary: tools.map(String).join(", ") } : {})),
    },
    ctx,
  );
};

const callRenderer: ToolRendererFn = (info, ctx) => {
  const summary = compactArguments(record(info.args).arguments);
  return row(
    {
      name: stringField(info.args, "server") || "mcp",
      tone: "exec",
      primaryArg: stringField(info.args, "tool"),
      primaryRole: "code",
      ...(failure(info) ?? {
        ...(info.result ? { isSuccess: true } : {}),
        ...(summary ? { summary } : {}),
      }),
    },
    ctx,
  );
};

interface ToolTally {
  ok: number;
  failed: number;
  running: number;
}

const total = (tally: ToolTally) => tally.ok + tally.failed + tally.running;
const times = (count: number) => (count > 1 ? `×${count}` : "");

function tallyText(tool: string, tally: ToolTally): string {
  return [
    tool,
    tally.ok ? `${GLYPHS.ok}${times(tally.ok)}` : "",
    tally.failed ? `${GLYPHS.error}${times(tally.failed)}` : "",
    tally.running ? "…" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function styledTally(tool: string, tally: ToolTally, depth: ColorDepth): string {
  return [
    styleText(tool, { code: true }, depth),
    tally.ok ? styleText(`${GLYPHS.ok}${times(tally.ok)}`, { green: true }, depth) : "",
    tally.failed ? styleText(`${GLYPHS.error}${times(tally.failed)}`, { red: true }, depth) : "",
    tally.running ? styleText("…", { dim: true }, depth) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// `github — opened, looked up 3 tools · search_issues ✓  get_issue ✓×4  +4 more (1 failed)`:
// one entry per tool in first-call order, as many as fit; failures past the
// width are still counted, in red.
export function summarizeMcpActivity(
  infos: readonly ToolRenderInfo[],
  depth: ColorDepth,
  width = Number.POSITIVE_INFINITY,
): string {
  const server = sanitizeUntrusted(stringField(infos[0]?.args, "server"));
  const opens = infos.filter((info) => info.toolName === "mcp_open");
  const lookedUp = infos
    .filter((info) => info.toolName === "mcp_describe" && !info.result?.isError)
    .reduce((sum, info) => {
      const tools = record(info.args).tools;
      return sum + (Array.isArray(tools) ? tools.length : 0);
    }, 0);
  const story = [
    opens.some((info) => info.result && !info.result.isError) ? "opened" : "",
    lookedUp ? `looked up ${lookedUp} tool${lookedUp === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const unopened = opens.some((info) => info.result?.isError);

  const tallies = new Map<string, ToolTally>();
  for (const info of infos) {
    if (info.toolName !== "mcp_call") continue;
    const tool = sanitizeUntrusted(stringField(info.args, "tool"));
    const tally = tallies.get(tool) ?? { ok: 0, failed: 0, running: 0 };
    if (!info.result) tally.running++;
    else if (info.result.isError) tally.failed++;
    else tally.ok++;
    tallies.set(tool, tally);
  }
  const entries = [...tallies];

  const separator = ` ${GLYPHS.separator} `;
  const storyText = story.length > 0 ? ` — ${story.join(", ")}` : "";
  const unopenedText = unopened ? `${separator}couldn't open` : "";
  const prefix = `${server}${storyText}${unopenedText}`;
  const rest = (from: number) => {
    const hidden = entries.slice(from);
    return {
      calls: hidden.reduce((sum, [, tally]) => sum + total(tally), 0),
      failed: hidden.reduce((sum, [, tally]) => sum + tally.failed, 0),
    };
  };
  const restLabel = (shown: number, calls: number) =>
    shown === 0 ? `${calls} call${calls === 1 ? "" : "s"}` : `+${calls} more`;
  const restWidth = (shown: number) => {
    const { calls, failed } = rest(shown);
    if (calls === 0) return 0;
    return stringWidth(
      `${shown === 0 ? "" : "  "}${restLabel(shown, calls)}${failed ? ` (${failed} failed)` : ""}`,
    );
  };
  let shown = entries.length;
  while (shown > 0) {
    const listed = entries
      .slice(0, shown)
      .map(([tool, tally]) => tallyText(tool, tally))
      .join("  ");
    if (stringWidth(`${prefix}${separator}${listed}`) + restWidth(shown) <= width) break;
    shown--;
  }

  const dim = (text: string) => styleText(text, { dim: true }, depth);
  const hidden = rest(shown);
  const parts = [
    styleText(server, { path: true, bold: true }, depth),
    storyText ? dim(storyText) : "",
    unopened ? `${dim(separator)}${styleText("couldn't open", { red: true }, depth)}` : "",
  ];
  if (entries.length > 0) {
    parts.push(dim(separator));
    parts.push(
      entries
        .slice(0, shown)
        .map(([tool, tally]) => styledTally(tool, tally, depth))
        .join("  "),
    );
    if (hidden.calls > 0) {
      parts.push(
        `${shown === 0 ? "" : "  "}${dim(restLabel(shown, hidden.calls))}${
          hidden.failed
            ? `${dim(" (")}${styleText(`${hidden.failed} failed`, { red: true }, depth)}${dim(")")}`
            : ""
        }`,
      );
    }
  }
  return parts.join("");
}

const serverGroup = (info: ToolRenderInfo) => stringField(info.args, "server") || undefined;
for (const renderer of [openRenderer, describeRenderer, callRenderer]) {
  renderer.activityKind = "mcp";
  renderer.groupsAcrossThinking = true;
  renderer.activityGroup = serverGroup;
  renderer.summarizeActivity = summarizeMcpActivity;
}
callRenderer.describe = (info) => {
  const server = stringField(info.args, "server");
  const tool = stringField(info.args, "tool");
  return server && tool ? sanitizeUntrusted(`${server} ${tool}`) : undefined;
};

export const mcpRenderers: Record<string, ToolRendererFn> = {
  skill: skillRenderer,
  mcp_open: openRenderer,
  mcp_describe: describeRenderer,
  mcp_call: callRenderer,
};
