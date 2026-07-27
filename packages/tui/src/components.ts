// Components return styled lines at a width — not React, no virtual DOM.

import { isAbsolute, relative, resolve, sep } from "node:path";
import { sanitizeUntrusted } from "./sanitize.ts";
import { type ColorDepth, GLYPHS, MARGIN, styleText } from "./style.ts";
import { graphemes, stringWidth, truncateToWidth } from "./width.ts";
import { wrapText } from "./wrap.ts";

const accent = (t: string, d: ColorDepth) => styleText(t, { accent: true }, d);
const dim = (t: string, d: ColorDepth) => styleText(t, { dim: true }, d);
const BLOCK_CURSOR_ON = "\u001b[7m";
const BLOCK_CURSOR_OFF = "\u001b[0m";

// Multi-line editor with history. Paste never submits — that is the decoder's
// job, but the editor must accept embedded newlines without treating them as
// a submit either.
export class Editor {
  private lines: string[] = [""];
  private row = 0;
  private col = 0;
  private history: string[] = [];
  private historyIndex = -1;

  get text(): string {
    return this.lines.join("\n");
  }

  get cursor(): { row: number; col: number } {
    return { row: this.row, col: this.col };
  }

  // Absolute offset of the cursor within `text`, so callers can splice at the
  // real insertion point rather than assuming it sits at the very end.
  get offset(): number {
    let offset = 0;
    for (let i = 0; i < this.row; i++) offset += (this.lines[i] ?? "").length + 1;
    return offset + this.col;
  }

  // Replaces [start, cursor) with `replacement`, keeping everything after the
  // cursor intact and leaving the cursor just after what was inserted.
  spliceBeforeCursor(start: number, replacement: string): void {
    const text = this.text;
    const cursor = this.offset;
    if (start < 0 || start > cursor) return;
    const next = text.slice(0, start) + replacement + text.slice(cursor);
    this.setText(next);
    this.setOffset(start + replacement.length);
  }

  setOffset(offset: number): void {
    let remaining = Math.max(0, offset);
    for (let row = 0; row < this.lines.length; row++) {
      const length = (this.lines[row] ?? "").length;
      if (remaining <= length) {
        this.row = row;
        this.col = remaining;
        return;
      }
      remaining -= length + 1;
    }
    this.row = this.lines.length - 1;
    this.col = (this.lines[this.row] ?? "").length;
  }

  get isEmpty(): boolean {
    return this.lines.every((line) => line.length === 0);
  }

  setText(text: string): void {
    this.lines = text.split("\n");
    this.row = this.lines.length - 1;
    this.col = (this.lines[this.row] ?? "").length;
  }

  insert(text: string): void {
    const parts = text.split("\n");
    const line = this.lines[this.row] ?? "";
    const before = line.slice(0, this.col);
    const after = line.slice(this.col);

    if (parts.length === 1) {
      this.lines[this.row] = before + text + after;
      this.col += text.length;
      return;
    }
    const inserted = [
      before + (parts[0] ?? ""),
      ...parts.slice(1, -1),
      (parts[parts.length - 1] ?? "") + after,
    ];
    this.lines.splice(this.row, 1, ...inserted);
    this.row += parts.length - 1;
    this.col = (parts[parts.length - 1] ?? "").length;
  }

  newline(): void {
    this.insert("\n");
  }

  backspace(): void {
    if (this.col > 0) {
      const line = this.lines[this.row] ?? "";
      const clusters = graphemes(line.slice(0, this.col));
      const removed = clusters[clusters.length - 1] ?? "";
      this.lines[this.row] = line.slice(0, this.col - removed.length) + line.slice(this.col);
      this.col -= removed.length;
      return;
    }
    if (this.row > 0) {
      const current = this.lines[this.row] ?? "";
      const previous = this.lines[this.row - 1] ?? "";
      this.col = previous.length;
      this.lines[this.row - 1] = previous + current;
      this.lines.splice(this.row, 1);
      this.row -= 1;
    }
  }

