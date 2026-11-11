import { stripAnsi } from "./style.ts";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// An emoji's width follows its presentation, as terminals draw it: emoji-default
// characters, and any emoji forced to emoji style by VS16, take two cells;
// text-default ones such as ▪ ❤ © take one unless VS16 follows.
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const WIDE_EMOJI_CLUSTER = /\p{Emoji_Presentation}|\p{Emoji}\ufe0f|\p{Regional_Indicator}|\u20e3/u;
// No emoji-presentation character sits below this code point (⌚).
const FIRST_EMOJI_PRESENTATION = 0x231a;
export const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

// Terminal cell width. Wide (East-Asian W/F) and emoji-presentation characters
// occupy two columns; combining marks and zero-width joiners occupy none.
// Getting this wrong is what makes CJK and emoji input break a layout.

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
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function charWidth(codePoint: number): number {
  if (codePoint === 0x09) return 4;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombining(codePoint)) return 0;
  if (isWide(codePoint)) return 2;
  return codePoint >= FIRST_EMOJI_PRESENTATION &&
    EMOJI_PRESENTATION.test(String.fromCodePoint(codePoint))
    ? 2
    : 1;
}

export function graphemeWidth(cluster: string): number {
  if (cluster.length === 1) {
    const code = cluster.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) return 1;
  }
  if (WIDE_EMOJI_CLUSTER.test(cluster)) return 2;
  let width = 0;
  for (const char of cluster) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

// Width of a string in terminal cells, ignoring ANSI styling.
export function stringWidth(text: string): number {
  const plain = text.includes("\u001b") ? stripAnsi(text) : text;
  if (PRINTABLE_ASCII.test(plain)) return plain.length;
  let width = 0;
  for (const cluster of graphemes(plain)) width += graphemeWidth(cluster);
  return width;
}

// Splits by Unicode extended grapheme cluster so cursor movement and wrapping
// cannot cut combining text, flags, modifiers, keycaps, or ZWJ emoji sequences.
export function graphemes(text: string): string[] {
  // Every printable ASCII character is its own cluster; the segmenter is the
  // slow part of laying out text that is almost always exactly that.
  if (PRINTABLE_ASCII.test(text)) return text.split("");
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
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
