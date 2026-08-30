import type { AgentMessage, CheckpointDiffFile, ToolResultMessage } from "@mu/core";
import type { SubagentDetails, SubagentKind, SubagentProgressUpdate } from "mu";
import {
  type DiffLine,
  diffCell,
  diffLinesFromHunks,
  type PlanItem,
  type PlanStatus,
  type PrimaryRole,
  planCell,
  type RenderContext,
  type ToolCellOptions,
  toolCell,
  toolOutputCell,
} from "./cells.ts";
import { renderMarkdown } from "./markdown.ts";
import { sanitizeUntrusted } from "./sanitize.ts";
import { type ColorDepth, GLYPHS, MARGIN, styleText } from "./style.ts";
import { highlightCode } from "./syntax-highlight.ts";
import { stringWidth, truncateToWidth } from "./width.ts";
import { wrapLine, wrapText } from "./wrap.ts";

const COMPACT_OUTPUT_LINES = 5;
const COMPACT_DIFF_LINES = 9;
const EXPANDED_OUTPUT_LINES = 200;

export interface ToolRenderInfo {
  toolName: string;
  args: unknown;
  result?: ToolResultMessage;
  running?: boolean;
  elapsedMs?: number;
  expanded?: boolean;
  // Arguments are still arriving from the model, so anything rendered from them
  // is a fragment of itself.
  argsStreaming?: boolean;
  // A later call to the same tool has replaced what this one reported.
  superseded?: boolean;
  // Ephemeral renderer-owned state assembled from tool_execution_update details.
  progress?: unknown;
}

export type ActivityKind = "explore" | "edit" | "command";

export interface ToolRendererFn {
  (info: ToolRenderInfo, ctx: RenderContext, registry?: RendererRegistry): string[];
  // The renderer draws its own expanded form, so the registry must not staple
  // the raw result text underneath it as well.
  ownsExpansion?: boolean;
  // Each call replaces the last rather than adding to it, so only the newest
  // is still true. Earlier ones render as `superseded` and are expected to
  // shrink to a record of what changed.
  supersedes?: boolean;
  // Consecutive calls with the same activity kind may be presented as one
  // collapsible transcript group. Profiles declare the semantic class here;
  // the TUI remains unaware of tool names and domains.
  activityKind?: ActivityKind | ((info: ToolRenderInfo) => ActivityKind | undefined);
  // Explicit user actions may make their result the primary response rather
  // than supporting agent machinery. They can start open while retaining the
  // same disclosure controls and output bound.
  expandedByDefault?: boolean | ((info: ToolRenderInfo) => boolean);
  // The renderer can present meaningful structured output before completion.
  supportsLiveExpansion?: boolean;
}

