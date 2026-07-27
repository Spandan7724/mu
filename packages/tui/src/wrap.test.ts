import { describe, expect, test } from "bun:test";
import { detectColorDepth, stripAnsi, styleText } from "./style.ts";
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

  test("wrapText splits on newlines first", () => {
    expect(wrapText("one\ntwo", 20)).toEqual(["one", "two"]);
  });

  test("an empty line stays a line", () => {
    expect(wrapText("", 10)).toEqual([""]);
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
});
