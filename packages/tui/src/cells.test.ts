import { describe, expect, test } from "bun:test";
import {
  agentCell,
  compactionCell,
  diffCell,
  diffLinesFromHunks,
  errorCell,
  type RenderContext,
  thinkingCell,
  toolCell,
  userCell,
} from "./cells.ts";
import {
  APPROVAL_OPTIONS,
  approvalOverlay,
  composerRule,
  Editor,
  footer,
  formatCwdForFooter,
  formatTokens,
  renderMarkdown,
  SelectList,
  Spinner,
} from "./components.ts";
import { stripAnsi } from "./style.ts";
import { stringWidth } from "./width.ts";

// Golden lines are asserted on the *visible* text; styling is asserted
// separately so a colour change does not churn every snapshot.
const plain: RenderContext = { width: 60, depth: "none" };
const colored: RenderContext = { width: 60, depth: "truecolor" };
const footerData = {
  cwd: "~/code/mu",
  model: "claude-opus-5",
  contextPercent: 0.004,
  contextWindow: 272_000,
  inputTokens: 1_100,
  outputTokens: 11,
  costUsd: 0.14,
};

const visible = (lines: string[]) => lines.map(stripAnsi);

describe("transcript cells (golden lines)", () => {
  test("user turn", () => {
    expect(visible(userCell("add retry logic to the api client", plain))).toEqual([
      "  ▸ add retry logic to the api client",
    ]);
  });

  test("agent turn hangs continuation lines under the label", () => {
    const lines = visible(
      agentCell("I'll add exponential backoff to the fetch wrapper now.", {
        width: 40,
        depth: "none",
      }),
    );
    expect(lines[0]).toBe("  mu  I'll add exponential backoff to");
    expect(lines[1]).toBe("      the fetch wrapper now.");
  });

  test("tool cell collapses to a one-line summary", () => {
    expect(
      visible(
        toolCell({ name: "read", primaryArg: "src/api/client.ts", summary: "142 lines" }, plain),
      ),
    ).toEqual(["  │ read · src/api/client.ts · 142 lines"]);
  });

  test("failed tool cell carries the error glyph", () => {
    const line = visible(
      toolCell({ name: "bash", primaryArg: "bun test", isError: true, summary: "exit 1" }, plain),
    )[0];
    expect(line).toContain("✗");
    expect(line).toContain("bash");
  });

  test("nested (subagent) activity uses the double rule", () => {
    expect(visible(toolCell({ name: "read", nested: true }, plain))[0]).toBe("  │ │ read");
  });

  test("a running tool cell shows a bounded output tail", () => {
    const lines = visible(
      toolCell({ name: "bash", primaryArg: "bun test", tail: ["ok 1", "ok 2"] }, plain),
    );
    expect(lines.length).toBe(3);
    expect(lines[1]).toBe("  │ ok 1");
  });

  test("thinking collapses to one dim line by default", () => {
    const lines = visible(thinkingCell("First I should check the client.\nThen the tests.", plain));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("thinking · First I should check the client.");
  });

  test("thinking expands behind the rule", () => {
    const lines = visible(thinkingCell("one\ntwo", plain, true));
    expect(lines).toEqual(["  │ one", "  │ two"]);
  });

  test("error cell", () => {
    expect(visible(errorCell("could not reach the api", plain))[0]).toBe(
      "  ✗ could not reach the api",
    );
  });

  test("compaction boundary is visible and honest", () => {
    const line = visible(compactionCell(12345, plain))[0];
    expect(line).toContain("compacted");
    expect(line).toContain("12,345 tokens freed");
  });
});

