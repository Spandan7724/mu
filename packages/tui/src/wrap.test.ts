import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.ts";
import { detectColorDepth, hyperlink, stripAnsi, styleText } from "./style.ts";
import { charWidth, graphemes, stringWidth, truncateToWidth } from "./width.ts";
import { terminalRows, wrapLine, wrapText } from "./wrap.ts";

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
    expect(stringWidth("⌚")).toBe(2);
    expect(charWidth("🎉".codePointAt(0) ?? 0)).toBe(2);
  });

  test("text-default emoji take one cell unless VS16 makes them emoji", () => {
    for (const symbol of ["▪", "▫", "❤", "©", "™", "↔", "☀", "✔", "🌡"]) {
      expect(stringWidth(symbol)).toBe(1);
      expect(stringWidth(`${symbol}\ufe0f`)).toBe(2);
    }
    expect(charWidth("▪".codePointAt(0) ?? 0)).toBe(1);
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

  test("emoji sequences are one two-cell grapheme", () => {
    for (const emoji of ["👨‍👩‍👧‍👦", "👍🏽", "1️⃣", "🇺🇸"]) {
      expect(graphemes(emoji)).toEqual([emoji]);
      expect(stringWidth(emoji)).toBe(2);
    }
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

  test("never splits joined emoji, modifiers, keycaps, or flags", () => {
    const emoji = ["👨‍👩‍👧‍👦", "👍🏽", "1️⃣", "🇺🇸"];
    expect(wrapLine(emoji.join(""), 2)).toEqual(emoji);
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

  test("a styled hyperlink keeps both its styling and its destination per row", () => {
    const lines = wrapLine(styleText(hyperlink(url), { link: true }, "truecolor"), 40);
    for (const line of lines) {
      expect(line).toContain(`\u001b]8;;${url}\u0007`);
      expect(line).not.toBe(stripAnsi(line));
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

  test("an empty TERM means no color on Unix", () => {
    expect(detectColorDepth({ TERM: "" }, "linux")).toBe("none");
  });

  test("Windows consoles lack TERM entirely but still support ANSI16", () => {
    expect(detectColorDepth({}, "win32")).toBe("ansi16");
  });

  test("Windows Terminal sessions are truecolor regardless of TERM", () => {
    expect(detectColorDepth({ WT_SESSION: "abc" }, "win32")).toBe("truecolor");
  });

  test("the Markdown palette degrades by terminal colour depth", () => {
    // Headings render in the accent — the role is separate, the colour is not.
    for (const depth of ["truecolor", "ansi256", "ansi16"] as const) {
      expect(styleText("x", { heading: true }, depth)).toBe(
        styleText("x", { accent: true }, depth),
      );
    }
    // ANSI-16 has no honest slot for these roles: they fall back to plain text.
    expect(styleText("code", { code: true }, "ansi16")).toBe("code");
    expect(styleText("rule", { codeAccent: true }, "ansi16")).toBe("rule");
  });

  test("the session resume label degrades to dim and then to plain text", () => {
    expect(styleText("resume", { resumeHint: true }, "ansi16")).toContain("[2m");
    expect(styleText("resume", { resumeHint: true }, "none")).toBe("resume");
  });
});

describe("layout of lines that need no break", () => {
  const ESC = "\u001b";
  test("styles are normalised and trailing blanks dropped exactly as when wrapping", () => {
    const cases: [string, string][] = [
      ["plain text   ", "plain text"],
      [
        `${ESC}[1mbold${ESC}[22m then plain  `,
        `${ESC}[1mbold${ESC}[0m${ESC}[1m${ESC}[22m then plain  ${ESC}[0m`,
      ],
      [
        `${ESC}[2m  dim margin${ESC}[0m ${ESC}[1mhead${ESC}[0m   `,
        `${ESC}[2m  dim margin${ESC}[0m ${ESC}[1mhead${ESC}[0m`,
      ],
      [
        `${ESC}]8;;https://x.y\u0007link${ESC}]8;;\u0007 after `,
        `${ESC}]8;;https://x.y\u0007link${ESC}]8;;\u0007 after`,
      ],
      ["tab\there 中文 🙂 e\u0301", "tab\there 中文 🙂 e\u0301"],
      [`${ESC}[1m   ${ESC}[0m`, `${ESC}[1m   ${ESC}[0m`],
      ["   ", ""],
      [`${ESC}[38;2;1;2;3m`, ""],
      [`lone ${ESC} escape`, `lone ${ESC} escape`],
    ];
    for (const [line, expected] of cases) expect(wrapLine(line, 60)).toEqual([expected]);
  });

  test("a line one cell too wide still breaks", () => {
    expect(wrapLine("12345 7890", 10)).toEqual(["12345 7890"]);
    expect(wrapLine("12345 78901", 10)).toEqual(["12345", "78901"]);
    expect(wrapLine("中文中文中", 10)).toEqual(["中文中文中"]);
    expect(wrapLine("中文中文中a", 10)).toEqual(["中文中文中", "a"]);
  });

  test("ascii shortcuts agree with full measurement", () => {
    expect(graphemes("a b~")).toEqual(["a", " ", "b", "~"]);
    expect(graphemes("a\r\nb")).toEqual(["a", "\r\n", "b"]);
    expect(stringWidth("a\tb")).toBe(6);
    expect(stringWidth(`${ESC}[1mab${ESC}[0m`)).toBe(2);
    expect(stringWidth("e\u0301x")).toBe(2);
  });
});

describe("remembered layout", () => {
  test("physical rows are the same whether remembered or not, per width", () => {
    const lines = ["short", "a much longer line that will not fit in ten cells", "", "中文 text"];
    const narrow = terminalRows(lines, 10);
    const wide = terminalRows(lines, 80);
    expect(wide).toEqual(lines);
    expect(narrow.length).toBeGreaterThan(lines.length);
    expect(terminalRows(lines, 10)).toEqual(narrow);
    expect(terminalRows(lines, 80)).toEqual(wide);
    narrow.push("caller-owned");
    expect(terminalRows(lines, 10)).not.toContain("caller-owned");
  });

  test("lines pushed out of the memory are laid out again correctly", () => {
    const first = terminalRows(["the first line of many"], 12);
    for (let batch = 0; batch < 10; batch++) {
      terminalRows(
        Array.from({ length: 1_000 }, (_, index) => `filler line ${batch}-${index}`),
        12,
      );
    }
    expect(terminalRows(["the first line of many"], 12)).toEqual(first);
  });

  test("markdown blocks are remembered per width and colour depth", () => {
    const text =
      "# Title\n\nA paragraph with **bold** text that is long enough to wrap at a narrow width.\n\n- item `one`\n- [x] done\n\n```ts\nconst a = 1;\n```";
    const narrow = renderMarkdown(text, 30, "truecolor");
    const wide = renderMarkdown(text, 90, "truecolor");
    const plain = renderMarkdown(text, 30, "none");
    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(plain.join("\n")).not.toContain("\u001b");
    expect(narrow.join("\n")).toContain("\u001b");
    expect(plain.map(stripAnsi)).toEqual(narrow.map(stripAnsi));
    expect(renderMarkdown(text, 30, "truecolor")).toEqual(narrow);
    expect(renderMarkdown(text, 90, "truecolor")).toEqual(wide);
    // A reply rendered as it grows ends as the same rows as one rendered whole.
    for (let end = 1; end < text.length; end += 7) renderMarkdown(text.slice(0, end), 30, "none");
    expect(renderMarkdown(text, 30, "none")).toEqual(plain);
  });
});
