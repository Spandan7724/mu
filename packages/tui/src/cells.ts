import type { CheckpointDiffFile } from "@mu/core";
import { renderMarkdown } from "./markdown.ts";
import { sanitizeUntrusted } from "./sanitize.ts";
import {
  AGENT_INDENT,
  AGENT_LABEL,
  type ColorDepth,
  diffLineStyle,
  GLYPHS,
  MARGIN,
  RESET,
  type Style,
  styleText,
  styleWithin,
} from "./style.ts";
import { stringWidth, truncateToWidth } from "./width.ts";
import { wrapText } from "./wrap.ts";

export interface RenderContext {
  width: number;
  depth: ColorDepth;
}

const dim = (text: string, depth: ColorDepth) => styleText(text, { dim: true }, depth);
const accent = (text: string, depth: ColorDepth) => styleText(text, { accent: true }, depth);

// What a tool did, not which tool it was: an unknown tool that reads still reads.
export type ToolTone = "read" | "mutate" | "exec";
const TOOL_TONES: Record<ToolTone, Style> = {
  read: { toolRead: true },
  mutate: { toolMutate: true },
  exec: { toolExec: true },
};
// A path is a location and a command is code; neither is mu speaking, which is
// what the accent means everywhere else.
export type PrimaryRole = "path" | "code";
const PRIMARY_ROLES: Record<PrimaryRole, Style> = {
  path: { path: true },
  code: { code: true },
};

function body(ctx: RenderContext): number {
  return Math.max(20, ctx.width - MARGIN.length);
}

// ▸ user input
export function userCell(text: string, ctx: RenderContext): string[] {
  const marker = `${accent(GLYPHS.userMarker, ctx.depth)} `;
  return wrapText(sanitizeUntrusted(text), body(ctx) - 2, "  ").map((line, i) =>
    i === 0 ? MARGIN + marker + line : MARGIN + line,
  );
}

// mu  agent text, hanging indent under the label
export function agentCell(text: string, ctx: RenderContext): string[] {
  const label = `${accent(AGENT_LABEL, ctx.depth)}  `;
  const rendered = renderMarkdown(text, body(ctx) - AGENT_INDENT.length, ctx.depth);
  return rendered.map((line, i) =>
    i === 0 ? MARGIN + label + line : line.length === 0 ? "" : MARGIN + AGENT_INDENT + line,
  );
}

// Thinking is dim and behind the rule; collapsed to one line unless expanded.
export function thinkingCell(text: string, ctx: RenderContext, expanded = false): string[] {
  const rule = dim(`${GLYPHS.rule} `, ctx.depth);
  const safe = sanitizeUntrusted(text);
  if (!expanded) {
    const first = safe.trim().split("\n")[0] ?? "";
    const summary = truncateToWidth(first, body(ctx) - 12);
    return [MARGIN + rule + dim(`thinking ${GLYPHS.separator} ${summary}`, ctx.depth)];
  }
  return wrapText(safe, body(ctx) - 2).map((line) => MARGIN + rule + dim(line, ctx.depth));
}

export interface ToolCellOptions {
  name: string;
  tone?: ToolTone;
  primaryArg?: string;
  primaryRole?: PrimaryRole;
  summary?: string; // right-hand metadata, e.g. "142 lines"
  // A failure detail is the opposite of metadata — it is the reason to look.
  summaryError?: boolean;
  isSuccess?: boolean;
  isError?: boolean;
  nested?: boolean;
  // Live output tail shown while running; omitted once collapsed.
  tail?: string[];
}

