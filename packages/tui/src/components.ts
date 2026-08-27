// Components return styled lines at a width — not React, no virtual DOM.

import { isAbsolute, relative, resolve, sep } from "node:path";
import { type DiffFile, diffCell } from "./cells.ts";
import { renderMarkdown } from "./markdown.ts";
import { sanitizeUntrusted } from "./sanitize.ts";
import { type ColorDepth, GLYPHS, MARGIN, type Style, styleText } from "./style.ts";
import { graphemes, stringWidth, truncateToWidth } from "./width.ts";
import { wrapText } from "./wrap.ts";

const accent = (t: string, d: ColorDepth) => styleText(t, { accent: true }, d);
const dim = (t: string, d: ColorDepth) => styleText(t, { dim: true }, d);
const userMarker = (d: ColorDepth) => accent(GLYPHS.userMarker, d);
export const BLOCK_CURSOR_ON = "\u001b[7m";
const BLOCK_CURSOR_OFF = "\u001b[0m";

const COMMAND_TOKEN = /^\/[A-Za-z][\w:-]*/;
const MENTION_TOKEN = /(?:^|\s)(@\S+)/g;

// One style per character, so a mention inside a shell line paints over the
// shell run without either token needing to know about the other.
function inputStyles(line: string, isFirst: boolean): (Style | undefined)[] {
  const styles: (Style | undefined)[] = new Array(line.length).fill(undefined);
  const paint = (start: number, end: number, style: Style) => {
    for (let i = start; i < Math.min(end, line.length); i++) styles[i] = style;
  };
  if (isFirst) {
    const command = COMMAND_TOKEN.exec(line);
    if (command) paint(0, command[0].length, { accent: true });
    else if (line.startsWith("!")) {
      paint(1, line.length, { code: true });
      paint(0, 1, { toolExec: true });
    }
  }
  for (const match of line.matchAll(MENTION_TOKEN)) {
    const token = match[1] as string;
    const start = (match.index ?? 0) + match[0].length - token.length;
    paint(start, start + token.length, { path: true });
  }
  return styles;
}

function paintRange(
  line: string,
  styles: (Style | undefined)[],
  from: number,
  to: number,
  depth: ColorDepth,
): string {
  let out = "";
  let i = from;
  while (i < to) {
    const style = styles[i];
    let end = i + 1;
    while (end < to && styles[end] === style) end++;
    const text = line.slice(i, end);
    out += style ? styleText(text, style, depth) : text;
    i = end;
  }
  return out;
}

function graphemeOffsets(line: string): number[] {
  const offsets = [0];
  for (const cluster of graphemes(line)) offsets.push((offsets.at(-1) ?? 0) + cluster.length);
  return offsets;
}

function floorGraphemeOffset(line: string, offset: number): number {
  let floor = 0;
  for (const boundary of graphemeOffsets(line)) {
    if (boundary > offset) break;
    floor = boundary;
  }
  return floor;
}

function previousGraphemeOffset(line: string, offset: number): number {
  let previous = 0;
  for (const boundary of graphemeOffsets(line)) {
    if (boundary >= offset) break;
    previous = boundary;
  }
  return previous;
}

