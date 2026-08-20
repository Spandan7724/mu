export type ColorDepth = "truecolor" | "ansi256" | "ansi16" | "none";

export function detectColorDepth(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.MU_FORCE_COLOR) return env.MU_FORCE_COLOR as ColorDepth;
  const colorterm = env.COLORTERM ?? "";
  if (/truecolor|24bit/i.test(colorterm)) return "truecolor";
  // Windows Terminal never sets COLORTERM but is always truecolor-capable.
  if (env.WT_SESSION !== undefined) return "truecolor";
  const term = env.TERM ?? "";
  if (/-256(color)?$/.test(term)) return "ansi256";
  if (term === "dumb") return "none";
  if (term === "") {
    // Unix shells always set TERM; an empty TERM there means no terminal
    // capability. Windows consoles (cmd.exe, PowerShell) never set TERM at
    // all, yet still support ANSI VT sequences since Windows 10.
    return platform === "win32" ? "ansi16" : "none";
  }
  return "ansi16";
}

const ESC = "\u001b[";
export const RESET = "\u001b[0m";

// mu's accent: mint at truecolor, bright cyan below it.
const ACCENT_RGB = [177, 249, 223] as const;
const ACCENT_256 = 158;
// Headings are mu's own colour rather than a hue of their own: a heading in mu's
// prose is mu speaking, and with eleven roles placed there is no slot left on the
// wheel that clears its neighbours. Aliased rather than copied so the two cannot
// drift apart silently.
const HEADING_RGB = ACCENT_RGB;
const HEADING_256 = ACCENT_256;
const LINK_RGB = [96, 165, 250] as const;
const LINK_256 = 75;
const CODE_RGB = [212, 212, 212] as const;
const CODE_256 = 188;
const CODE_ACCENT_RGB = [205, 214, 244] as const;
const CODE_ACCENT_256 = 189;
const RESUME_HINT_RGB = [102, 102, 102] as const;
const RESUME_HINT_256 = 241;
const PERMISSIVE_RGB = [74, 222, 128] as const;
const PERMISSIVE_256 = 114;
// Action classes. A tool cell's verb is the one word that says what happened, so
// it carries the hue and the rest of the row stays quiet.
const TOOL_READ_RGB = [129, 140, 248] as const;
const TOOL_READ_256 = 105;
const TOOL_MUTATE_RGB = [249, 179, 197] as const;
const TOOL_MUTATE_256 = 218;
const TOOL_EXEC_RGB = [177, 185, 249] as const;
const TOOL_EXEC_256 = 147;
const PATH_RGB = [148, 163, 184] as const;
const PATH_256 = 109;

export type SyntaxRole =
  | "comment"
  | "keyword"
  | "function"
  | "variable"
  | "string"
  | "number"
  | "type";

// Hues are spread so no two roles land within 20° of each other, and so none
// collides with the roles a fenced block shares its message with (link, heading,
// fence label). Comment and variable are deliberately desaturated: one has to
// recede, and the other is on nearly every token — colouring it would turn the
// block into a rainbow. `ansi16` is omitted where no ANSI colour is honest.
const SYNTAX_COLORS: Record<
  SyntaxRole,
  { rgb: readonly [number, number, number]; ansi256: number; ansi16?: number }
> = {
  comment: { rgb: [133, 139, 153], ansi256: 245, ansi16: 2 },
  keyword: { rgb: [216, 164, 234], ansi256: 182, ansi16: 95 },
  function: { rgb: [216, 227, 160], ansi256: 187, ansi16: 93 },
  variable: { rgb: [201, 209, 217], ansi256: 252 },
  string: { rgb: [167, 221, 157], ansi256: 151, ansi16: 92 },
  number: { rgb: [232, 187, 156], ansi256: 181, ansi16: 91 },
  type: { rgb: [148, 224, 224], ansi256: 116, ansi16: 96 },
};