  move(direction: "left" | "right" | "up" | "down" | "home" | "end"): void {
    const line = this.lines[this.row] ?? "";
    switch (direction) {
      case "left":
        if (this.col > 0) this.col -= 1;
        else if (this.row > 0) {
          this.row -= 1;
          this.col = (this.lines[this.row] ?? "").length;
        }
        break;
      case "right":
        if (this.col < line.length) this.col += 1;
        else if (this.row < this.lines.length - 1) {
          this.row += 1;
          this.col = 0;
        }
        break;
      case "up":
        if (this.row > 0) {
          this.row -= 1;
          this.col = Math.min(this.col, (this.lines[this.row] ?? "").length);
        }
        break;
      case "down":
        if (this.row < this.lines.length - 1) {
          this.row += 1;
          this.col = Math.min(this.col, (this.lines[this.row] ?? "").length);
        }
        break;
      case "home":
        this.col = 0;
        break;
      case "end":
        this.col = line.length;
        break;
    }
  }

  submit(): string {
    const text = this.text;
    if (text.trim().length > 0) {
      this.history.push(text);
      this.historyIndex = this.history.length;
    }
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    return text;
  }

  recallHistory(direction: "up" | "down"): boolean {
    if (this.history.length === 0) return false;
    if (direction === "up") {
      if (this.historyIndex <= 0) return false;
      this.historyIndex -= 1;
    } else {
      if (this.historyIndex >= this.history.length - 1) {
        this.historyIndex = this.history.length;
        this.setText("");
        return true;
      }
      this.historyIndex += 1;
    }
    this.setText(this.history[this.historyIndex] ?? "");
    return true;
  }

  render(width: number, depth: ColorDepth): string[] {
    const marker = `${accent(GLYPHS.userMarker, depth)} `;
    const available = width - MARGIN.length - 2;
    const out: string[] = [];
    for (const [index, line] of this.lines.entries()) {
      let display = line.length === 0 ? " " : line;
      if (index === this.row) {
        const before = line.slice(0, this.col);
        const after = line.slice(this.col);
        const cluster = graphemes(after)[0] ?? " ";
        display =
          before +
          BLOCK_CURSOR_ON +
          cluster +
          BLOCK_CURSOR_OFF +
          after.slice(cluster === " " && after.length === 0 ? 0 : cluster.length);
      }
      const wrapped = wrapText(display, available);
      for (const [i, chunk] of wrapped.entries()) {
        out.push(index === 0 && i === 0 ? MARGIN + marker + chunk : `${MARGIN}  ${chunk}`);
      }
    }
    return out;
  }
}

export interface SelectItem {
  label: string;
  description?: string;
}

export class SelectList {
  private index = 0;

  constructor(
    private items: SelectItem[],
    private maxVisible = 8,
  ) {}

  get selected(): SelectItem | undefined {
    return this.items[this.index];
  }

  get selectedIndex(): number {
    return this.index;
  }

  setItems(items: SelectItem[]): void {
    this.items = items;
    this.index = 0;
  }

  move(direction: "up" | "down"): void {
    if (this.items.length === 0) return;
    this.index =
      direction === "up"
        ? (this.index - 1 + this.items.length) % this.items.length
        : (this.index + 1) % this.items.length;
  }

  render(width: number, depth: ColorDepth): string[] {
    if (this.items.length === 0) return [`${MARGIN}${dim("no matches", depth)}`];

    // Keep the selection inside the visible window.
    const start = Math.max(
      0,
      Math.min(this.index - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible),
    );
    const visible = this.items.slice(start, start + this.maxVisible);

    return visible.map((item, i) => {
      const isSelected = start + i === this.index;
      const safeLabel = sanitizeUntrusted(item.label);
      const label = isSelected ? accent(safeLabel, depth) : safeLabel;
      const marker = isSelected ? accent(GLYPHS.userMarker, depth) : " ";
      const description = item.description
        ? dim(
            ` ${GLYPHS.separator} ${truncateToWidth(sanitizeUntrusted(item.description), Math.floor(width / 2))}`,
            depth,
          )
        : "";
      return `${MARGIN}${marker} ${label}${description}`;
    });
  }
}