describe("diff rendering", () => {
  const file = {
    path: "src/api/client.ts",
    added: 2,
    removed: 1,
    lines: [
      { kind: "context" as const, lineNumber: 41, text: "async function fetchJson(url) {" },
      { kind: "del" as const, lineNumber: 42, text: "  return fetch(url);" },
      { kind: "add" as const, lineNumber: 42, text: "  return withRetry(() => fetch(url));" },
    ],
  };

  test("header and gutters match the spec", () => {
    const lines = visible(diffCell(file, plain));
    expect(lines[0]).toBe("  │ src/api/client.ts · +2 −1");
    expect(lines[1]).toBe("  │    41   async function fetchJson(url) {");
    expect(lines[2]).toBe("  │    42 −   return fetch(url);");
    expect(lines[3]).toBe("  │    42 +   return withRetry(() => fetch(url));");
  });

  test("truecolor uses background tints", () => {
    const lines = diffCell(file, colored);
    expect(lines[3]).toContain("48;2;");
  });

  test("ANSI-16 degrades to foreground colour only", () => {
    const lines = diffCell(file, { width: 60, depth: "ansi16" });
    expect(lines[3]).toContain("[32m");
    expect(lines[3]).not.toContain("48;2;");
  });

  test("tabs become four spaces and long lines wrap", () => {
    const wide = diffCell(
      {
        path: "x.ts",
        added: 1,
        removed: 0,
        lines: [{ kind: "add", lineNumber: 1, text: `\t${"y".repeat(120)}` }],
      },
      { width: 40, depth: "none" },
    );
    expect(wide.length).toBeGreaterThan(2);
    for (const line of wide) expect(stringWidth(line)).toBeLessThanOrEqual(40);
  });

  test("unified hunks become numbered diff-cell lines", () => {
    expect(
      diffLinesFromHunks([
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -4,2 +4,3 @@",
        " same",
        "-old",
        "+new",
        "+extra",
      ]),
    ).toEqual([
      { kind: "context", lineNumber: 4, text: "same" },
      { kind: "del", lineNumber: 5, text: "old" },
      { kind: "add", lineNumber: 5, text: "new" },
      { kind: "add", lineNumber: 6, text: "extra" },
    ]);
  });
});

describe("components", () => {
  test("footer shows cwd, full context window, and separate token totals", () => {
    const lines = visible(footer(footerData, 60, "none"));
    expect(lines).toEqual(["  ~/code/mu", "  claude-opus-5 · 0.4%/272k · ↑1.1k ↓11 · $0.14"]);
  });

  test("footer shows background task count when present", () => {
    const lines = visible(footer({ ...footerData, backgroundTasks: 2 }, 60, "none"));
    expect(lines.at(-1)).toContain("2 bg");
  });

  test("footer token arrows use the accent without coloring their values", () => {
    const line = footer(footerData, 60, "truecolor").at(-1) ?? "";
    expect(line).toContain("\u001b[38;2;45;212;191m↑\u001b[0m");
    expect(line).toContain("\u001b[38;2;45;212;191m↓\u001b[0m");
    expect(line).not.toContain("\u001b[38;2;45;212;191m1.1k");
  });

  test("footer helpers match compact values and home paths", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_100)).toBe("1.1k");
    expect(formatTokens(272_000)).toBe("272k");
    expect(formatCwdForFooter("/home/test/code/mu", "/home/test")).toBe("~/code/mu");
    expect(formatCwdForFooter("/srv/mu", "/home/test")).toBe("/srv/mu");
  });

  test("composer rule is the only horizontal rule", () => {
    expect(stripAnsi(composerRule(20, "none"))).toBe("  ────────────────");
  });

  test("spinner cycles through the identity glyph frames", () => {
    const spinner = new Spinner();
    const first = stripAnsi(spinner.render("none"));
    spinner.tick();
    const second = stripAnsi(spinner.render("none"));
    expect(first).toBe("▸▹▹");
    expect(second).toBe("▹▸▹");
  });

  test("approval overlay lists the three options without a box", () => {
    const lines = visible(
      approvalOverlay(
        { title: "run bash", preview: ["rm -rf build"], selectedIndex: 0 },
        60,
        "none",
      ),
    );
    expect(lines[0]).toBe("  run bash");
    expect(lines[1]).toBe("  rm -rf build");
    expect(lines[2]).toBe(`  ${APPROVAL_OPTIONS.join(" · ")}`);
    for (const line of lines) expect(line).not.toContain("┌");
  });

  test("select list marks the selection with the accent glyph", () => {
    const list = new SelectList([
      { label: "claude-opus-5", description: "most capable" },
      { label: "gpt-5.1" },
    ]);
    const lines = visible(list.render(60, "none"));
    expect(lines[0]).toBe("  ▸ claude-opus-5 · most capable");
    expect(lines[1]).toBe("    gpt-5.1");
    list.move("down");
    expect(visible(list.render(60, "none"))[1]).toBe("  ▸ gpt-5.1");
  });

  test("markdown renders headings, bullets and code", () => {
    const lines = visible(renderMarkdown("# Title\n- one\n- two\n```\ncode\n```", 40, "none"));
    expect(lines[0]).toBe("Title");
    expect(lines[1]).toBe("• one");
    expect(lines[3]).toBe("code");
  });
});

