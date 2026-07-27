import { RESET } from "./style.ts";
import { charWidth, stringWidth } from "./width.ts";

interface Token {
  text: string; // visible characters
  ansi: string; // styling that applies from here on
}

// Splits a styled string into visible characters, each carrying the ANSI state
// active at that point — so a wrapped line can re-open the styles it inherited.
function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let active = "";
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
    const char = String.fromCodePoint(line.codePointAt(i) ?? 0);
    tokens.push({ text: char, ansi: active });
    i += char.length;
  }
  return tokens;
}

function renderTokens(tokens: Token[]): string {
  let out = "";
  let current = "";
  for (const token of tokens) {
    if (token.ansi !== current) {
      if (current !== "") out += RESET;
      out += token.ansi;
      current = token.ansi;
    }
    out += token.text;
  }
  if (current !== "") out += RESET;
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
      current[current.length - 1]?.ansi === ""
    ) {
      current.pop();
    }
    out.push((out.length === 0 ? "" : indent) + renderTokens(current));
    current = [];
    currentWidth = 0;
    wordStart = 0;
  };

  for (const token of tokens) {
    const w = charWidth(token.text.codePointAt(0) ?? 0);

    if (currentWidth + w > usable) {
      // Prefer breaking at the last space; hard-break if the word is too long.
      if (wordStart > 0 && wordStart < current.length) {
        const carried = current.slice(wordStart);
        current = current.slice(0, wordStart);
        flush();
        current = carried;
        currentWidth = carried.reduce((sum, t) => sum + charWidth(t.text.codePointAt(0) ?? 0), 0);
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
