import { stripAnsi } from "./style.ts";

// Terminal cell width. Wide (East-Asian W/F) and emoji occupy two columns;
// combining marks and zero-width joiners occupy none. Getting this wrong is
// what makes CJK and emoji input break a layout.

function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0x200d || // zero-width joiner
    code === 0x200b
  );
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, Kangxi
    (code >= 0x3041 && code <= 0x33ff) || // Hiragana … CJK compatibility
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) || // emoji
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function charWidth(codePoint: number): number {
  if (codePoint === 0x09) return 4;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombining(codePoint)) return 0;
  return isWide(codePoint) ? 2 : 1;
}

// Width of a string in terminal cells, ignoring ANSI styling.
export function stringWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += charWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

// Splits into grapheme-ish clusters so a wide char or emoji sequence is never
// cut in half.
export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (out.length > 0 && isCombining(code)) {
      out[out.length - 1] += char;
    } else {
      out.push(char);
    }
  }
  return out;
}

// Truncates to a cell width, appending an ellipsis when it had to cut.
export function truncateToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
  if (stringWidth(text) <= maxWidth) return text;
  const suffixWidth = stringWidth(ellipsis);
  let width = 0;
  let out = "";
  for (const cluster of graphemes(text)) {
    const next = width + stringWidth(cluster);
    if (next > maxWidth - suffixWidth) break;
    out += cluster;
    width = next;
  }
  return out + ellipsis;
}

export function padToWidth(text: string, width: number): string {
  const current = stringWidth(text);
  return current >= width ? text : text + " ".repeat(width - current);
}
