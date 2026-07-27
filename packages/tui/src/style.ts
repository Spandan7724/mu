
export type ColorDepth = "truecolor" | "ansi256" | "ansi16" | "none";

export function detectColorDepth(
  env: Record<string, string | undefined> = process.env,
): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.MU_FORCE_COLOR) return env.MU_FORCE_COLOR as ColorDepth;
  const colorterm = env.COLORTERM ?? "";
  if (/truecolor|24bit/i.test(colorterm)) return "truecolor";
  const term = env.TERM ?? "";
  if (/-256(color)?$/.test(term)) return "ansi256";
  if (term === "dumb" || term === "") return "none";
  return "ansi16";
}

const ESC = "\u001b[";
export const RESET = "\u001b[0m";

// mu's accent: teal at truecolor, plain cyan below it.
const ACCENT_RGB = [45, 212, 191] as const;
const ACCENT_256 = 43;

export interface Style {
  accent?: boolean;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  green?: boolean;
  red?: boolean;
}

export function styleText(text: string, style: Style, depth: ColorDepth): string {
  if (depth === "none" || text.length === 0) return text;
  const codes: string[] = [];
  if (style.bold) codes.push("1");
  if (style.dim) codes.push("2");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.strikethrough) codes.push("9");
  if (style.accent) {
    if (depth === "truecolor")
      codes.push(`38;2;${ACCENT_RGB[0]};${ACCENT_RGB[1]};${ACCENT_RGB[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${ACCENT_256}`);
    else codes.push("36");
  }
  if (style.green) codes.push("32");
  if (style.red) codes.push("31");
  if (codes.length === 0) return text;
  return `${ESC}${codes.join(";")}m${text}${RESET}`;
}

export function diffLineStyle(kind: "add" | "del" | "context", depth: ColorDepth): string {
  if (depth === "none" || kind === "context") return "";
  if (depth === "truecolor") {
    return kind === "add" ? `${ESC}48;2;33;41;34m` : `${ESC}48;2;60;23;15m`;
  }
  if (depth === "ansi256") {
    return kind === "add" ? `${ESC}48;5;22m` : `${ESC}48;5;52m`;
  }
  return kind === "add" ? `${ESC}32m` : `${ESC}31m`;
}

export const GLYPHS = {
  userMarker: "▸",
  rule: "│",
  nestedRule: "│ │",
  ok: "✓",
  error: "✗",
  separator: "·",
  spinner: ["▸▹▹", "▹▸▹", "▹▹▸"],
} as const;

export const MARGIN = "  ";
export const AGENT_LABEL = "mu";
// "mu" + two spaces, so continuation lines hang under the text.
export const AGENT_INDENT = " ".repeat(AGENT_LABEL.length + 2);

export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output requires it
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}
