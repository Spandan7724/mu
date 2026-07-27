
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
} from "./style.ts";
import { stringWidth, truncateToWidth } from "./width.ts";
import { wrapText } from "./wrap.ts";

export interface RenderContext {
  width: number;
  depth: ColorDepth;
}

const dim = (text: string, depth: ColorDepth) => styleText(text, { dim: true }, depth);
const accent = (text: string, depth: ColorDepth) => styleText(text, { accent: true }, depth);

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
  primaryArg?: string;
  primaryAccent?: boolean;
  summary?: string; // right-hand metadata, e.g. "142 lines"
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
  const rawPrimary = options.primaryArg ? sanitizeUntrusted(options.primaryArg) : "";
  const rawSummary = options.summary ? sanitizeUntrusted(options.summary) : "";
  const actionReserve = (rawPrimary ? 4 : 0) + (status ? 4 : 0);
  const name = truncateToWidth(
    sanitizeUntrusted(options.name),
    Math.max(1, available - actionReserve),
  );
  const summaryBudget =
    available -
    stringWidth(name) -
    (rawPrimary ? 4 : 0) -
    stringWidth(separator) -
    stringWidth(status) -
    (status ? 1 : 0);
  const summary = summaryBudget >= 2 ? truncateToWidth(rawSummary, summaryBudget) : "";
  const metadata = [status, summary ? dim(summary, ctx.depth) : ""].filter(Boolean).join(" ");
  const primaryBudget =
    available -
    stringWidth(name) -
    (rawPrimary ? 1 : 0) -
    (metadata ? stringWidth(separator) + stringWidth(metadata) : 0);
  const primary = options.primaryArg ? truncateToWidth(rawPrimary, Math.max(1, primaryBudget)) : "";
  const styledPrimary = options.primaryAccent ? accent(primary, ctx.depth) : primary;
  const action = styleText(name, { bold: true }, ctx.depth);
  const head =
    MARGIN +
    rule +
    action +
    (styledPrimary ? ` ${styledPrimary}` : "") +
    (metadata ? dim(separator, ctx.depth) + metadata : "");
  const lines = [head];

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
    metadata.push({ text: "killed", rendered: dim("killed", ctx.depth), optional: true });
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
      metadata.push({ text: detail, rendered: dim(detail, ctx.depth), optional: true });
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
    truncateToWidth(command, Math.max(1, commandBudget())),
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
export function compactionCell(tokensFreed: number, ctx: RenderContext): string[] {
  const label = `compacted ${GLYPHS.separator} ${tokensFreed.toLocaleString()} tokens freed`;
  const width = body(ctx);
  const rule = "─".repeat(Math.max(0, width - stringWidth(label) - 3));
  return [MARGIN + dim(`${rule} ${label}`, ctx.depth)];
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
  const header = `${sanitizeUntrusted(file.path)} ${GLYPHS.separator} +${file.added} −${file.removed}`;
  const out = [MARGIN + rule + dim(header, ctx.depth)];

  const gutterWidth = 5;
  for (const line of file.lines) {
    const number = line.lineNumber === undefined ? "" : String(line.lineNumber);
    const numberCell = dim(number.padStart(gutterWidth), ctx.depth);
    const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
    // Prefix is margin(2) + rule(2) + gutter(5) + space + sign(1) + space.
    const available = ctx.width - MARGIN.length - 2 - gutterWidth - 3;
    const text = sanitizeUntrusted(line.text).replace(/\t/g, "    ");

    for (const [i, chunk] of wrapText(text, available).entries()) {
      const tint = diffLineStyle(line.kind, ctx.depth);
      const content = tint === "" ? chunk : `${tint}${chunk}${RESET}`;
      const gutter = i === 0 ? sign : " ";
      const signStyled =
        line.kind === "add"
          ? styleText(gutter, { green: true }, ctx.depth)
          : line.kind === "del"
            ? styleText(gutter, { red: true }, ctx.depth)
            : gutter;
      out.push(
        `${MARGIN}${rule}${i === 0 ? numberCell : " ".repeat(gutterWidth)} ${signStyled} ${content}`,
      );
    }
  }
  return out;
}

export function separator(): string[] {
  return [""];
}

export type { Style };