// │ read src/api/client.ts · 142 lines
export function toolCell(options: ToolCellOptions, ctx: RenderContext): string[] {
  const rule = dim(`${options.nested ? GLYPHS.nestedRule : GLYPHS.rule} `, ctx.depth);
  const available =
    ctx.width - MARGIN.length - stringWidth(`${options.nested ? GLYPHS.nestedRule : GLYPHS.rule} `);
  const separator = ` ${GLYPHS.separator} `;
  const status = options.isError
    ? styleText(GLYPHS.error, { red: true }, ctx.depth)
    : options.isSuccess
      ? styleText(GLYPHS.ok, { green: true }, ctx.depth)
      : "";
  const rawPrimary = options.primaryArg
    ? sanitizeUntrusted(options.primaryArg).replace(/\t/g, "    ")
    : "";
  const primaryLines = rawPrimary.split("\n");
  const firstPrimary = primaryLines[0] ?? "";
  const rawSummary = options.summary ? sanitizeUntrusted(options.summary) : "";
  const actionReserve = (firstPrimary ? 4 : 0) + (status ? 4 : 0);
  const name = truncateToWidth(
    sanitizeUntrusted(options.name),
    Math.max(1, available - actionReserve),
  );
  const summaryBudget =
    available -
    stringWidth(name) -
    (firstPrimary ? 4 : 0) -
    stringWidth(separator) -
    stringWidth(status) -
    (status ? 1 : 0);
  const summary = summaryBudget >= 2 ? truncateToWidth(rawSummary, summaryBudget) : "";
  const summaryStyle: Style = options.summaryError ? { red: true } : { dim: true };
  const metadata = [status, summary ? styleText(summary, summaryStyle, ctx.depth) : ""]
    .filter(Boolean)
    .join(" ");
  const primaryBudget =
    available -
    stringWidth(name) -
    (firstPrimary ? 1 : 0) -
    (metadata ? stringWidth(separator) + stringWidth(metadata) : 0);
  const primary = firstPrimary ? truncateToWidth(firstPrimary, Math.max(1, primaryBudget)) : "";
  const primaryStyle = options.primaryRole ? PRIMARY_ROLES[options.primaryRole] : undefined;
  const styledPrimary =
    primaryStyle && primary ? styleText(primary, primaryStyle, ctx.depth) : primary;
  // Bold as well as coloured, so the verb still leads the row under NO_COLOR.
  const action = styleText(
    name,
    { bold: true, ...(options.tone ? TOOL_TONES[options.tone] : {}) },
    ctx.depth,
  );
  const head =
    MARGIN +
    rule +
    action +
    (styledPrimary ? ` ${styledPrimary}` : "") +
    (metadata ? dim(separator, ctx.depth) + metadata : "");
  const lines = [head];

  for (const line of primaryLines.slice(1)) {
    const continuation = truncateToWidth(line, Math.max(1, available));
    lines.push(
      MARGIN +
        rule +
        (primaryStyle ? styleText(continuation, primaryStyle, ctx.depth) : continuation),
    );
  }
  for (const line of options.tail ?? []) {
    lines.push(
      MARGIN + rule + dim(truncateToWidth(sanitizeUntrusted(line), body(ctx) - 2), ctx.depth),
    );
  }
  return lines;
}

export function toolOutputCell(text: string, ctx: RenderContext): string[] {
  const rule = dim(`${GLYPHS.rule} `, ctx.depth);
  const safe = sanitizeUntrusted(text).replace(/\t/g, "    ");
  const content = safe.length > 0 ? safe : "(no output)";
  return wrapText(content, body(ctx) - 2).map((line) => MARGIN + rule + dim(line, ctx.depth));
}

export interface TaskCellOptions {
  taskId: string;
  command: string;
  status: "running" | "exited" | "killed";
  exitCode?: number | null;
  durationMs?: number;
  tail?: string[];
}