export interface Style {
  accent?: boolean;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  green?: boolean;
  red?: boolean;
  heading?: boolean;
  link?: boolean;
  code?: boolean;
  codeAccent?: boolean;
  resumeHint?: boolean;
  permissive?: boolean;
  toolRead?: boolean;
  toolMutate?: boolean;
  toolExec?: boolean;
  path?: boolean;
  syntax?: SyntaxRole;
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
    else codes.push("96");
  }
  if (style.green) codes.push("32");
  if (style.red) codes.push("31");
  if (style.heading) {
    if (depth === "truecolor")
      codes.push(`38;2;${HEADING_RGB[0]};${HEADING_RGB[1]};${HEADING_RGB[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${HEADING_256}`);
    else codes.push("96");
  }
  if (style.link) {
    if (depth === "truecolor") codes.push(`38;2;${LINK_RGB[0]};${LINK_RGB[1]};${LINK_RGB[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${LINK_256}`);
    else codes.push("94");
  }
  if (style.code) {
    if (depth === "truecolor") codes.push(`38;2;${CODE_RGB[0]};${CODE_RGB[1]};${CODE_RGB[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${CODE_256}`);
  }
  if (style.codeAccent) {
    if (depth === "truecolor")
      codes.push(`38;2;${CODE_ACCENT_RGB[0]};${CODE_ACCENT_RGB[1]};${CODE_ACCENT_RGB[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${CODE_ACCENT_256}`);
  }
  if (style.resumeHint) {
    if (depth === "truecolor")
      codes.push(`38;2;${RESUME_HINT_RGB[0]};${RESUME_HINT_RGB[1]};${RESUME_HINT_RGB[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${RESUME_HINT_256}`);
    else codes.push("2");
  }
  if (style.permissive) {
    if (depth === "truecolor")
      codes.push(`38;2;${PERMISSIVE_RGB[0]};${PERMISSIVE_RGB[1]};${PERMISSIVE_RGB[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${PERMISSIVE_256}`);
    else codes.push("32");
  }
  if (style.toolRead) {
    if (depth === "truecolor")
      codes.push(`38;2;${TOOL_READ_RGB[0]};${TOOL_READ_RGB[1]};${TOOL_READ_RGB[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${TOOL_READ_256}`);
    else codes.push("94");
  }
  if (style.toolMutate) {
    if (depth === "truecolor")
      codes.push(`38;2;${TOOL_MUTATE_RGB[0]};${TOOL_MUTATE_RGB[1]};${TOOL_MUTATE_RGB[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${TOOL_MUTATE_256}`);
    else codes.push("95");
  }
  if (style.toolExec) {
    if (depth === "truecolor")
      codes.push(`38;2;${TOOL_EXEC_RGB[0]};${TOOL_EXEC_RGB[1]};${TOOL_EXEC_RGB[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${TOOL_EXEC_256}`);
    else codes.push("94");
  }
  // No ANSI-16 gray exists that is not `dim`, which paths are not; they fall
  // back to the terminal's own foreground rather than borrowing another role.
  if (style.path) {
    if (depth === "truecolor") codes.push(`38;2;${PATH_RGB[0]};${PATH_RGB[1]};${PATH_RGB[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${PATH_256}`);
  }
  if (style.syntax) {
    const color = SYNTAX_COLORS[style.syntax];
    if (depth === "truecolor") codes.push(`38;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}`);
    else if (depth === "ansi256") codes.push(`38;5;${color.ansi256}`);
    else if (color.ansi16 !== undefined) codes.push(String(color.ansi16));
  }
  if (codes.length === 0) return text;
  return `${ESC}${codes.join(";")}m${text}${RESET}`;
}

// Styling nested inside a tinted row. styleText always closes with a full reset,
// which would drop the row's tint for everything after it, so the tint is
// re-opened. Re-opening rather than closing narrowly (22m/39m) is what keeps
// this correct at ansi16, where the tint is itself a foreground colour.
export function styleWithin(text: string, style: Style, tint: string, depth: ColorDepth): string {
  const styled = styleText(text, style, depth);
  return styled === text || tint === "" ? styled : `${styled}${tint}`;
}

export function diffLineStyle(kind: "add" | "del" | "context", depth: ColorDepth): string {
  if (depth === "none" || kind === "context") return "";
  if (depth === "truecolor") {
    return kind === "add" ? `${ESC}48;2;2;40;0m` : `${ESC}48;2;61;1;0m`;
  }
  if (depth === "ansi256") {
    return kind === "add" ? `${ESC}48;5;22m` : `${ESC}48;5;52m`;
  }
  return kind === "add" ? `${ESC}32m` : `${ESC}31m`;
}

export const GLYPHS = {
  userMarker: "▸",
  rule: "│",
  // A plan is one object rather than a run of events, so its rule opens and
  // closes around the whole list instead of repeating per row.
  ruleOpen: "┌",
  ruleClose: "└",
  nestedRule: "│ │",
  ok: "✓",
  error: "✗",
  // Not started yet — the spinner's own "not this one" glyph, held still.
  pending: "▹",
  bullet: "•",
  separator: "·",
  spinner: ["▸▹▹", "▹▸▹", "▹▹▸"],
} as const;

export const MARGIN = "  ";
export const AGENT_LABEL = "mu";
// "mu" + two spaces, so continuation lines hang under the text.
export const AGENT_INDENT = " ".repeat(AGENT_LABEL.length + 2);

export function stripAnsi(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output requires it
      .replace(/\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output requires it
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
  );
}

export function hyperlink(url: string, text = url): string {
  // A control character in the payload would end the OSC early and let the
  // rest of the string run as a separate terminal command.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the check
  if (url.length === 0 || /[\u0000-\u001f\u007f-\u009f]/.test(url)) return text;
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}