function nextGraphemeOffset(line: string, offset: number): number {
  for (const boundary of graphemeOffsets(line)) {
    if (boundary > offset) return boundary;
  }
  return line.length;
}

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

  get textBeforeCursor(): string {
    return (this.lines[this.row] ?? "").slice(0, this.col);
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
        this.col = floorGraphemeOffset(this.lines[row] ?? "", remaining);
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
    // Terminals disagree on whether pasted line endings arrive as LF, CRLF,
    // or bare CR. Never retain a carriage return in the editor: rendering one
    // would move the real terminal cursor back to column zero and let later
    // pasted text overwrite earlier rows on screen.
    const normalized = text.replace(/\r\n?/g, "\n");
    const parts = normalized.split("\n");
    const line = this.lines[this.row] ?? "";
    const before = line.slice(0, this.col);
    const after = line.slice(this.col);

    if (parts.length === 1) {
      this.lines[this.row] = before + normalized + after;
      this.col += normalized.length;
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
        if (this.col > 0) this.col = previousGraphemeOffset(line, this.col);
        else if (this.row > 0) {
          this.row -= 1;
          this.col = (this.lines[this.row] ?? "").length;
        }
        break;
      case "right":
        if (this.col < line.length) this.col = nextGraphemeOffset(line, this.col);
        else if (this.row < this.lines.length - 1) {
          this.row += 1;
          this.col = 0;
        }
        break;
      case "up":
        if (this.row > 0) {
          this.row -= 1;
          const target = this.lines[this.row] ?? "";
          this.col = floorGraphemeOffset(target, Math.min(this.col, target.length));
        }
        break;
      case "down":
        if (this.row < this.lines.length - 1) {
          this.row += 1;
          const target = this.lines[this.row] ?? "";
          this.col = floorGraphemeOffset(target, Math.min(this.col, target.length));
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
    const marker = `${userMarker(depth)} `;
    const available = width - MARGIN.length - 2;
    const out: string[] = [];
    for (const [index, line] of this.lines.entries()) {
      const styles = inputStyles(line, index === 0);
      let display = line.length === 0 ? " " : paintRange(line, styles, 0, line.length, depth);
      if (index === this.row) {
        const after = line.slice(this.col);
        const atEnd = after.length === 0;
        const cluster = graphemes(after)[0] ?? " ";
        const cursorEnd = atEnd ? this.col : this.col + cluster.length;
        display =
          paintRange(line, styles, 0, this.col, depth) +
          BLOCK_CURSOR_ON +
          (atEnd ? " " : paintRange(line, styles, this.col, cursorEnd, depth)) +
          BLOCK_CURSOR_OFF +
          paintRange(line, styles, cursorEnd, line.length, depth);
      }
      const wrapped = wrapText(display, available);
      for (const [i, chunk] of wrapped.entries()) {
        out.push(index === 0 && i === 0 ? MARGIN + marker + chunk : `${MARGIN}  ${chunk}`);
      }
    }
    return out;
  }

  // Secret prompts keep the real value in the editor for normal cursor and
  // deletion behavior, but never render it (or add it to command history).
  renderMasked(width: number, depth: ColorDepth): string[] {
    const marker = `${userMarker(depth)} `;
    const available = width - MARGIN.length - 2;
    const flat = this.text.replace(/\n/g, "");
    const beforeCount = graphemes(flat.slice(0, this.offset)).length;
    const total = graphemes(flat).length;
    const masked =
      "•".repeat(beforeCount) +
      BLOCK_CURSOR_ON +
      (beforeCount < total ? "•" : " ") +
      BLOCK_CURSOR_OFF +
      "•".repeat(Math.max(0, total - beforeCount - 1));
    return wrapText(masked, available).map((chunk, index) =>
      index === 0 ? MARGIN + marker + chunk : `${MARGIN}  ${chunk}`,
    );
  }
}

export interface SelectItem {
  label: string;
  description?: string;
  value?: string;
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
      const available = Math.max(1, width - stringWidth(MARGIN) - 2);
      const separator = ` ${GLYPHS.separator} `;
      const safeDescription = item.description ? sanitizeUntrusted(item.description) : undefined;
      const descriptionBudget = safeDescription
        ? Math.min(Math.floor(available / 2), stringWidth(separator) + stringWidth(safeDescription))
        : 0;
      const descriptionText =
        safeDescription && descriptionBudget > stringWidth(separator)
          ? separator + truncateToWidth(safeDescription, descriptionBudget - stringWidth(separator))
          : "";
      const safeLabel = truncateToWidth(
        sanitizeUntrusted(item.label),
        Math.max(1, available - stringWidth(descriptionText)),
      );
      const label = isSelected ? accent(safeLabel, depth) : safeLabel;
      const marker = isSelected ? accent(GLYPHS.userMarker, depth) : " ";
      const description = descriptionText ? dim(descriptionText, depth) : "";
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

export type QueuedInputKind = "steer" | "follow-up";

function boundQueuedInput(
  lines: string[],
  indent: string,
  width: number,
  depth: ColorDepth,
): string[] {
  if (lines.length <= 3) return lines;
  const hidden = lines.length - 2;
  const notice = truncateToWidth(
    `… +${hidden} row${hidden === 1 ? "" : "s"}`,
    Math.max(1, width - stringWidth(indent)),
  );
  return [...lines.slice(0, 2), `${indent}${dim(notice, depth)}`];
}

export function queuedInputPreview(
  kind: QueuedInputKind,
  text: string,
  width: number,
  depth: ColorDepth,
  editable = false,
): string[] {
  const safe = sanitizeUntrusted(text);
  const content = safe + (editable ? dim(` ${GLYPHS.separator} alt+up edit`, depth) : "");
  const label = `${kind} ${GLYPHS.separator} `;
  const prefixWidth = 2 + stringWidth(label);
  const available = width - MARGIN.length - prefixWidth;

  if (available < 4) {
    const maxWidth = Math.max(1, width - MARGIN.length);
    const headerLabel = truncateToWidth(kind, Math.max(1, maxWidth - 2));
    const header = `${MARGIN}${userMarker(depth)}${dim(` ${headerLabel}`, depth)}`;
    const bodyWidth = Math.max(1, maxWidth - 2);
    const indent = `${MARGIN}  `;
    const lines = [header, ...wrapText(content, bodyWidth).map((line) => `${indent}${line}`)];
    return boundQueuedInput(lines, indent, width, depth);
  }

  const prefix = `${userMarker(depth)} ${dim(label, depth)}`;
  const indent = `${MARGIN}${" ".repeat(prefixWidth)}`;
  const lines = wrapText(content, available).map((line, index) =>
    index === 0 ? `${MARGIN}${prefix}${line}` : `${MARGIN}${" ".repeat(prefixWidth)}${line}`,
  );
  return boundQueuedInput(lines, indent, width, depth);
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
  status?: string;
  // Present only while rendering an ephemeral side conversation.
  side?: string;
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

function styleFooterPart(text: string, style: Style, depth: ColorDepth): string {
  return text
    .split(/([↑↓])/)
    .map((part) =>
      part === "↑" || part === "↓"
        ? accent(part, depth)
        : part.length > 0
          ? styleText(part, style, depth)
          : "",
    )
    .join("");
}

function styleFooterText(text: string, depth: ColorDepth): string {
  return styleFooterPart(text, { dim: true }, depth);
}

// The context window is a budget, and the footer is the only place it is ever
// shown. Below half there is nothing to warn about, so it reads as ordinary mu
// chrome and only escalates once the budget is actually going.
function contextPressure(percent: number): Style {
  if (percent >= 0.8) return { red: true };
  if (percent >= 0.5) return { toolMutate: true };
  return { accent: true };
}

// A dim cwd and live status row followed by model, context window, cumulative I/O and cost.
export function footer(data: FooterData, width: number, depth: ColorDepth): string[] {
  const tokenParts: string[] = [];
  if (data.inputTokens > 0) tokenParts.push(`↑${formatTokens(data.inputTokens)}`);
  if (data.outputTokens > 0) tokenParts.push(`↓${formatTokens(data.outputTokens)}`);
  const percent = Math.max(0, data.contextPercent);
  const quiet: Style = { dim: true };
  const parts: { text: string; style: Style }[] = [
    ...(data.side
      ? [
          { text: "side", style: { accent: true } },
          { text: data.side, style: quiet },
        ]
      : []),
    { text: data.model, style: quiet },
    {
      text: `${(percent * 100).toFixed(1)}%/${formatTokens(data.contextWindow)}`,
      style: contextPressure(percent),
    },
    ...(tokenParts.length > 0 ? [{ text: tokenParts.join(" "), style: quiet }] : []),
    { text: `$${data.costUsd.toFixed(2)}`, style: quiet },
  ];
  if (data.backgroundTasks && data.backgroundTasks > 0) {
    parts.push({ text: `${data.backgroundTasks} bg`, style: quiet });
  }
  if (data.hint) parts.push({ text: data.hint, style: quiet });
  const maxWidth = Math.max(0, width - MARGIN.length);
  const safeCwd = sanitizeUntrusted(data.cwd);
  const safeStatus = sanitizeUntrusted(data.status ?? "");
  const status = safeStatus ? truncateToWidth(`(${safeStatus})`, maxWidth) : "";
  const statusWidth = stringWidth(status);
  const cwd = truncateToWidth(
    safeCwd,
    Math.max(0, maxWidth - statusWidth - (statusWidth > 0 ? 1 : 0)),
  );
  const location = cwd + (statusWidth > 0 ? `${cwd ? " " : ""}${status}` : "");
  const plain = parts.map((part) => part.text).join(` ${GLYPHS.separator} `);
  // Per-part styling cannot survive truncation of the joined string, so a row
  // too narrow to hold the stats falls back to the uniformly quiet rendering.
  const stats =
    stringWidth(plain) <= maxWidth
      ? parts
          .map((part) => styleFooterPart(part.text, part.style, depth))
          .join(dim(` ${GLYPHS.separator} `, depth))
      : styleFooterText(truncateToWidth(plain, maxWidth), depth);
  return [MARGIN + dim(location, depth), MARGIN + stats];
}

// Brackets the composer: once above it, once below (before the footer).
export function composerRule(width: number, depth: ColorDepth): string {
  return MARGIN + dim("─".repeat(Math.max(0, width - MARGIN.length * 2)), depth);
}

export interface ApprovalData {
  title: string;
  preview?: string[];
  diff?: DiffFile;
  maxPreviewRows?: number;
  selectedIndex: number;
}

export const APPROVAL_OPTIONS = ["allow once", "always allow", "deny"] as const;

// Never a modal box — same quiet layout language as everything else.
export function approvalOverlay(data: ApprovalData, width: number, depth: ColorDepth): string[] {
  const out: string[] = [MARGIN + styleText(sanitizeUntrusted(data.title), { bold: true }, depth)];
  const preview = data.diff
    ? diffCell(data.diff, { width, depth })
    : // The command being approved is the whole question; it must not be the
      // dimmest thing on the screen.
      (data.preview ?? []).map(
        (line) =>
          MARGIN +
          styleText(
            truncateToWidth(sanitizeUntrusted(line), width - MARGIN.length),
            { code: true },
            depth,
          ),
      );
  const bounded = boundPreview(preview, data.maxPreviewRows);
  for (const line of bounded) {
    // The preview is a command string or diff — never trusted.
    out.push(line);
  }
  const options = APPROVAL_OPTIONS.map((option, i) =>
    i === data.selectedIndex ? accent(option, depth) : dim(option, depth),
  ).join(dim(` ${GLYPHS.separator} `, depth));
  out.push(MARGIN + options);
  return out;
}

function boundPreview(lines: string[], maxRows = 12): string[] {
  if (lines.length <= maxRows) return lines;
  if (maxRows <= 1) return lines.slice(0, maxRows);
  const head = Math.max(1, Math.ceil((maxRows - 1) / 2));
  const tail = Math.max(0, maxRows - head - 1);
  return [
    ...lines.slice(0, head),
    `${MARGIN}… ${lines.length - head - tail} more lines`,
    ...(tail > 0 ? lines.slice(-tail) : []),
  ];
}

export { renderMarkdown, stringWidth };