describe("editor", () => {
  test("typing and backspace", () => {
    const editor = new Editor();
    editor.insert("hello");
    expect(editor.text).toBe("hello");
    editor.backspace();
    expect(editor.text).toBe("hell");
  });

  test("a pasted multi-line string becomes multiple lines, not a submit", () => {
    const editor = new Editor();
    editor.insert("line one\nline two");
    expect(editor.text).toBe("line one\nline two");
    expect(editor.render(40, "none").length).toBe(2);
  });

  test("backspace removes a whole grapheme", () => {
    const editor = new Editor();
    editor.insert("é");
    editor.backspace();
    expect(editor.text).toBe("");
  });

  test("backspace at the start of a line joins it to the previous one", () => {
    const editor = new Editor();
    editor.insert("ab\ncd");
    editor.move("home");
    editor.backspace();
    expect(editor.text).toBe("abcd");
  });

  test("submit clears the editor and records history", () => {
    const editor = new Editor();
    editor.insert("first");
    expect(editor.submit()).toBe("first");
    expect(editor.text).toBe("");

    editor.insert("second");
    editor.submit();
    editor.recallHistory("up");
    expect(editor.text).toBe("second");
    editor.recallHistory("up");
    expect(editor.text).toBe("first");
  });

  test("renders with the input marker and wraps long input", () => {
    const editor = new Editor();
    editor.insert("x".repeat(100));
    const lines = editor.render(40, "none");
    expect(stripAnsi(lines[0] ?? "")).toStartWith("  ▸ ");
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(40);
  });

  test("renders an inverse-video block cursor at the insertion point", () => {
    const editor = new Editor();
    editor.insert("abc");
    editor.setOffset(1);
    const rendered = editor.render(40, "none").join("\n");
    expect(rendered).toContain("a\u001b[7mb\u001b[0mc");

    editor.setOffset(3);
    expect(editor.render(40, "none").join("\n")).toContain("abc\u001b[7m \u001b[0m");
  });

  test("preserves the block cursor when it wraps onto a new row", () => {
    const editor = new Editor();
    editor.insert("x".repeat(36));
    const lines = editor.render(40, "none");
    expect(lines).toHaveLength(2);
    expect(lines.at(-1)).toContain("\u001b[7m \u001b[0m");
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(40);
  });

  test("CJK input does not break the layout", () => {
    const editor = new Editor();
    editor.insert("你好世界".repeat(10));
    for (const line of editor.render(30, "none")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(30);
    }
  });
});

describe("style conformance", () => {
  const everything = [
    ...userCell("hi", colored),
    ...agentCell("hello", colored),
    ...toolCell({ name: "read", primaryArg: "a.ts", summary: "1 line" }, colored),
    ...thinkingCell("thought", colored),
    ...errorCell("bad", colored),
    ...footer({ ...footerData, model: "m", contextPercent: 0.5, costUsd: 1 }, 60, "truecolor"),
  ].join("\n");

  test("no forbidden colours appear anywhere", () => {
    for (const code of ["[35m", "[34m", "[33m"]) {
      expect(everything).not.toContain(code);
    }
  });

  test("no borders or box drawing in the transcript", () => {
    for (const glyph of ["┌", "┐", "└", "┘", "├", "┤", "═"]) {
      expect(everything).not.toContain(glyph);
    }
  });

  test("every cell starts with the two-space page margin", () => {
    for (const line of stripAnsi(everything).split("\n")) {
      if (line.trim().length > 0) expect(line.startsWith("  ")).toBe(true);
    }
  });

  test("chrome text is lowercase", () => {
    const chrome = stripAnsi(
      [
        ...toolCell({ name: "read", summary: "142 lines" }, colored),
        ...footer({ ...footerData, model: "m", contextPercent: 0.1, costUsd: 0 }, 60, "truecolor"),
      ].join("\n"),
    );
    expect(chrome).toBe(chrome.toLowerCase());
  });
});
