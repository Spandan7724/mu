import { sanitizeUntrusted } from "./sanitize.ts";
import { type ColorDepth, GLYPHS, type Style, styleText } from "./style.ts";
import { highlightCode } from "./syntax-highlight.ts";
import { stringWidth } from "./width.ts";
import { wrapLine } from "./wrap.ts";

interface InlineMatch {
  index: number;
  length: number;
  rendered: string;
}

interface TableRow {
  cells: string[];
}

const INLINE_PATTERNS = [
  /(?<!\\)`([^`\n]+)(?<!\\)`/,
  /(?<!\\)!\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
  /(?<!\\)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
  /(?<!\\)\*\*([^*\n]+)(?<!\\)\*\*/,
  /(?<!\\)__([^_\n]+)(?<!\\)__/,
  /(?<!\\)~~([^~\n]+)(?<!\\)~~/,
  /(?<!\\)\*([^*\n]+)(?<!\\)\*/,
  /(?<!\\)_([^_\n]+)(?<!\\)_/,
  /<(https?:\/\/[^>\s]+)>/,
] as const;

function mergeStyle(base: Style, addition: Style): Style {
  const changesColor =
    addition.accent ||
    addition.green ||
    addition.red ||
    addition.heading ||
    addition.link ||
    addition.code ||
    addition.codeAccent ||
    addition.syntax !== undefined;
  const { syntax: _syntax, ...baseWithoutSyntax } = base;
  return {
    ...(changesColor ? baseWithoutSyntax : base),
    ...(changesColor
      ? {
          accent: false,
          green: false,
          red: false,
          heading: false,
          link: false,
          code: false,
          codeAccent: false,
        }
      : {}),
    ...addition,
  };
}

function earliestInlineMatch(
  text: string,
  base: Style,
  depth: ColorDepth,
): InlineMatch | undefined {
  let earliest: InlineMatch | undefined;

  for (const [patternIndex, pattern] of INLINE_PATTERNS.entries()) {
    const match = pattern.exec(text);
    if (!match || match.index === undefined) continue;

    let rendered: string;
    const content = match[1] ?? "";
    switch (patternIndex) {
      case 0:
        rendered = styleText(content, mergeStyle(base, { code: true }), depth);
        break;
      case 1: {
        const url = match[2] ?? "";
        rendered = `${styleText("image", mergeStyle(base, { code: true }), depth)}${styleText(
          `: ${content} (${url})`,
          mergeStyle(base, { dim: true, link: true }),
          depth,
        )}`;
        break;
      }
      case 2: {
        const url = match[2] ?? "";
        const label = renderInline(
          content,
          depth,
          mergeStyle(base, { underline: true, link: true }),
        );
        rendered =
          content === url
            ? label
            : `${label}${styleText(
                ` (${url})`,
                mergeStyle(base, { dim: true, link: true }),
                depth,
              )}`;
        break;
      }
      case 3:
      case 4:
        rendered = renderInline(content, depth, mergeStyle(base, { bold: true }));
        break;
      case 5:
        rendered = renderInline(content, depth, mergeStyle(base, { strikethrough: true }));
        break;
      case 6:
      case 7:
        rendered = renderInline(content, depth, mergeStyle(base, { italic: true }));
        break;
      case 8:
        rendered = styleText(content, mergeStyle(base, { underline: true, link: true }), depth);
        break;
      default:
        rendered = match[0];
    }

    const candidate = { index: match.index, length: match[0].length, rendered };
    if (!earliest || candidate.index < earliest.index) earliest = candidate;
  }

  return earliest;
}

function renderInline(text: string, depth: ColorDepth, base: Style = {}): string {
  let remaining = text;
  let out = "";

  while (remaining.length > 0) {
    const match = earliestInlineMatch(remaining, base, depth);
    if (!match) {
      out += styleText(remaining.replace(/\\([\\`*_[\]()~])/g, "$1"), base, depth);
      break;
    }

    const before = remaining.slice(0, match.index);
    out += styleText(before.replace(/\\([\\`*_[\]()~])/g, "$1"), base, depth);
    out += match.rendered;
    remaining = remaining.slice(match.index + match.length);
  }

  return out;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
      current += char;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableDelimiter(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function visibleInlineText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\\([\\`*_[\]()~|])/g, "$1");
}

function fitStyled(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  const contentWidth = Math.max(1, width - 1);
  const first = wrapLine(text, contentWidth)[0] ?? "";
  return `${first}…`;
}

function renderTable(rows: TableRow[], width: number, depth: ColorDepth): string[] {
  const columns = Math.max(...rows.map((row) => row.cells.length));
  const separatorWidth = Math.max(0, columns - 1) * 3;
  const minimumCellWidth = 3;
  if (width < columns * minimumCellWidth + separatorWidth) {
    return rows.flatMap((row) =>
      wrapLine(row.cells.map(visibleInlineText).join(` ${GLYPHS.separator} `), width),
    );
  }

  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(
      minimumCellWidth,
      ...rows.map((row) => stringWidth(visibleInlineText(row.cells[column] ?? ""))),
    ),
  );
  const cellBudget = width - separatorWidth;
  if (widths.reduce((sum, cellWidth) => sum + cellWidth, 0) > cellBudget) {
    let low = minimumCellWidth;
    let high = Math.max(...widths);
    while (low < high) {
      const cap = Math.ceil((low + high) / 2);
      const total = widths.reduce((sum, cellWidth) => sum + Math.min(cellWidth, cap), 0);
      if (total <= cellBudget) low = cap;
      else high = cap - 1;
    }

    const natural = [...widths];
    for (let column = 0; column < widths.length; column++) {
      widths[column] = Math.min(widths[column] ?? minimumCellWidth, low);
    }
    let spare = cellBudget - widths.reduce((sum, cellWidth) => sum + cellWidth, 0);
    for (let column = widths.length - 1; column >= 0 && spare > 0; column--) {
      if ((widths[column] ?? 0) < (natural[column] ?? 0)) {
        widths[column] = (widths[column] ?? 0) + 1;
        spare--;
      }
    }
  }

  return rows.map((row, rowIndex) =>
    row.cells
      .concat(Array(Math.max(0, columns - row.cells.length)).fill(""))
      .map((cell, column) => {
        const base = rowIndex === 0 ? { bold: true, heading: true } : {};
        const styled = fitStyled(
          renderInline(cell, depth, base),
          widths[column] ?? minimumCellWidth,
        );
        return styled + " ".repeat(Math.max(0, (widths[column] ?? 0) - stringWidth(styled)));
      })
      .join(styleText(" │ ", { dim: true }, depth))
      .trimEnd(),
  );
}

