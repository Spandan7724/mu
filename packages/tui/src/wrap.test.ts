import { describe, expect, test } from "bun:test";
import { detectColorDepth, hyperlink, stripAnsi, styleText } from "./style.ts";
import { charWidth, graphemes, stringWidth, truncateToWidth } from "./width.ts";
import { wrapLine, wrapText } from "./wrap.ts";

describe("width measurement", () => {
  test("ascii is one cell per character", () => {
    expect(stringWidth("hello")).toBe(5);
  });

  test("CJK characters take two cells", () => {
    expect(stringWidth("你好")).toBe(4);
    expect(charWidth("好".codePointAt(0) ?? 0)).toBe(2);
  });

  test("emoji take two cells", () => {
    expect(stringWidth("🎉")).toBe(2);
  });

  test("combining marks take none", () => {
    expect(stringWidth("é")).toBe(1);
  });

  test("ANSI codes are not counted", () => {
    expect(stringWidth(styleText("hi", { accent: true }, "truecolor"))).toBe(2);
  });

  test("graphemes keep combining marks attached", () => {
    expect(graphemes("éx")).toEqual(["é", "x"]);
  });

  test("truncate respects wide characters", () => {
    expect(stringWidth(truncateToWidth("你好世界", 5))).toBeLessThanOrEqual(5);
    expect(truncateToWidth("hello world", 8)).toBe("hello w…");
    expect(truncateToWidth("short", 10)).toBe("short");
  });
});

describe("wrapping", () => {
  test("breaks at spaces", () => {
    expect(wrapLine("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });

  test("hard-breaks words longer than the width", () => {
    const lines = wrapLine("supercalifragilistic", 8);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(8);
  });

  test("applies a hanging indent to continuation lines", () => {
    const lines = wrapLine("alpha beta gamma delta", 12, "    ");
    expect(lines[0]?.startsWith(" ")).toBe(false);
    expect(lines[1]?.startsWith("    ")).toBe(true);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(12);
  });

  test("never exceeds the width with CJK content", () => {
    const lines = wrapLine("你好世界你好世界你好", 7);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(7);
  });

  test("preserves styling across a wrap and closes it on each line", () => {
    const styled = styleText("alpha beta gamma delta", { accent: true }, "truecolor");
    const lines = wrapLine(styled, 12);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).toContain("[");
      expect(line.endsWith("[0m")).toBe(true);
      // The visible text must survive intact.
      expect(stripAnsi(line).length).toBeGreaterThan(0);
    }
    expect(lines.map((l) => stripAnsi(l).trim()).join(" ")).toBe("alpha beta gamma delta");
  });

  test("a long unbreakable word keeps the leading margin on its first row", () => {
    const lines = wrapLine(`  ${"u".repeat(30)}`, 12);
    expect(lines[0]).toBe("  uuuuuuuuuu");
    expect(lines.join("")).toBe(`  ${"u".repeat(30)}`);
  });

  test("wrapText splits on newlines first", () => {
    expect(wrapText("one\ntwo", 20)).toEqual(["one", "two"]);
  });

  test("an empty line stays a line", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });
});

describe("hyperlinks", () => {
  const url = `https://auth.example.com/authorize?${"a".repeat(120)}`;

  test("a hyperlink wraps its visible text, not its destination", () => {
    const lines = wrapLine(`  ${hyperlink(url)}`, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map(stripAnsi).join("")).toBe(`  ${url}`);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(40);
  });

  test("every wrapped row reopens and closes the link with the same terminator", () => {
    const lines = wrapLine(hyperlink(url), 40);
    for (const line of lines) {
      expect(line.startsWith(`\u001b]8;;${url}\u0007`)).toBe(true);
      expect(line.endsWith("\u001b]8;;\u0007")).toBe(true);
    }
  });

  test("a styled hyperlink keeps both its colour and its destination per row", () => {
    const lines = wrapLine(styleText(hyperlink(url), { link: true }, "truecolor"), 40);
    for (const line of lines) {
      expect(line).toContain(`\u001b]8;;${url}\u0007`);
      expect(line).toContain("38;2;96;165;250m");
    }
  });

  test("link text may differ from the destination", () => {
    const [line] = wrapLine(hyperlink(url, "ctrl+click to open"), 40);
    expect(stripAnsi(line as string)).toBe("ctrl+click to open");
    expect(stringWidth(line as string)).toBe(18);
  });

  test("a destination carrying control characters is not linked", () => {
    expect(hyperlink("https://x.test/\u0007\u001b]0;pwned", "label")).toBe("label");
    expect(hyperlink("", "label")).toBe("label");
  });

  test("ST-terminated links round-trip with their own terminator", () => {
    const lines = wrapLine(`\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`, 40);
    for (const line of lines) {
      expect(line.startsWith(`\u001b]8;;${url}\u001b\\`)).toBe(true);
      expect(line.endsWith("\u001b]8;;\u001b\\")).toBe(true);
    }
  });
});

describe("colour depth", () => {
  test("NO_COLOR disables styling entirely", () => {
    expect(detectColorDepth({ NO_COLOR: "1" })).toBe("none");
    expect(styleText("x", { accent: true }, "none")).toBe("x");
  });

  test("COLORTERM signals truecolor", () => {
    expect(detectColorDepth({ COLORTERM: "truecolor" })).toBe("truecolor");
  });

  test("256-colour terminals are detected from TERM", () => {
    expect(detectColorDepth({ TERM: "xterm-256color" })).toBe("ansi256");
  });

  test("the accent degrades to plain cyan at 16 colours", () => {
    expect(styleText("mu", { accent: true }, "ansi16")).toContain("[36m");
    expect(styleText("mu", { accent: true }, "truecolor")).toContain("38;2;45;212;191");
  });

  test("the Markdown palette degrades by terminal colour depth", () => {
    expect(styleText("heading", { heading: true }, "truecolor")).toContain("38;2;250;204;21");
    expect(styleText("link", { link: true }, "ansi256")).toContain("38;5;75");
    expect(styleText("code", { code: true }, "truecolor")).toContain("38;2;212;212;212");
    expect(styleText("code", { code: true }, "ansi256")).toContain("38;5;188");
    expect(styleText("code", { code: true }, "ansi16")).toBe("code");
    expect(styleText("rule", { codeAccent: true }, "truecolor")).toContain("38;2;205;214;244");
    expect(styleText("rule", { codeAccent: true }, "ansi256")).toContain("38;5;189");
    expect(styleText("rule", { codeAccent: true }, "ansi16")).toBe("rule");
  });

  test("the session resume label uses its muted semantic color", () => {
    expect(styleText("resume", { resumeHint: true }, "truecolor")).toContain("38;2;102;102;102");
    expect(styleText("resume", { resumeHint: true }, "ansi256")).toContain("38;5;241");
    expect(styleText("resume", { resumeHint: true }, "ansi16")).toContain("[2m");
    expect(styleText("resume", { resumeHint: true }, "none")).toBe("resume");
  });
});