function formatDuration(durationMs: number): string {
  const ms = Math.max(0, durationMs);
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

// Background process cells live in the managed region while running and are
// committed as a one-line outcome when they exit.
export function taskCell(options: TaskCellOptions, ctx: RenderContext): string[] {
  const rule = dim(`${GLYPHS.rule} `, ctx.depth);
  const taskId = truncateToWidth(
    sanitizeUntrusted(options.taskId),
    Math.max(4, Math.min(12, Math.floor(body(ctx) / 4))),
  );
  const metadata: { text: string; rendered: string; optional?: boolean }[] = [];

  if (options.status === "killed") {
    metadata.push({
      text: GLYPHS.error,
      rendered: styleText(GLYPHS.error, { red: true }, ctx.depth),
    });
    metadata.push({
      text: "killed",
      rendered: styleText("killed", { red: true }, ctx.depth),
      optional: true,
    });
  } else if (options.status === "exited") {
    if (options.exitCode === 0) {
      metadata.push({
        text: GLYPHS.ok,
        rendered: styleText(GLYPHS.ok, { green: true }, ctx.depth),
      });
    } else {
      metadata.push({
        text: GLYPHS.error,
        rendered: styleText(GLYPHS.error, { red: true }, ctx.depth),
      });
      const detail = `exit ${options.exitCode ?? "?"}`;
      metadata.push({
        text: detail,
        rendered: styleText(detail, { red: true }, ctx.depth),
        optional: true,
      });
    }
  }
  if (options.durationMs !== undefined) {
    const duration = formatDuration(options.durationMs);
    metadata.push({ text: duration, rendered: dim(duration, ctx.depth), optional: true });
  }

  const command = sanitizeUntrusted(options.command);
  const separatorWidth = stringWidth(` ${GLYPHS.separator} `);
  const commandBudget = () =>
    body(ctx) -
    stringWidth(`${GLYPHS.rule} `) -
    stringWidth(taskId) -
    metadata.reduce((total, item) => total + stringWidth(item.text), 0) -
    separatorWidth * (metadata.length + 1);
  while (commandBudget() < 5) {
    const index = metadata.findLastIndex((item) => item.optional);
    if (index === -1) break;
    metadata.splice(index, 1);
  }
  const parts = [
    dim(taskId, ctx.depth),
    styleText(truncateToWidth(command, Math.max(1, commandBudget())), { code: true }, ctx.depth),
    ...metadata.map((item) => item.rendered),
  ];
  const lines = [MARGIN + rule + parts.join(dim(` ${GLYPHS.separator} `, ctx.depth))];
  for (const line of options.tail ?? []) {
    if (line.length === 0) continue;
    lines.push(
      MARGIN + rule + dim(truncateToWidth(sanitizeUntrusted(line), body(ctx) - 2), ctx.depth),
    );
  }
  return lines;
}

export function errorCell(message: string, ctx: RenderContext): string[] {
  const glyph = styleText(GLYPHS.error, { red: true }, ctx.depth);
  return wrapText(sanitizeUntrusted(message), body(ctx) - 2, "  ").map((line, i) =>
    i === 0 ? `${MARGIN + glyph} ${line}` : MARGIN + line,
  );
}

// A compaction boundary is a visible, honest marker that history was summarized.
export interface CompactionCellDetails {
  status?: "completed" | "failed" | "cancelled" | "noop";
  contextTokensBefore?: number;
  contextTokensAfter?: number;
  toolResultsCleared?: number;
  keptTokens?: number;
}

export function compactionCell(
  tokensFreed: number,
  ctx: RenderContext,
  details: CompactionCellDetails = {},
): string[] {
  const counts =
    details.contextTokensBefore !== undefined && details.contextTokensAfter !== undefined
      ? `${details.contextTokensBefore.toLocaleString()} → ${details.contextTokensAfter.toLocaleString()} tokens`
      : `${tokensFreed.toLocaleString()} tokens freed`;
  const extras = [
    `${tokensFreed.toLocaleString()} freed`,
    details.keptTokens !== undefined
      ? `${details.keptTokens.toLocaleString()} recent tokens kept`
      : "",
    details.toolResultsCleared ? `${details.toolResultsCleared} tool outputs cleared` : "",
  ].filter(Boolean);
  const headline = details.status === "noop" ? "Context already compact" : "Context compacted";
  const detail =
    details.status === "noop"
      ? ""
      : `${counts}${details.contextTokensBefore !== undefined ? ` ${GLYPHS.separator} ${extras.join(` ${GLYPHS.separator} `)}` : ""}`;
  // Compaction rewrites history, so the boundary wears the mutation colour.
  const glyph = styleText(GLYPHS.bullet, { toolMutate: true }, ctx.depth);
  const text = detail ? `${headline} ${GLYPHS.separator} ${detail}` : headline;
  return wrapText(text, body(ctx) - 2, "  ").map((line, index) => {
    if (index > 0) return MARGIN + dim(line, ctx.depth);
    // The headline stays undimmed so the boundary is legible at a glance.
    return `${MARGIN}${glyph} ${line.slice(0, headline.length)}${dim(line.slice(headline.length), ctx.depth)}`;
  });
}

export interface CheckpointCellOptions {
  action: "undo" | "redo";
  files: CheckpointDiffFile[];
  messageCount: number;
  promptRestored?: boolean;
}

export function checkpointCell(options: CheckpointCellOptions, ctx: RenderContext): string[] {
  const rule = dim(`${GLYPHS.rule} `, ctx.depth);
  const fileCount = options.files.length;
  const messageLabel = `${options.messageCount} message${options.messageCount === 1 ? "" : "s"}`;
  const fileLabel = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  const action = styleText(options.action, { toolMutate: true, bold: true }, ctx.depth);
  const status =
    options.action === "undo"
      ? `${messageLabel} reverted ${GLYPHS.separator} ${fileLabel} ${GLYPHS.separator} /redo to restore`
      : `${messageLabel} restored ${GLYPHS.separator} ${fileLabel}`;
  const lines = [MARGIN + rule + action + dim(` ${GLYPHS.separator} ${status}`, ctx.depth)];

  for (const file of options.files) {
    const path = styleText(
      truncateToWidth(sanitizeUntrusted(file.path), Math.max(1, body(ctx) - 18)),
      { path: true },
      ctx.depth,
    );
    const added =
      file.added > 0 ? styleText(`+${file.added}`, { green: true }, ctx.depth) : undefined;
    const removed =
      file.removed > 0 ? styleText(`−${file.removed}`, { red: true }, ctx.depth) : undefined;
    const counts = [added, removed].filter(Boolean).join(" ");
    lines.push(MARGIN + rule + path + (counts ? ` ${counts}` : ""));
  }
  if (options.promptRestored) {
    lines.push(MARGIN + rule + dim("prompt restored to editor", ctx.depth));
  }
  return lines;
}

export interface DiffLine {
  kind: "add" | "del" | "context";
  lineNumber?: number;
  text: string;
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export function diffLinesFromHunks(hunks: string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of hunks) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\ No newline")) continue;
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", lineNumber: newLine++, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ kind: "del", lineNumber: oldLine++, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith(" ")) {
      lines.push({ kind: "context", lineNumber: newLine++, text: raw.slice(1) });
      oldLine++;
    }
  }
  return lines;
}