function renderParagraph(
  lines: string[],
  width: number,
  depth: ColorDepth,
  style: Style = {},
): string[] {
  return wrapLine(renderInline(lines.join(" ").trim(), depth, style), width);
}

export function renderMarkdown(text: string, width: number, depth: ColorDepth): string[] {
  const safe = sanitizeUntrusted(text).replace(/\t/g, "    ");
  const source = safe.split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < source.length) {
    const raw = source[index] ?? "";
    if (raw.trim().length === 0) {
      if (out.length > 0 && out.at(-1) !== "") out.push("");
      index++;
      continue;
    }

    const fence = /^\s*(`{3,}|~{3,})\s*([^ ]*)?.*$/.exec(raw);
    if (fence) {
      const marker = fence[1] ?? "```";
      const language = fence[2]?.trim();
      if (language) out.push(styleText(language, { codeAccent: true, italic: true }, depth));
      index++;
      const codeLines: string[] = [];
      while (
        index < source.length &&
        !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(source[index] ?? "")
      ) {
        codeLines.push(source[index] ?? "");
        index++;
      }
      const rule = styleText(`${GLYPHS.rule} `, { codeAccent: true }, depth);
      for (const highlighted of highlightCode(codeLines.join("\n"), language, depth)) {
        const wrapped = wrapLine(highlighted, Math.max(1, width - 2));
        out.push(...wrapped.map((line) => rule + line));
      }
      if (index < source.length) index++;
      continue;
    }

    if (
      index + 1 < source.length &&
      raw.includes("|") &&
      isTableDelimiter(source[index + 1] ?? "")
    ) {
      const rows: TableRow[] = [{ cells: splitTableRow(raw) }];
      index += 2;
      while (index < source.length && (source[index] ?? "").includes("|")) {
        rows.push({ cells: splitTableRow(source[index] ?? "") });
        index++;
      }
      out.push(...renderTable(rows, width, depth));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const level = (heading[1] ?? "").length;
      const style: Style =
        level === 1
          ? { bold: true, heading: true, underline: true }
          : level <= 3
            ? { bold: true, heading: true }
            : { dim: true, bold: true, heading: true };
      out.push(...renderParagraph([heading[2] ?? ""], width, depth, style));
      index++;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(raw)) {
      out.push(styleText("─".repeat(Math.max(1, width)), { dim: true }, depth));
      index++;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      const quoteLines: string[] = [];
      while (index < source.length) {
        const next = /^\s*>\s?(.*)$/.exec(source[index] ?? "");
        if (!next) break;
        quoteLines.push(next[1] ?? "");
        index++;
      }
      const rule = styleText(`${GLYPHS.rule} `, { dim: true, link: true }, depth);
      out.push(
        ...renderParagraph(quoteLines, Math.max(1, width - 2), depth, {
          dim: true,
          italic: true,
          link: true,
        }).map((line) => rule + line),
      );
      continue;
    }

    const list = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(raw);
    if (list) {
      const indent = list[1] ?? "";
      const marker = /^\d/.test(list[2] ?? "") ? (list[2] ?? "") : "•";
      let content = list[3] ?? "";
      let renderedMarker = marker;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
      if (task) {
        renderedMarker = task[1]?.toLowerCase() === "x" ? GLYPHS.ok : "○";
        content = task[2] ?? "";
      }
      // A list marker is structure, not mu speaking; the accent is reserved for
      // the latter now that other roles carry their own colour.
      const markerStyle: Style = task
        ? task[1]?.toLowerCase() === "x"
          ? { green: true }
          : { dim: true }
        : { dim: true };
      const prefix = `${indent}${styleText(renderedMarker, markerStyle, depth)} `;
      const continuation = " ".repeat(stringWidth(prefix));
      const wrapped = wrapLine(prefix + renderInline(content, depth), width, continuation);
      out.push(...wrapped);
      index++;
      continue;
    }

    const paragraph = [raw];
    index++;
    while (index < source.length) {
      const next = source[index] ?? "";
      if (
        next.trim().length === 0 ||
        /^\s*(`{3,}|~{3,})/.test(next) ||
        /^(#{1,6})\s+/.test(next) ||
        /^\s*>\s?/.test(next) ||
        /^(\s*)([-+*]|\d+[.)])\s+/.test(next) ||
        /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(next) ||
        (index + 1 < source.length &&
          next.includes("|") &&
          isTableDelimiter(source[index + 1] ?? ""))
      ) {
        break;
      }
      paragraph.push(next);
      index++;
    }
    out.push(...renderParagraph(paragraph, width, depth));
  }

  while (out.at(-1) === "") out.pop();
  return out.length > 0 ? out : [""];
}