// Understated accent pulse built from the identity glyph.
export class Spinner {
  private frame = 0;

  tick(): void {
    this.frame = (this.frame + 1) % GLYPHS.spinner.length;
  }

  render(depth: ColorDepth, label = ""): string {
    const glyph = accent(GLYPHS.spinner[this.frame] as string, depth);
    return label ? `${glyph} ${dim(label, depth)}` : glyph;
  }
}

export interface FooterData {
  cwd: string;
  model: string;
  contextPercent: number;
  contextWindow: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  backgroundTasks?: number;
  hint?: string;
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1_000) return Math.round(count).toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
  return `${Math.round(count / 1_000_000)}m`;
}

export function formatCwdForFooter(cwd: string, home?: string): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function styleFooterText(text: string, depth: ColorDepth): string {
  return text
    .split(/([↑↓])/)
    .map((part) => (part === "↑" || part === "↓" ? accent(part, depth) : dim(part, depth)))
    .join("");
}

// A dim cwd row followed by model, context window, cumulative I/O and cost.
export function footer(data: FooterData, width: number, depth: ColorDepth): string[] {
  const tokenParts: string[] = [];
  if (data.inputTokens > 0) tokenParts.push(`↑${formatTokens(data.inputTokens)}`);
  if (data.outputTokens > 0) tokenParts.push(`↓${formatTokens(data.outputTokens)}`);
  const parts = [
    data.model,
    `${(Math.max(0, data.contextPercent) * 100).toFixed(1)}%/${formatTokens(data.contextWindow)}`,
    ...(tokenParts.length > 0 ? [tokenParts.join(" ")] : []),
    `$${data.costUsd.toFixed(2)}`,
  ];
  if (data.backgroundTasks && data.backgroundTasks > 0) parts.push(`${data.backgroundTasks} bg`);
  if (data.hint) parts.push(data.hint);
  const maxWidth = width - MARGIN.length;
  const cwd = truncateToWidth(sanitizeUntrusted(data.cwd), maxWidth);
  const stats = truncateToWidth(parts.join(` ${GLYPHS.separator} `), maxWidth);
  return [MARGIN + dim(cwd, depth), MARGIN + styleFooterText(stats, depth)];
}

// The one rule line on screen, above the composer.
export function composerRule(width: number, depth: ColorDepth): string {
  return MARGIN + dim("─".repeat(Math.max(0, width - MARGIN.length * 2)), depth);
}

export interface ApprovalData {
  title: string;
  preview?: string[];
  selectedIndex: number;
}

export const APPROVAL_OPTIONS = ["allow once", "always allow", "deny"] as const;

// Never a modal box — same quiet layout language as everything else.
export function approvalOverlay(data: ApprovalData, width: number, depth: ColorDepth): string[] {
  const out: string[] = [MARGIN + styleText(sanitizeUntrusted(data.title), { bold: true }, depth)];
  for (const line of data.preview ?? []) {
    // The preview is a command string or diff — never trusted.
    out.push(MARGIN + dim(truncateToWidth(sanitizeUntrusted(line), width - MARGIN.length), depth));
  }
  const options = APPROVAL_OPTIONS.map((option, i) =>
    i === data.selectedIndex ? accent(option, depth) : dim(option, depth),
  ).join(dim(` ${GLYPHS.separator} `, depth));
  out.push(MARGIN + options);
  return out;
}

// Minimal streaming markdown: headings bold, bullets normalized, code dim.
// Deliberately small — a full markdown engine is not the point here.
export function renderMarkdown(text: string, width: number, depth: ColorDepth): string[] {
  const out: string[] = [];
  let inFence = false;

  for (const raw of text.split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(...wrapText(raw, width).map((line) => dim(line, depth)));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(
        ...wrapText(heading[2] ?? "", width).map((l) => styleText(l, { bold: true }, depth)),
      );
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      const indent = `${bullet[1] ?? ""}• `;
      out.push(...wrapText(indent + (bullet[2] ?? ""), width, "  "));
      continue;
    }
    out.push(...wrapText(raw, width));
  }
  return out;
}

export { stringWidth };
