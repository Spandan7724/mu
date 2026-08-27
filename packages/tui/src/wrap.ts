import { RESET } from "./style.ts";
import { graphemes, graphemeWidth, stringWidth } from "./width.ts";

interface Token {
  text: string; // visible characters
  ansi: string; // styling that applies from here on
  link: string; // OSC 8 opener active here, "" outside a hyperlink
}

const OSC8_OPEN = "\u001b]8;";

// Reuses the opener's terminator: a terminal that only accepts BEL-terminated
// hyperlinks would otherwise lose the link on every row after the first.
function closeLink(open: string): string {
  return open.endsWith("\u0007") ? `${OSC8_OPEN};\u0007` : `${OSC8_OPEN};\u001b\\`;
}

// Reads an OSC 8 sequence at `start`, returning the whole sequence and the
// index after it. The payload is `params;url`; an empty url closes the link.
function readLink(line: string, start: number): { open: string; next: number } | undefined {
  if (!line.startsWith(OSC8_OPEN, start)) return undefined;
  const bel = line.indexOf("\u0007", start + OSC8_OPEN.length);
  const st = line.indexOf("\u001b\\", start + OSC8_OPEN.length);
  const bodyEnd = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
  if (bodyEnd === -1) return undefined;
  const next = bodyEnd + (bodyEnd === bel ? 1 : 2);
  const body = line.slice(start + OSC8_OPEN.length, bodyEnd);
  const separator = body.indexOf(";");
  const url = separator === -1 ? "" : body.slice(separator + 1);
  return { open: url === "" ? "" : line.slice(start, next), next };
}

// Splits a styled string into visible graphemes, each carrying the ANSI state
// active at that point — so a wrapped line can re-open the styles it inherited.
function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let active = "";
  let link = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\u001b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      const code = line.slice(i, end + 1);
      active = code === RESET ? "" : active + code;
      i = end + 1;
      continue;
    }
    const hyperlink = readLink(line, i);
    if (hyperlink) {
      link = hyperlink.open;
      i = hyperlink.next;
      continue;
    }
    const nextEscape = line.indexOf("\u001b", i);
    const end = nextEscape === -1 ? line.length : nextEscape;
    if (end === i) {
      tokens.push({ text: line[i] ?? "", ansi: active, link });
      i++;
      continue;
    }
    for (const cluster of graphemes(line.slice(i, end))) {
      tokens.push({ text: cluster, ansi: active, link });
    }
    i = end;
  }
  return tokens;
}

function renderTokens(tokens: Token[]): string {
  let out = "";
  let current = "";
  let link = "";
  for (const token of tokens) {
    if (token.link !== link) {
      if (link !== "") out += closeLink(link);
      out += token.link;
      link = token.link;
    }
    if (token.ansi !== current) {
      if (current !== "") out += RESET;
      out += token.ansi;
      current = token.ansi;
    }
    out += token.text;
  }
  if (current !== "") out += RESET;
  if (link !== "") out += closeLink(link);
  return out;
}

// Word-wraps at a cell width, preserving ANSI styles across the break.
// Words longer than the width are hard-broken rather than overflowing.
export function wrapLine(line: string, width: number, indent = ""): string[] {
  if (width <= 0) return [line];
  const indentWidth = stringWidth(indent);
  const usable = Math.max(1, width - indentWidth);

  const tokens = tokenize(line);
  if (tokens.length === 0) return [""];

  const out: string[] = [];
  let current: Token[] = [];
  let currentWidth = 0;
  let wordStart = 0; // index in `current` where the in-progress word began

  const flush = () => {
    // A space that sits exactly at the break is consumed by the break.
    while (
      current.length > 0 &&
      current[current.length - 1]?.text === " " &&
      current[current.length - 1]?.ansi === "" &&
      current[current.length - 1]?.link === ""
    ) {
      current.pop();
    }
    out.push((out.length === 0 ? "" : indent) + renderTokens(current));
    current = [];
    currentWidth = 0;
    wordStart = 0;
  };

  for (const token of tokens) {
    const w = graphemeWidth(token.text);

    if (currentWidth + w > usable) {
      // Prefer breaking at the last space; hard-break if the word is too long.
      // Breaking after leading margin alone would emit a blank row and push the
      // word to column zero, which is what a long URL used to do.
      const prefixHasText = current.slice(0, wordStart).some((t) => t.text !== " ");
      if (prefixHasText && wordStart > 0 && wordStart < current.length) {
        const carried = current.slice(wordStart);
        current = current.slice(0, wordStart);
        flush();
        current = carried;
        currentWidth = carried.reduce((sum, t) => sum + graphemeWidth(t.text), 0);
        wordStart = 0;
      } else {
        flush();
      }
    }

    current.push(token);
    currentWidth += w;
    if (token.text === " ") wordStart = current.length;
  }

  if (current.length > 0) flush();
  return out.length > 0 ? out : [""];
}

export function wrapText(text: string, width: number, indent = ""): string[] {
  return text.split("\n").flatMap((line) => wrapLine(line, width, indent));
}

export function terminalRows(lines: string[], width: number): string[] {
  const safeWidth = Math.max(1, width);
  return lines.flatMap((line) => wrapText(line, safeWidth));
}
