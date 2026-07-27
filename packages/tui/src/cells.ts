
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
  // Model output is untrusted: it must not be able to drive the terminal.
  const wrapped = wrapText(sanitizeUntrusted(text), body(ctx) - AGENT_INDENT.length, "");
  return wrapped.map((line, i) => (i === 0 ? MARGIN + label + line : MARGIN + AGENT_INDENT + line));
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
  summary?: string; // right-hand metadata, e.g. "142 lines"
  isError?: boolean;
  nested?: boolean;
  // Live output tail shown while running; omitted once collapsed.
  tail?: string[];
}

// │ read src/api/client.ts · 142 lines
export function toolCell(options: ToolCellOptions, ctx: RenderContext): string[] {
  const rule = dim(`${options.nested ? GLYPHS.nestedRule : GLYPHS.rule} `, ctx.depth);
  const parts: string[] = [dim(sanitizeUntrusted(options.name), ctx.depth)];
  if (options.primaryArg) {
    parts.push(truncateToWidth(sanitizeUntrusted(options.primaryArg), Math.floor(body(ctx) / 2)));
  }
  if (options.isError) {
    parts.push(styleText(GLYPHS.error, { red: true }, ctx.depth));
  }
  if (options.summary) parts.push(dim(sanitizeUntrusted(options.summary), ctx.depth));

  const head = MARGIN + rule + parts.join(dim(` ${GLYPHS.separator} `, ctx.depth));
  const lines = [head];

  for (const line of options.tail ?? []) {
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