function firstString(args: unknown, keys: string[]): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function resultText(result: ToolResultMessage | undefined): string {
  if (!result) return "";
  return result.content
    .map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType}]`))
    .join("\n");
}

function compactLines(text: string, maxLines = COMPACT_OUTPUT_LINES): string[] {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return lines;
  const contentLines = Math.max(2, maxLines - 1);
  const head = Math.ceil(contentLines / 2);
  const tail = Math.floor(contentLines / 2);
  return [
    ...lines.slice(0, head),
    `… ${lines.length - head - tail} lines omitted · ctrl+o to expand`,
    ...lines.slice(-tail),
  ];
}

function expandedResultLines(info: ToolRenderInfo): string[] {
  if (!info.result) return [];
  const visible = EXPANDED_OUTPUT_LINES - 1;
  const head = Math.ceil(visible / 2);
  const tail = Math.floor(visible / 2);
  const text = resultText(info.result);
  const first: string[] = [];
  const recent: string[] = Array(tail + 1);
  let recentCount = 0;
  let lineCount = 0;
  let lineStart = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text[index] !== "\n") continue;
    const line = text.slice(lineStart, index);
    lineCount++;
    if (first.length < head) first.push(line);
    else {
      recent[recentCount % recent.length] = line;
      recentCount++;
    }
    lineStart = index + 1;
  }
  const recentLength = Math.min(recentCount, recent.length);
  const recentStart = recentCount < recent.length ? 0 : recentCount % recent.length;
  const orderedRecent = Array.from(
    { length: recentLength },
    (_, index) => recent[(recentStart + index) % recent.length] ?? "",
  );
  const selected =
    lineCount <= EXPANDED_OUTPUT_LINES
      ? [...first, ...orderedRecent]
      : [
          ...first,
          `… ${lineCount - head - tail} lines omitted · full output remains in session`,
          ...orderedRecent.slice(-tail),
        ];
  return selected;
}

function expandedResult(info: ToolRenderInfo, ctx: RenderContext): string[] {
  const lineWidth = Math.max(18, ctx.width - 4);
  return expandedResultLines(info).flatMap((line) =>
    toolOutputCell(truncateToWidth(line, lineWidth), ctx),
  );
}

function resultPreview(info: ToolRenderInfo, ctx: RenderContext, maxLines?: number): string[] {
  if (info.running || info.expanded || !info.result) return [];
  const text = resultText(info.result);
  if (!text) return [];
  return compactLines(text, maxLines).flatMap((line) =>
    toolOutputCell(truncateToWidth(line, Math.max(20, ctx.width - 6)), ctx),
  );
}

function errorPreview(info: ToolRenderInfo, ctx: RenderContext): string[] {
  if (!info.result?.isError) return [];
  return info.expanded ? expandedResult(info, ctx) : resultPreview(info, ctx);
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  bash: "bash",
  cjs: "javascript",
  h: "c",
  hpp: "cpp",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  jsonc: "json",
  kts: "kotlin",
  mdx: "markdown",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  svg: "xml",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  zsh: "bash",
};

function languageForPath(path: string): string | undefined {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return extension ? (EXTENSION_LANGUAGES[extension] ?? extension) : undefined;
}

function highlightedReadResult(info: ToolRenderInfo, ctx: RenderContext): string[] {
  const path = stringArg(info.args, "path");
  const language = languageForPath(path);
  const selected = expandedResultLines(info).map((line) =>
    sanitizeUntrusted(line).replace(/\t/g, "    "),
  );
  const parsed = selected.map((line) => /^(\s*\d+\s{2})(.*)$/.exec(line));
  const out: string[] = [];
  const rule = styleText(`${GLYPHS.rule} `, { dim: true }, ctx.depth);

  let index = 0;
  while (index < selected.length) {
    const match = parsed[index];
    if (!match) {
      out.push(...toolOutputCell(selected[index] ?? "", ctx));
      index++;
      continue;
    }

    const start = index;
    const source: string[] = [];
    while (index < selected.length && parsed[index]) {
      source.push(parsed[index]?.[2] ?? "");
      index++;
    }
    const highlighted = highlightCode(source.join("\n"), language, ctx.depth);
    for (let offset = 0; offset < source.length; offset++) {
      const prefix = parsed[start + offset]?.[1] ?? "";
      const available = Math.max(1, ctx.width - MARGIN.length - 2 - prefix.length);
      const chunks = wrapLine(highlighted[offset] ?? "", available);
      for (const [chunkIndex, chunk] of chunks.entries()) {
        const gutter = chunkIndex === 0 ? prefix : " ".repeat(prefix.length);
        out.push(`${MARGIN}${rule}${styleText(gutter, { dim: true }, ctx.depth)}${chunk}`);
      }
    }
  }
  return out;
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function stringArg(args: unknown, key: string): string {
  return firstString(args, [key]) ?? "";
}

// Arguments arrive raw from the model and stream in partially, so both the edits array
// and the flat single-edit shape the coding profile accepts have to render here.
function editArgs(args: unknown): { oldString: string; newString: string }[] {
  if (typeof args !== "object" || args === null) return [];
  const { edits, oldString, newString } = args as Record<string, unknown>;
  if (Array.isArray(edits)) {
    return edits
      .filter((edit): edit is Record<string, unknown> => typeof edit === "object" && edit !== null)
      .map((edit) => ({
        oldString: typeof edit.oldString === "string" ? edit.oldString : "",
        newString: typeof edit.newString === "string" ? edit.newString : "",
      }))
      .filter((edit) => edit.oldString !== "" || edit.newString !== "");
  }
  if (typeof oldString === "string" || typeof newString === "string") {
    return [
      {
        oldString: typeof oldString === "string" ? oldString : "",
        newString: typeof newString === "string" ? newString : "",
      },
    ];
  }
  return [];
}

// Positions come from the tool's result, read structurally so the TUI still does
// not import the profile. Absent while the call is running or after it failed —
// there is no position to report for a replacement that never happened.
function editHunks(
  result: ToolResultMessage | undefined,
): { edit: number; oldLine: number; newLine: number }[] | undefined {
  const hunks = (result?.details as { hunks?: unknown } | undefined)?.hunks;
  if (!Array.isArray(hunks)) return undefined;
  const parsed = hunks.filter(
    (hunk): hunk is { edit: number; oldLine: number; newLine: number } =>
      typeof hunk === "object" &&
      hunk !== null &&
      typeof (hunk as Record<string, unknown>).edit === "number" &&
      typeof (hunk as Record<string, unknown>).oldLine === "number" &&
      typeof (hunk as Record<string, unknown>).newLine === "number",
  );
  return parsed.length === hunks.length ? parsed : undefined;
}

function booleanArg(args: unknown, key: string): boolean {
  return (
    typeof args === "object" && args !== null && (args as Record<string, unknown>)[key] === true
  );
}

function boundedDiffLines(lines: DiffLine[], expanded: boolean | undefined): DiffLine[] {
  const limit = expanded ? EXPANDED_OUTPUT_LINES : COMPACT_DIFF_LINES;
  if (lines.length <= limit) return lines;
  const visible = limit - 1;
  const head = Math.ceil(visible / 2);
  const tail = Math.floor(visible / 2);
  return [
    ...lines.slice(0, head),
    {
      kind: "context",
      text: expanded
        ? `… ${lines.length - head - tail} lines omitted · full diff remains in session`
        : `… ${lines.length - head - tail} lines omitted · ctrl+o to expand`,
    },
    ...lines.slice(-tail),
  ];
}

function displayedDiffLines(
  lines: DiffLine[],
  info: ToolRenderInfo,
  ctx: RenderContext,
): DiffLine[] {
  const bounded = boundedDiffLines(lines, info.expanded);
  const width = Math.max(20, ctx.width - 14);
  return bounded.map((line) => ({ ...line, text: truncateToWidth(line.text, width) }));
}

// A diff is only meaningful whole. While arguments stream, the path is enough;
// a running call previews its complete arguments, and a completed call replaces
// that preview with the tool's authoritative before/after file diff.
function fileDiff(info: ToolRenderInfo, ctx: RenderContext): string[] {
  if (info.argsStreaming) return [];
  const path = stringArg(info.args, "path");
  if (!path) return [];

  const completed = (info.result?.details as { diff?: CheckpointDiffFile } | undefined)?.diff;
  if (completed && !info.result?.isError) {
    const [, ...lines] = diffCell(
      {
        path: completed.path,
        added: completed.added,
        removed: completed.removed,
        lines: displayedDiffLines(diffLinesFromHunks(completed.hunks), info, ctx),
      },
      ctx,
    );
    return lines;
  }

  if (info.toolName === "write") {
    const content = stringArg(info.args, "content");
    if (!content) return [];
    const sourceLines = content.split("\n");
    const lines = sourceLines.map(
      (text, index): DiffLine => ({ kind: "add", lineNumber: index + 1, text }),
    );
    const [, ...rendered] = diffCell(
      {
        path,
        added: sourceLines.length,
        removed: 0,
        lines: displayedDiffLines(lines, info, ctx),
      },
      ctx,
    );
    return rendered;
  }

  const edits = editArgs(info.args);
  const hunks = editHunks(info.result);
  // With positions the diff reads in file order, like the file itself; without
  // them it keeps the model's order and goes unnumbered rather than guessed at.
  const blocks: { oldString: string; newString: string; oldLine?: number; newLine?: number }[] =
    hunks?.flatMap((hunk) => {
      const edit = edits[hunk.edit];
      return edit ? [{ ...edit, oldLine: hunk.oldLine, newLine: hunk.newLine }] : [];
    }) ?? edits;

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const block of blocks) {
    const oldLines = block.oldString ? block.oldString.split("\n") : [];
    const newLines = block.newString ? block.newString.split("\n") : [];
    lines.push(
      ...oldLines.map(
        (text, index): DiffLine => ({
          kind: "del",
          ...(block.oldLine === undefined ? {} : { lineNumber: block.oldLine + index }),
          text,
        }),
      ),
      ...newLines.map(
        (text, index): DiffLine => ({
          kind: "add",
          ...(block.newLine === undefined ? {} : { lineNumber: block.newLine + index }),
          text,
        }),
      ),
    );
    removed += oldLines.length;
    added += newLines.length;
  }
  if (lines.length === 0) return [];
  const [, ...rendered] = diffCell(
    { path, added, removed, lines: displayedDiffLines(lines, info, ctx) },
    ctx,
  );
  return rendered;
}

// The generic fallback: name, primary argument, truncated result. This is what
// makes the TUI domain-swappable — an unknown tool still renders sensibly.
// An unknown tool declares no action class, but the shape of its primary
// argument still says whether it is a location or something machine-readable.
const PRIMARY_KEY_ROLES: [key: string, role: PrimaryRole][] = [
  ["path", "path"],
  ["command", "code"],
  ["pattern", "code"],
  ["query", "code"],
  ["url", "path"],
  ["name", "path"],
];

export const genericRenderer: ToolRendererFn = (info, ctx) => {
  const match = PRIMARY_KEY_ROLES.find(([key]) => firstString(info.args, [key]) !== undefined);
  const primary = match ? firstString(info.args, [match[0]]) : undefined;
  const text = resultText(info.result);
  const firstLine = text.split("\n")[0] ?? "";

  const options: ToolCellOptions = {
    name: info.toolName,
    ...(primary && match ? { primaryArg: primary, primaryRole: match[1] } : {}),
    ...(info.result?.isError ? { isError: true } : {}),
    ...(info.running
      ? { summary: "running" }
      : text
        ? { summary: truncateToWidth(firstLine, 40) }
        : {}),
  };
  return toolCell(options, ctx);
};

function subagentDetails(info: ToolRenderInfo): SubagentDetails | undefined {
  const details = info.result?.details;
  if (typeof details !== "object" || details === null) return undefined;
  const candidate = details as Partial<SubagentDetails>;
  if (
    candidate.type !== "subagent" ||
    !["task", "search", "counsel"].includes(candidate.kind ?? "") ||
    typeof candidate.description !== "string" ||
    typeof candidate.model !== "string" ||
    typeof candidate.thinkingLevel !== "string" ||
    typeof candidate.durationMs !== "number" ||
    !Array.isArray(candidate.messages)
  ) {
    return undefined;
  }
  return candidate as SubagentDetails;
}

export interface SubagentProgressState {
  type: "subagent-progress-state";
  kind: SubagentKind;
  description: string;
  model: string;
  thinkingLevel: string;
  messages: AgentMessage[];
  answer: string;
}

function progressUpdate(details: unknown): SubagentProgressUpdate | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const candidate = details as Partial<SubagentProgressUpdate>;
  if (
    candidate.type !== "subagent-progress" ||
    !["task", "search", "counsel"].includes(candidate.kind ?? "") ||
    typeof candidate.description !== "string" ||
    typeof candidate.model !== "string" ||
    typeof candidate.thinkingLevel !== "string" ||
    typeof candidate.event !== "object" ||
    candidate.event === null
  ) {
    return undefined;
  }
  const event = candidate.event as Partial<SubagentProgressUpdate["event"]>;
  if (event.type === "assistant_start") return candidate as SubagentProgressUpdate;
  if (event.type === "text_delta" && typeof event.text === "string") {
    return candidate as SubagentProgressUpdate;
  }
  if (event.type !== "message" || typeof event.message !== "object" || event.message === null) {
    return undefined;
  }
  const message = event.message as Partial<AgentMessage>;
  if (
    !["assistant", "toolResult"].includes(message.role ?? "") ||
    !Array.isArray(message.content) ||
    !message.content.every((block) => typeof block === "object" && block !== null)
  ) {
    return undefined;
  }
  return candidate as SubagentProgressUpdate;
}

export function updateSubagentProgress(
  current: unknown,
  details: unknown,
): SubagentProgressState | undefined {
  const update = progressUpdate(details);
  if (!update) return undefined;
  const previous =
    typeof current === "object" &&
    current !== null &&
    (current as Partial<SubagentProgressState>).type === "subagent-progress-state"
      ? (current as SubagentProgressState)
      : undefined;
  const state: SubagentProgressState = {
    type: "subagent-progress-state",
    kind: update.kind,
    description: update.description,
    model: update.model,
    thinkingLevel: update.thinkingLevel,
    messages: previous?.messages ?? [],
    answer: previous?.answer ?? "",
  };
  if (update.event.type === "assistant_start") return { ...state, answer: "" };
  if (update.event.type === "text_delta") {
    return { ...state, answer: state.answer + update.event.text };
  }
  const messages = [...state.messages, update.event.message];
  if (update.event.message.role !== "assistant") return { ...state, messages };
  const answer = update.event.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { ...state, messages, answer };
}

function subagentProgress(info: ToolRenderInfo): SubagentProgressState | undefined {
  const progress = info.progress;
  if (typeof progress !== "object" || progress === null) return undefined;
  return (progress as Partial<SubagentProgressState>).type === "subagent-progress-state"
    ? (progress as SubagentProgressState)
    : undefined;
}

const SUBAGENT_ACTIONS: Record<
  SubagentKind,
  { running: string; completed: string; tone: NonNullable<ToolCellOptions["tone"]> }
> = {
  task: { running: "delegating", completed: "delegated", tone: "state" },
  search: { running: "searching codebase", completed: "searched codebase", tone: "read" },
  counsel: { running: "consulting counsel", completed: "consulted counsel", tone: "counsel" },
};

function subagentDescription(info: ToolRenderInfo, kind: SubagentKind): string {
  return (
    firstString(info.args, kind === "task" ? ["description", "prompt"] : ["query", "question"]) ??
    kind
  );
}

interface SubagentToolCall {
  info: ToolRenderInfo;
}

function subagentToolCalls(messages: AgentMessage[], running: boolean): SubagentToolCall[] {
  const results = new Map(
    messages
      .filter((message): message is ToolResultMessage => message.role === "toolResult")
      .map((message) => [message.toolCallId, message]),
  );
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    return message.content.flatMap((block) => {
      if (block.type !== "toolCall") return [];
      const result = results.get(block.id);
      return [
        {
          info: {
            toolName: block.name,
            args: block.arguments,
            ...(result ? { result } : running ? { running: true } : {}),
          },
        },
      ];
    });
  });
}

function subagentPrompt(info: ToolRenderInfo, kind: SubagentKind, fallback: string): string {
  return firstString(info.args, kind === "task" ? ["prompt"] : ["query", "question"]) ?? fallback;
}

function boundedSubagentRows(lines: string[], ctx: RenderContext): string[] {
  if (lines.length <= EXPANDED_OUTPUT_LINES) return lines;
  const visible = EXPANDED_OUTPUT_LINES - 1;
  const head = Math.ceil(visible / 2);
  const tail = Math.floor(visible / 2);
  return [
    ...lines.slice(0, head),
    `${MARGIN}  ${styleText(
      `… ${lines.length - head - tail} rows omitted · full output remains in session`,
      { dim: true },
      ctx.depth,
    )}`,
    ...lines.slice(-tail),
  ];
}

function renderSubagentTool(
  call: SubagentToolCall,
  activityKind: ActivityKind | undefined,
  contentIndent: string,
  contentWidth: number,
  ctx: RenderContext,
  registry: RendererRegistry,
): string[] {
  const nestedContext = {
    ...ctx,
    width: contentWidth + stringWidth(MARGIN),
  };
  const [header] = registry.render({ ...call.info, expanded: false }, nestedContext);
  if (!header) return [];
  let rendered = header;
  if (activityKind === "edit") {
    const diff = (call.info.result?.details as { diff?: CheckpointDiffFile } | undefined)?.diff;
    if (diff) {
      rendered += ` ${styleText(`+${diff.added}`, { green: true }, ctx.depth)} ${styleText(`-${diff.removed}`, { red: true }, ctx.depth)}`;
    }
  }
  const body = rendered.startsWith(MARGIN) ? rendered.slice(MARGIN.length) : rendered;
  return wrapLine(body, contentWidth, "  ").map((line) => `${contentIndent}${line}`);
}

function renderSubagentActivity(
  calls: SubagentToolCall[],
  contentIndent: string,
  contentWidth: number,
  ctx: RenderContext,
  registry: RendererRegistry,
): string[] {
  const groups: { kind?: ActivityKind; calls: SubagentToolCall[] }[] = [];
  for (const call of calls) {
    const kind = registry.activityKind(call.info);
    const previous = groups.at(-1);
    if (kind && previous?.kind === kind) previous.calls.push(call);
    else groups.push({ ...(kind ? { kind } : {}), calls: [call] });
  }

  return groups.flatMap((group) => {
    const lines: string[] = [];
    if (group.kind && group.calls.length > 1) {
      lines.push(
        `${contentIndent}${styleText(
          registry.activitySummary(
            group.kind,
            group.calls.map((call) => call.info),
            ctx.depth,
          ),
          { bold: true },
          ctx.depth,
        )}`,
      );
    }
    for (const call of group.calls) {
      lines.push(
        ...renderSubagentTool(call, group.kind, contentIndent, contentWidth, ctx, registry),
      );
    }
    return lines;
  });
}

function subagentTrace(
  details: SubagentDetails | SubagentProgressState,
  info: ToolRenderInfo,
  ctx: RenderContext,
  registry: RendererRegistry,
): string[] {
  const calls = subagentToolCalls(details.messages, details.type === "subagent-progress-state");
  const sectionIndent = `${MARGIN}  `;
  const contentIndent = `${sectionIndent}  `;
  const contentWidth = Math.max(1, ctx.width - stringWidth(contentIndent));
  const prompt = subagentPrompt(info, details.kind, details.description);
  const trace: string[] = [
    `${sectionIndent}${styleText("prompt", { dim: true }, ctx.depth)}`,
    ...wrapText(sanitizeUntrusted(prompt), contentWidth).map((line) =>
      line.length === 0 ? "" : `${contentIndent}${styleText(line, { dim: true }, ctx.depth)}`,
    ),
  ];
  if (calls.length > 0) {
    trace.push(
      "",
      `${sectionIndent}${styleText(
        `activity ${GLYPHS.separator} ${calls.length} action${calls.length === 1 ? "" : "s"}`,
        { dim: true },
        ctx.depth,
      )}`,
    );
    trace.push(...renderSubagentActivity(calls, contentIndent, contentWidth, ctx, registry));
  }
  const answer = (details.type === "subagent" ? resultText(info.result) : details.answer).trim();
  if (answer) {
    const label = details.type === "subagent" ? "result" : "response";
    trace.push("", `${sectionIndent}${styleText(label, { dim: true }, ctx.depth)}`);
    const liveAnswer =
      details.type === "subagent-progress-state" && answer.length > 16_000
        ? `… earlier response omitted while streaming\n\n${answer.slice(-16_000)}`
        : answer;
    trace.push(
      ...renderMarkdown(liveAnswer, contentWidth, ctx.depth).map((line) =>
        line.length === 0 ? "" : `${contentIndent}${line}`,
      ),
    );
  }
  return boundedSubagentRows(trace, ctx);
}

function makeSubagentRenderer(kind: SubagentKind): ToolRendererFn {
  const renderer: ToolRendererFn = (info, ctx, registry) => {
    const details = subagentDetails(info);
    const progress = subagentProgress(info);
    const state = details ?? progress;
    const action = SUBAGENT_ACTIONS[kind];
    const description = state?.description ?? subagentDescription(info, kind);
    const callCount = state
      ? subagentToolCalls(state.messages, state.type === "subagent-progress-state").length
      : 0;
    const summary = details
      ? [
          details.model,
          details.thinkingLevel,
          callCount > 0 ? `${callCount} action${callCount === 1 ? "" : "s"}` : "",
          formatDuration(details.durationMs),
        ]
          .filter(Boolean)
          .join(` ${GLYPHS.separator} `)
      : [
          progress?.model,
          progress?.thinkingLevel,
          callCount > 0 ? `${callCount} action${callCount === 1 ? "" : "s"}` : "",
          formatDuration(info.elapsedMs) ?? "0ms",
        ]
          .filter(Boolean)
          .join(` ${GLYPHS.separator} `);
    const spinnerFrame = ctx.spinnerFrame ?? 0;
    const spinner =
      GLYPHS.subagentSpinner[spinnerFrame % GLYPHS.subagentSpinner.length] ??
      GLYPHS.subagentSpinner[0];
    const name = details ? action.completed : `${spinner} ${action.running}`;
    const lines = toolCell(
      {
        name,
        tone: action.tone,
        ...(info.expanded && state ? {} : { primaryArg: description }),
        summary,
        ...(details && !info.result?.isError ? { isSuccess: true } : {}),
        ...(info.result?.isError ? { isError: true, summaryError: true } : {}),
      },
      ctx,
    );
    return info.expanded && state
      ? [...lines, ...subagentTrace(state, info, ctx, registry ?? new RendererRegistry())]
      : lines;
  };
  renderer.ownsExpansion = true;
  renderer.supportsLiveExpansion = true;
  return renderer;
}

export const subagentRenderers: Record<string, ToolRendererFn> = {
  task: makeSubagentRenderer("task"),
  search: makeSubagentRenderer("search"),
  counsel: makeSubagentRenderer("counsel"),
};

export class RendererRegistry {
  private renderers = new Map<string, ToolRendererFn>();

  register(toolName: string, renderer: ToolRendererFn): void {
    this.renderers.set(toolName, renderer);
  }

  registerAll(renderers: Record<string, ToolRendererFn>): void {
    for (const [name, renderer] of Object.entries(renderers)) this.register(name, renderer);
  }

  has(toolName: string): boolean {
    return this.renderers.has(toolName);
  }

  // Whether later calls to this tool replace earlier ones, so the transcript
  // can mark all but the newest as superseded.
  supersedes(toolName: string): boolean {
    return this.renderers.get(toolName)?.supersedes === true;
  }

  activityKind(info: ToolRenderInfo): ActivityKind | undefined {
    const activityKind = this.renderers.get(info.toolName)?.activityKind;
    return typeof activityKind === "function" ? activityKind(info) : activityKind;
  }

  expandedByDefault(info: ToolRenderInfo): boolean {
    const expanded = this.renderers.get(info.toolName)?.expandedByDefault;
    return typeof expanded === "function" ? expanded(info) : expanded === true;
  }

  supportsLiveExpansion(toolName: string): boolean {
    return this.renderers.get(toolName)?.supportsLiveExpansion === true;
  }

  activitySummary(
    activityKind: ActivityKind,
    infos: readonly ToolRenderInfo[],
    depth: ColorDepth,
  ): string {
    if (activityKind === "explore") {
      const searches = infos.filter((info) => info.toolName === "bash").length;
      const files = infos.length - searches;
      const parts = [
        files > 0 ? `${files} file${files === 1 ? "" : "s"}` : "",
        searches > 0 ? `${searches} search${searches === 1 ? "" : "es"}` : "",
      ].filter(Boolean);
      return `Explored ${parts.join(", ")}`;
    }
    if (activityKind === "command") {
      const failed = infos.filter((info) => info.result?.isError).length;
      const failure = failed > 0 ? `, ${styleText(`${failed} failed`, { red: true }, depth)}` : "";
      return `Ran ${infos.length} command${infos.length === 1 ? "" : "s"}${failure}`;
    }
    const totals = infos.reduce(
      (sum, info) => {
        const diff = (info.result?.details as { diff?: CheckpointDiffFile } | undefined)?.diff;
        return {
          added: sum.added + (diff?.added ?? 0),
          removed: sum.removed + (diff?.removed ?? 0),
        };
      },
      { added: 0, removed: 0 },
    );
    const added = styleText(`+${totals.added}`, { green: true }, depth);
    const removed = styleText(`-${totals.removed}`, { red: true }, depth);
    return `Edited ${infos.length} file${infos.length === 1 ? "" : "s"} ${added} ${removed}`;
  }

  render(info: ToolRenderInfo, ctx: RenderContext): string[] {
    const renderer = this.renderers.get(info.toolName) ?? genericRenderer;
    let lines: string[];
    let ownsExpansion = renderer.ownsExpansion === true;
    try {
      lines = renderer(info, ctx, this);
    } catch {
      // A broken renderer must never take the UI down with it — and the
      // fallback has no expanded form of its own.
      lines = genericRenderer(info, ctx);
      ownsExpansion = false;
    }
    return info.expanded && info.result && !ownsExpansion
      ? [...lines, ...expandedResult(info, ctx)]
      : lines;
  }
}

const PLAN_STATUSES: PlanStatus[] = ["completed", "in_progress", "pending"];

// The task list, read structurally from the result so the TUI still does not
// import the profile. Anything malformed returns nothing rather than a
// half-plan, and the cell degrades to its header.
function planItems(info: ToolRenderInfo): PlanItem[] | undefined {
  const fromResult = (info.result?.details as { items?: unknown } | undefined)?.items;
  const fromArgs =
    typeof info.args === "object" && info.args !== null
      ? (info.args as Record<string, unknown>).items
      : undefined;
  const source = Array.isArray(fromResult) ? fromResult : fromArgs;
  if (!Array.isArray(source)) return undefined;
  const items = source.filter((item): item is PlanItem => {
    if (typeof item !== "object" || item === null) return false;
    const { content, status } = item as Record<string, unknown>;
    return typeof content === "string" && PLAN_STATUSES.includes(status as PlanStatus);
  });
  return items.length === source.length ? items : undefined;
}

// A plan is state, not an event: it is only readable whole, and a list rendered
// from half-arrived arguments shows tasks that were never recorded.
const planRenderer: ToolRendererFn = (info, ctx) => {
  const items = info.argsStreaming ? undefined : planItems(info);
  if (!items || info.result?.isError) {
    return [
      ...toolCell(
        {
          name: "plan",
          tone: "state",
          ...(info.result?.isError ? { isError: true } : {}),
        },
        ctx,
      ),
      ...(info.result?.isError ? resultPreview(info, ctx) : []),
    ];
  }
  return planCell(
    {
      items,
      ...(info.expanded ? { expanded: true } : {}),
      ...(info.superseded ? { superseded: true } : {}),
    },
    ctx,
  );
};
planRenderer.ownsExpansion = true;
// The tool replaces the whole list every call, so an earlier plan is not a
// second plan — it is the same one, out of date.
planRenderer.supersedes = true;

// Renderers for the coding profile's tools, expressed as data so the TUI does
// not import the profile (dependency direction).
export const codingRenderers: Record<string, ToolRendererFn> = {
  todo: planRenderer,
  read: (info, ctx) => {
    const details = info.result?.details as { lines?: number } | undefined;
    return [
      ...toolCell(
        {
          name: "read",
          tone: "read",
          ...(firstString(info.args, ["path"])
            ? { primaryArg: firstString(info.args, ["path"]) as string, primaryRole: "path" }
            : {}),
          ...(info.result?.isError ? { isError: true } : {}),
          ...(details?.lines ? { summary: `${details.lines} lines` } : {}),
        },
        ctx,
      ),
      ...(info.result?.isError
        ? errorPreview(info, ctx)
        : info.expanded
          ? highlightedReadResult(info, ctx)
          : resultPreview(info, ctx)),
    ];
  },
  write: (info, ctx) => {
    const details = info.result?.details as { created?: boolean } | undefined;
    return [
      ...toolCell(
        {
          name:
            info.result && !info.result.isError
              ? details?.created
                ? "created"
                : "updated"
              : "write",
          tone: "mutate",
          ...(stringArg(info.args, "path")
            ? { primaryArg: stringArg(info.args, "path"), primaryRole: "path" }
            : {}),
          ...(info.result?.isError ? { isError: true } : {}),
        },
        ctx,
      ),
      ...fileDiff(info, ctx),
      ...errorPreview(info, ctx),
    ];
  },
  edit: (info, ctx) => {
    const details = info.result?.details as { occurrences?: number } | undefined;
    return [
      ...toolCell(
        {
          name: info.result && !info.result.isError ? "edited" : "edit",
          tone: "mutate",
          ...(firstString(info.args, ["path"])
            ? { primaryArg: firstString(info.args, ["path"]) as string, primaryRole: "path" }
            : {}),
          ...(info.result?.isError ? { isError: true } : {}),
          ...(details?.occurrences
            ? {
                summary: `${details.occurrences} replacement${details.occurrences === 1 ? "" : "s"}`,
              }
            : {}),
        },
        ctx,
      ),
      ...fileDiff(info, ctx),
      ...errorPreview(info, ctx),
    ];
  },
  bash: (info, ctx) => {
    const details = info.result?.details as
      | {
          exitCode?: number | null;
          background?: boolean;
          taskId?: string;
          durationMs?: number;
        }
      | undefined;
    const ok = details?.exitCode === 0;
    const duration = formatDuration(details?.durationMs);
    const userShell = booleanArg(info.args, "userShell");
    return [
      ...toolCell(
        {
          name: userShell ? "$" : info.running ? "running" : info.result ? "ran" : "bash",
          tone: "exec",
          ...(firstString(info.args, ["command"])
            ? {
                primaryArg: firstString(info.args, ["command"]) as string,
                primaryRole: "code",
              }
            : {}),
          ...(info.result?.isError ? { isError: true } : {}),
          ...(info.result
            ? details?.background
              ? { summary: `${details.taskId ?? "task"} bg` }
              : ok
                ? { isSuccess: true, ...(duration ? { summary: duration } : {}) }
                : {
                    summary: [`exit ${details?.exitCode ?? "?"}`, duration]
                      .filter(Boolean)
                      .join(" · "),
                    summaryError: true,
                  }
            : {}),
        },
        ctx,
      ),
      ...resultPreview(info, ctx),
    ];
  },
  ls: (info, ctx) => [
    ...toolCell(
      {
        name: "ls",
        tone: "read",
        ...(firstString(info.args, ["path"])
          ? { primaryArg: firstString(info.args, ["path"]) as string, primaryRole: "path" }
          : {}),
        ...(info.result?.isError ? { isError: true } : {}),
      },
      ctx,
    ),
    ...resultPreview(info, ctx),
  ],
};

for (const name of ["read", "ls"]) {
  const renderer = codingRenderers[name];
  if (renderer) {
    renderer.activityKind = "explore";
    if (name === "read") renderer.ownsExpansion = true;
  }
}
for (const name of ["write", "edit"]) {
  const renderer = codingRenderers[name];
  if (renderer) {
    renderer.activityKind = "edit";
    renderer.ownsExpansion = true;
  }
}
const bashRenderer = codingRenderers.bash;
if (bashRenderer) {
  bashRenderer.activityKind = (info) => {
    if (booleanArg(info.args, "userShell")) return undefined;
    const command = firstString(info.args, ["command"])?.trim() ?? "";
    return /^(?:rg|ripgrep)(?:\s|$)/.test(command) ? "explore" : "command";
  };
  bashRenderer.expandedByDefault = (info) => booleanArg(info.args, "userShell");
}