export function diffCell(file: DiffFile, ctx: RenderContext): string[] {
  const rule = dim(`${GLYPHS.rule} `, ctx.depth);
  const header =
    styleText(sanitizeUntrusted(file.path), { path: true }, ctx.depth) +
    dim(` ${GLYPHS.separator} `, ctx.depth) +
    styleText(`+${file.added}`, { green: true }, ctx.depth) +
    " " +
    styleText(`−${file.removed}`, { red: true }, ctx.depth);
  const out = [MARGIN + rule + header];

  const gutterWidth = 5;
  for (const line of file.lines) {
    const number = line.lineNumber === undefined ? "" : String(line.lineNumber);
    const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
    // Prefix is margin(2) + rule(2) + gutter(5) + space + sign(1) + space.
    const available = ctx.width - MARGIN.length - 2 - gutterWidth - 3;
    const text = sanitizeUntrusted(line.text).replace(/\t/g, "    ");
    // The tint opens at the gutter and runs to the terminal edge, so a changed
    // row reads as one band rather than a coloured fragment beside a plain
    // number. The number itself stays dim — the sign carries the colour.
    const tint = diffLineStyle(line.kind, ctx.depth);
    const accentStyle: Style =
      line.kind === "add" ? { green: true } : line.kind === "del" ? { red: true } : {};

    for (const [i, chunk] of wrapText(text, available).entries()) {
      const numberCell = styleWithin(
        i === 0 ? number.padStart(gutterWidth) : " ".repeat(gutterWidth),
        { dim: true },
        tint,
        ctx.depth,
      );
      const gutter = i === 0 ? sign : " ";
      const signStyled =
        line.kind === "context" ? gutter : styleWithin(gutter, accentStyle, tint, ctx.depth);
      const pad = tint === "" ? "" : " ".repeat(Math.max(0, available - stringWidth(chunk)));
      out.push(
        `${MARGIN}${rule}${tint}${numberCell} ${signStyled} ${chunk}${pad}${tint === "" ? "" : RESET}`,
      );
    }
  }
  return out;
}

export function separator(): string[] {
  return [""];
}

export type { Style };
