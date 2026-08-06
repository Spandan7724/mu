import { describe, expect, test } from "bun:test";
import {
  agentCell,
  compactionCell,
  diffCell,
  diffLinesFromHunks,
  errorCell,
  type RenderContext,
  taskCell,
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
  queuedInputPreview,
  renderMarkdown,
  SelectList,
  Spinner,
} from "./components.ts";
import { diffLineStyle, RESET, stripAnsi, styleText } from "./style.ts";
import { stringWidth } from "./width.ts";

// Golden lines are asserted on the *visible* text; styling is asserted
// separately so a colour change does not churn every snapshot.
const ACCENT = "\u001b[38;2;177;249;223m";
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
    ).toEqual(["  │ read src/api/client.ts · 142 lines"]);
  });

  test("failed tool cell carries the error glyph", () => {
    const line = visible(
      toolCell({ name: "bash", primaryArg: "bun test", isError: true, summary: "exit 1" }, plain),
    )[0];
    expect(line).toContain("✗");
    expect(line).toContain("bash");
  });

  test("tool summaries preserve status and fit narrow terminals", () => {
    const line = toolCell(
      {
        name: "running",
        primaryArg: "a very long command with more arguments",
        primaryRole: "code",
        isError: true,
        summary: "exit 123456",
      },
      { width: 20, depth: "truecolor" },
    )[0];
    expect(stringWidth(line ?? "")).toBeLessThanOrEqual(20);
    expect(stripAnsi(line ?? "")).toContain("✗");
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

  test("multiline tool arguments occupy separately tracked rows", () => {
    const lines = visible(
      toolCell(
        {
          name: "running",
          primaryArg: "set -e\nPORT=18080 cargo run &\npid=$!",
          primaryRole: "code",
        },
        plain,
      ),
    );

    expect(lines).toEqual(["  │ running set -e", "  │ PORT=18080 cargo run &", "  │ pid=$!"]);
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
  });

  test("a background task has a live tail and a compact exit outcome", () => {
    expect(
      visible(
        taskCell(
          {
            taskId: "task_1",
            command: "bun test",
            status: "running",
            tail: ["test output"],
          },
          plain,
        ),
      ),
    ).toEqual(["  │ task_1 · bun test", "  │ test output"]);

    expect(
      visible(
        taskCell(
          {
            taskId: "task_1",
            command: "bun test",
            status: "exited",
            exitCode: 0,
            durationMs: 340,
          },
          plain,
        ),
      ),
    ).toEqual(["  │ task_1 · bun test · ✓ · 340ms"]);
  });

  test("background task failures and kills are explicit", () => {
    expect(
      visible(
        taskCell(
          {
            taskId: "task_2",
            command: "bun test",
            status: "exited",
            exitCode: 3,
            durationMs: 1_200,
          },
          plain,
        ),
      )[0],
    ).toBe("  │ task_2 · bun test · ✗ · exit 3 · 1.2s");
    expect(
      visible(
        taskCell(
          {
            taskId: "task_3",
            command: "bun dev",
            status: "killed",
            durationMs: 60_000,
          },
          plain,
        ),
      )[0],
    ).toBe("  │ task_3 · bun dev · ✗ · killed · 1m");
  });

  test("background task summaries fit narrow terminals and color outcomes semantically", () => {
    const narrow = taskCell(
      {
        taskId: "task_123456789",
        command: "a very long background command that keeps going",
        status: "exited",
        exitCode: 3,
        durationMs: 12_000,
      },
      { width: 40, depth: "none" },
    );
    expect(stringWidth(narrow[0] ?? "")).toBeLessThanOrEqual(40);

    const ok = taskCell(
      { taskId: "t1", command: "test", status: "exited", exitCode: 0 },
      colored,
    )[0];
    const failed = taskCell(
      { taskId: "t2", command: "test", status: "exited", exitCode: 1 },
      colored,
    )[0];
    expect(ok).toContain("[32m");
    expect(failed).toContain("[31m");
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
    expect(line).toContain("• Context compacted");
    expect(line).toContain("12,345 tokens freed");
  });

  test("compaction boundary includes rich checkpoint accounting", () => {
    const rendered = visible(
      compactionCell(64000, plain, {
        contextTokensBefore: 92000,
        contextTokensAfter: 28000,
        keptTokens: 20000,
        toolResultsCleared: 7,
      }),
    )
      .join(" ")
      .replace(/\s+/g, " ");
    expect(rendered).toContain("• Context compacted");
    expect(rendered).toContain("92,000 → 28,000");
    expect(rendered).toContain("64,000 freed");
    expect(rendered).toContain("7 tool outputs cleared");
  });

  test("a no-op compaction says so instead of reporting a boundary", () => {
    const line = visible(compactionCell(0, plain, { status: "noop" }))[0];
    expect(line).toBe("  • Context already compact");
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

  test("the tint opens before the line number and survives the nested styles", () => {
    const [, , removed = "", added = ""] = diffCell(file, colored);
    for (const [line, tint] of [
      [removed, diffLineStyle("del", "truecolor")],
      [added, diffLineStyle("add", "truecolor")],
    ] as const) {
      expect(line.lastIndexOf(tint, line.indexOf("4"))).toBeGreaterThan(-1);
      // Each nested style resets in full, so within the tinted region every
      // reset but the closing one has to reopen the tint.
      const resumed = line.slice(line.indexOf(tint)).split(RESET).slice(1);
      expect(resumed.at(-1)).toBe("");
      for (const segment of resumed.slice(0, -1)) expect(segment.startsWith(tint)).toBe(true);
    }
    // A context line is not a change, so it stays untinted.
    expect(diffCell(file, colored)[1]).not.toContain(diffLineStyle("add", "truecolor"));
  });

  test("a changed row fills the width and keeps its number dim", () => {
    const [, context = "", removed = "", added = ""] = diffCell(file, colored);
    expect(stringWidth(removed)).toBe(colored.width);
    expect(stringWidth(added)).toBe(colored.width);
    // Context is not a change: no band, so nothing to pad out either.
    expect(stringWidth(context)).toBeLessThan(colored.width);
    // Only the sign is coloured; the number reads the same on every row.
    for (const [line, number] of [
      [context, "   41"],
      [removed, "   42"],
      [added, "   42"],
    ] as const) {
      expect(line).toContain(styleText(number, { dim: true }, "truecolor"));
    }
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
    expect(line).toContain("\u001b[38;2;177;249;223m↑\u001b[0m");
    expect(line).toContain("\u001b[38;2;177;249;223m↓\u001b[0m");
    expect(line).not.toContain("\u001b[38;2;177;249;223m1.1k");
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

  test("queued input is labeled, sanitized, and width-safe", () => {
    expect(visible(queuedInputPreview("follow-up", "run tests when done", 60, "none"))).toEqual([
      "  ▸ follow-up · run tests when done",
    ]);
    expect(visible(queuedInputPreview("steer", "dojopj", 60, "none", true))).toEqual([
      "  ▸ steer · dojopj · alt+up edit",
    ]);

    const narrow = queuedInputPreview("steer", "change direction now", 14, "truecolor");
    expect(visible(narrow)[0]).toBe("  ▸ steer");
    for (const line of narrow) expect(stringWidth(line)).toBeLessThanOrEqual(14);

    const long = visible(queuedInputPreview("follow-up", "word ".repeat(40), 24, "none"));
    expect(long).toHaveLength(3);
    expect(long.at(-1)).toContain("… +");

    expect(
      visible(queuedInputPreview("follow-up", "safe\u001b[2J text", 60, "none")).join(""),
    ).toContain("safe text");
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

  test("select list truncates long session titles to the terminal width", () => {
    const list = new SelectList([
      { label: "implement a much longer first user prompt that cannot fit on one row" },
    ]);
    const [line] = visible(list.render(24, "none"));
    expect(line).toBe("  ▸ implement a much lo…");
    expect(stringWidth(line ?? "")).toBeLessThanOrEqual(24);
  });

  test("markdown renders headings, bullets and code", () => {
    const lines = visible(renderMarkdown("# Title\n- one\n- two\n```\ncode\n```", 40, "none"));
    expect(lines[0]).toBe("Title");
    expect(lines[1]).toBe("• one");
    expect(lines[3]).toBe("│ code");
  });

  test("markdown renders inline emphasis, links, quotes, tasks, and tables", () => {
    const lines = visible(
      renderMarkdown(
        [
          "Use **bold**, *italic*, ~~old~~, and `code` with [docs](https://example.com).",
          "",
          "> quoted text",
          "- [x] shipped",
          "",
          "| name | value |",
          "| --- | --- |",
          "| alpha | beta |",
        ].join("\n"),
        80,
        "truecolor",
      ),
    );
    expect(lines).toContain("│ quoted text");
    expect(lines).toContain("✓ shipped");
    expect(lines).toContain("name  │ value");
    expect(lines).toContain("alpha │ beta");
    expect(lines.join("\n")).toContain("docs (https://example.com)");
  });

  test("markdown styling uses semantic ANSI roles and agent cells render it", () => {
    const rendered = renderMarkdown(
      "# Heading\n\n**bold** *italic* ~~old~~ `code` [link](https://example.com)\n\n> quote\n\n```ts\nconst value = 1;\n```",
      80,
      "truecolor",
    ).join("\n");
    expect(rendered).toContain("38;2;250;204;21");
    expect(rendered).toContain("38;2;96;165;250");
    expect(rendered).toContain("38;2;212;212;212");
    expect(rendered).toContain("38;2;205;214;244");
    expect(rendered).toContain("\u001b[1m");
    expect(rendered).toContain("\u001b[3m");
    expect(rendered).toContain("\u001b[9m");
    expect(rendered).toContain("\u001b[2;3;38;2;96;165;250mquote\u001b[0m");
    expect(stripAnsi(rendered)).toContain("const value = 1;");
    expect(
      renderMarkdown("| name |\n| --- |\n| value |\n\n- [x] shipped", 80, "truecolor").join("\n"),
    ).toContain("38;2;250;204;21");
    expect(renderMarkdown("- [x] shipped", 80, "ansi16").join("\n")).toContain("[32m");

    const agent = agentCell("## Result\n\n- **done**", colored);
    expect(visible(agent)).toEqual(["  mu  Result", "", "      • done"]);
    expect(agent.join("\n")).toContain("\u001b[1m");
  });

  test("recognized fenced languages use language-aware syntax colors", () => {
    const lines = renderMarkdown(
      [
        "```ts",
        "// greeting",
        "const answer: number = 42;",
        `function hello(name: string) { return \`hi \${name}\`; }`,
        "```",
      ].join("\n"),
      100,
      "truecolor",
    );
    const rendered = lines.join("\n");

    expect(visible(lines)).toEqual([
      "ts",
      "│ // greeting",
      "│ const answer: number = 42;",
      `│ function hello(name: string) { return \`hi \${name}\`; }`,
    ]);
    expect(rendered).toContain("38;2;133;139;153m// greeting");
    expect(rendered).toContain("38;2;216;164;234mconst");
    expect(rendered).toContain("38;2;201;209;217manswer");
    expect(rendered).toContain("38;2;148;224;224mnumber");
    expect(rendered).toContain("38;2;232;187;156m42");
    expect(rendered).toContain("38;2;216;227;160mhello");
    expect(rendered).toContain(`38;2;167;221;157m\`hi \${name}\``);
  });

  test("multiline syntax scopes reopen their color on every terminal row", () => {
    const rendered = renderMarkdown("```ts\n/* first\nsecond */\n```", 80, "truecolor");
    expect(visible(rendered)).toEqual(["ts", "│ /* first", "│ second */"]);
    expect(rendered[1]).toContain("38;2;133;139;153m/* first");
    expect(rendered[2]).toContain("38;2;133;139;153msecond */");
  });

  test("unknown and language-less fences stay plain instead of being auto-detected", () => {
    const unknown = renderMarkdown("```not-a-language\nconst value = 1;\n```", 80, "truecolor");
    const languageLess = renderMarkdown("```\nconst value = 1;\n```", 80, "truecolor");

    expect(visible(unknown)).toEqual(["not-a-language", "│ const value = 1;"]);
    expect(visible(languageLess)).toEqual(["│ const value = 1;"]);
    expect(unknown.join("\n")).toContain("38;2;212;212;212mconst value = 1;");
    expect(languageLess.join("\n")).toContain("38;2;212;212;212mconst value = 1;");
    expect(unknown.join("\n")).not.toContain("38;2;216;164;234mconst");
    expect(languageLess.join("\n")).not.toContain("38;2;216;164;234mconst");
  });

  test("syntax highlighting degrades by color depth and preserves source text", () => {
    const source = '```html\n<div title="a&b">text</div>\n```';
    const ansi256 = renderMarkdown("```ts\nconst value = 1;\n```", 80, "ansi256").join("\n");
    const ansi16 = renderMarkdown("```ts\nconst value = 1;\n```", 80, "ansi16").join("\n");
    const noColor = renderMarkdown(source, 80, "none");

    expect(ansi256).toContain("38;5;182mconst");
    expect(ansi16).toContain("[95mconst");
    expect(noColor.join("\n")).not.toContain("\u001b");
    expect(noColor).toEqual(["html", '│ <div title="a&b">text</div>']);

    // `variable` is near-neutral by design, so no ANSI-16 colour is honest for
    // it — the identifier falls back to the terminal's own foreground.
    const identifiers = renderMarkdown("```ts\nconst value = 1;\n```", 80, "ansi16").join("\n");
    expect(identifiers).toContain("[95mconst");
    expect(identifiers).toContain("value");
    expect(identifiers).not.toContain("[96mvalue");
  });

  test("highlighted fences strip model-authored terminal controls", () => {
    const rendered = renderMarkdown('```ts\nconst attack = "\u001b[2J";\n```', 80, "truecolor");
    expect(rendered.join("\n")).not.toContain("\u001b[2J");
    expect(visible(rendered).join("\n")).toContain('const attack = ""');
  });

  test("highlighted code remains terminal-width safe", () => {
    const lines = renderMarkdown(
      '```python\nresult = build_value_with_a_very_long_name(123, "hello")\n```',
      24,
      "truecolor",
    );
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(24);
    const code = visible(lines)
      .slice(1)
      .map((line) => line.replace(/^│ /, ""))
      .join("");
    expect(code).toContain("build_value_with_a_very_long_name");
  });

  test("markdown respects terminal width for rich content", () => {
    const lines = renderMarkdown(
      "| a very long heading | another long heading |\n| --- | --- |\n| alpha beta gamma | delta epsilon zeta |",
      32,
      "truecolor",
    );
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(32);
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

  test("Markdown-only roles stay inside assistant Markdown", () => {
    for (const color of ["38;2;250;204;21", "38;2;96;165;250", "38;2;205;214;244"]) {
      expect(everything).not.toContain(color);
    }
    const markdown = agentCell("# heading\n\n[link](https://example.com) and `code`", colored).join(
      "\n",
    );
    expect(markdown).toContain("38;2;250;204;21");
    expect(markdown).toContain("38;2;96;165;250");
    expect(markdown).toContain("38;2;212;212;212");
  });

  test("the accent marks the speakers, not everything they print", () => {
    // Cyan is mu, the user, and the live interaction — machine activity is not
    // any of those, so none of it carries the accent.
    const machineActivity = [
      ...toolCell({ name: "read", primaryArg: "a.ts", primaryRole: "path" }, colored),
      ...compactionCell(10, colored, { status: "completed" }),
      ...renderMarkdown("- one\n- two", 40, "truecolor"),
    ].join("\n");
    expect(machineActivity).not.toContain(ACCENT);
    for (const speaker of [agentCell("hello", colored), userCell("hi", colored)]) {
      expect(speaker.join("\n")).toContain(ACCENT);
    }
  });

  test("a tool verb is coloured by what it did and stays bold without colour", () => {
    const read = toolCell({ name: "read", tone: "read" }, colored)[0] ?? "";
    const wrote = toolCell({ name: "edited", tone: "mutate" }, colored)[0] ?? "";
    const ran = toolCell({ name: "ran", tone: "exec" }, colored)[0] ?? "";
    expect(read).toContain("38;2;129;140;248");
    expect(wrote).toContain("38;2;249;179;197");
    expect(ran).toContain("38;2;177;185;249");
    expect(new Set([read, wrote, ran]).size).toBe(3);
    for (const line of [read, wrote, ran]) expect(line).toContain("1;38;2;");
    expect(toolCell({ name: "read", tone: "read" }, plain)[0]).toBe("  │ read");
  });

  test("a primary argument is a path or code, never the accent", () => {
    const path = toolCell({ name: "read", primaryArg: "a.ts", primaryRole: "path" }, colored)[0];
    const code = toolCell({ name: "ran", primaryArg: "bun test", primaryRole: "code" }, colored)[0];
    expect(path).toContain("38;2;148;163;184");
    expect(code).toContain("38;2;212;212;212");
    expect(path).not.toContain(ACCENT);
    expect(code).not.toContain(ACCENT);
  });

  test("a failure detail is red where an ordinary summary is dim", () => {
    const failed =
      toolCell({ name: "ran", summary: "exit 2", summaryError: true }, colored)[0] ?? "";
    const ok = toolCell({ name: "ran", summary: "340ms" }, colored)[0] ?? "";
    expect(failed).toContain("\u001b[31mexit 2");
    expect(ok).toContain("\u001b[2m340ms");
  });

  test("the context percentage escalates as the window fills", () => {
    const at = (contextPercent: number) =>
      footer({ ...footerData, contextPercent }, 80, "truecolor")[1] ?? "";
    expect(at(0.12)).toContain(ACCENT);
    expect(at(0.61)).toContain("38;2;249;179;197");
    expect(at(0.92)).toContain("\u001b[31m");
    // Too narrow to style per part: the row degrades to quiet rather than lying.
    expect(footer({ ...footerData, contextPercent: 0.92 }, 24, "truecolor")[1]).not.toContain(
      "\u001b[31m",
    );
  });

  test("the composer marks the user, and marks up commands, mentions and shell", () => {
    const editor = new Editor();
    editor.setText("/model @src/a.ts");
    const first = editor.render(60, "truecolor")[0] ?? "";
    expect(first).toContain(`${ACCENT}▸`);
    expect(first).toContain(`${ACCENT}/model`);
    expect(first).toContain("38;2;148;163;184m@src/a.ts");

    const shell = new Editor();
    shell.setText("!rg --files @src");
    const line = shell.render(60, "truecolor")[0] ?? "";
    expect(line).toContain("38;2;177;185;249m!");
    expect(line).toContain("38;2;148;163;184m@src");
    // Highlighting must not disturb what the user actually typed.
    expect(stripAnsi(line).trimEnd()).toBe("  ▸ !rg --files @src");
  });

  test("highlighting survives the cursor and only applies to the first line", () => {
    const editor = new Editor();
    editor.setText("/model x\n/notacommand");
    editor.setOffset(3);
    const lines = editor.render(60, "truecolor");
    expect(stripAnsi(lines.join("\n"))).toBe("  ▸ /model x\n    /notacommand");
    expect(lines[0]).toContain("\u001b[7m");
    expect(lines[1]).not.toContain(ACCENT);
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
