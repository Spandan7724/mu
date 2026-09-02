import { describe, expect, test } from "bun:test";
import {
  agentCell,
  compactionCell,
  diffCell,
  diffLinesFromHunks,
  errorCell,
  type PlanItem,
  planCell,
  type RenderContext,
  taskCell,
  thinkingCell,
  toolCell,
  userCell,
} from "./cells.ts";
import {
  APPROVAL_OPTIONS,
  approvalOverlay,
  composerBox,
  composerContentWidth,
  Editor,
  footer,
  formatCwdForFooter,
  formatTokens,
  queuedInputPreview,
  renderMarkdown,
  SelectList,
  Spinner,
} from "./components.ts";
import { stripAnsi, styleText } from "./style.ts";
import { stringWidth } from "./width.ts";

// Golden lines are asserted on the *visible* text; colour is left to the eye.
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

  test("background task summaries fit narrow terminals", () => {
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

describe("plan rendering", () => {
  const plan: PlanItem[] = [
    { content: "read the renderer registry", status: "completed" },
    { content: "add the plan cell", status: "completed" },
    { content: "wire the coding renderer", status: "completed" },
    { content: "update the docs", status: "in_progress" },
    { content: "add golden-line tests", status: "pending" },
    { content: "run the full ci pass", status: "pending" },
  ];

  test("the rule brackets the list instead of repeating per row", () => {
    expect(visible(planCell({ items: plan }, plain))).toEqual([
      "  ┌ plan · 3/6 done",
      "  │ ✓ read the renderer registry",
      "  │ ✓ add the plan cell",
      "  │ ✓ wire the coding renderer",
      "  │ ▸ update the docs",
      "  │ ▹ add golden-line tests",
      "  └ ▹ run the full ci pass",
    ]);
  });

  test("a single task closes the bracket on its own row", () => {
    expect(visible(planCell({ items: [plan[3] as PlanItem] }, plain))).toEqual([
      "  ┌ plan · 0/1 done",
      "  └ ▸ update the docs",
    ]);
  });

  test("an empty plan takes the ordinary rule — a bracket would never close", () => {
    expect(visible(planCell({ items: [] }, plain))).toEqual(["  │ plan · no tasks"]);
  });

  test("completed work is struck through and dim, the live task is neither", () => {
    const lines = planCell({ items: plan }, colored);
    expect(lines[1]).toContain("[2;9mread the renderer registry");
    expect(stripAnsi(lines[4] ?? "")).toContain("▸ update the docs");
    // Pending recedes without the strike: it is unstarted, not finished.
    expect(lines[5]).toContain("[2madd golden-line tests");
    expect(lines[5]).not.toContain("[2;9m");
  });

  test("the three marks differ in shape, so NO_COLOR loses nothing", () => {
    const marks = visible(planCell({ items: plan }, plain))
      .slice(1)
      .map((line) => line.slice(4, 5));
    expect(marks).toEqual(["✓", "✓", "✓", "▸", "▹", "▹"]);
  });

  test("an overlong plan folds its finished head and keeps what is left", () => {
    const long: PlanItem[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        content: `finished step ${i + 1}`,
        status: "completed" as const,
      })),
      { content: "update the docs", status: "in_progress" as const },
      ...Array.from({ length: 5 }, (_, i) => ({
        content: `remaining step ${i + 1}`,
        status: "pending" as const,
      })),
    ];
    const lines = visible(planCell({ items: long }, plain));
    expect(lines).toEqual([
      "  ┌ plan · 8/14 done",
      "  │ … 7 done",
      "  │ ✓ finished step 8",
      "  │ ▸ update the docs",
      "  │ ▹ remaining step 1",
      "  │ ▹ remaining step 2",
      "  │ ▹ remaining step 3",
      "  │ ▹ remaining step 4",
      "  └ ▹ remaining step 5",
    ]);
    // Expanding restores every task, and the bracket still closes last.
    const expanded = visible(planCell({ items: long, expanded: true }, plain));
    expect(expanded).toHaveLength(long.length + 1);
    expect(expanded.at(-1)).toBe("  └ ▹ remaining step 5");
  });

  test("a plan with nothing finished truncates its tail instead", () => {
    const pending: PlanItem[] = Array.from({ length: 12 }, (_, i) => ({
      content: `step ${i + 1}`,
      status: "pending" as const,
    }));
    const lines = visible(planCell({ items: pending }, plain));
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toBe("  └ … 5 more · ctrl+o to expand");
  });

  test("compact rows never wrap; expanded ones hang under the task text", () => {
    const long: PlanItem[] = [
      { content: "wire the renderer into the registry and close the bracket", status: "pending" },
    ];
    const narrow: RenderContext = { width: 40, depth: "none" };
    expect(visible(planCell({ items: long }, narrow))).toEqual([
      "  ┌ plan · 0/1 done",
      "  └ ▹ wire the renderer into the regist…",
    ]);
    expect(visible(planCell({ items: long, expanded: true }, narrow))).toEqual([
      "  ┌ plan · 0/1 done",
      "  │ ▹ wire the renderer into the",
      "  └   registry and close the bracket",
    ]);
  });

  test("every row fits the terminal", () => {
    const narrow: RenderContext = { width: 28, depth: "truecolor" };
    for (const line of planCell({ items: plan }, narrow)) {
      expect(stringWidth(line)).toBeLessThanOrEqual(28);
    }
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

  test("changed text uses foreground colour without a background band", () => {
    const [, context = "", removed = "", added = ""] = diffCell(file, colored);
    expect(removed).toContain(styleText("  return fetch(url);", { red: true }, "truecolor"));
    expect(added).toContain(
      styleText("  return withRetry(() => fetch(url));", { green: true }, "truecolor"),
    );
    expect(removed).not.toContain("[48;");
    expect(added).not.toContain("[48;");
    expect(stringWidth(removed)).toBeLessThan(colored.width);
    expect(stringWidth(added)).toBeLessThan(colored.width);

    // Line numbers remain uniformly dim; only the sign and changed text carry outcome color.
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

  test("footer shows live status in parentheses beside the directory", () => {
    const lines = visible(footer({ ...footerData, status: "feature/branch" }, 60, "none"));
    expect(lines[0]).toBe("  ~/code/mu (feature/branch)");
    expect(lines[1]).toBe("  claude-opus-5 · 0.4%/272k · ↑1.1k ↓11 · $0.14");
  });

  test("footer preserves status when the terminal is narrow", () => {
    const line = visible(footer({ ...footerData, status: "main" }, 14, "none"))[0] ?? "";
    expect(line).toEndWith("(main)");
    expect(line.length).toBeLessThanOrEqual(14);
  });

  test("footer helpers match compact values and home paths", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_100)).toBe("1.1k");
    expect(formatTokens(272_000)).toBe("272k");
    expect(formatCwdForFooter("/home/test/code/mu", "/home/test")).toBe("~/code/mu");
    expect(formatCwdForFooter("/srv/mu", "/home/test")).toBe("/srv/mu");
  });

  test("composer content is enclosed by a width-safe box", () => {
    const width = 20;
    expect(composerContentWidth(width)).toBe(14);
    expect(composerBox(["  ▸ draft"], width, "none")).toEqual([
      "  ╭──────────────╮",
      "  │ ▸ draft      │",
      "  ╰──────────────╯",
    ]);
    expect(composerBox(["  ▸ draft"], width, "truecolor")).toEqual([
      "  ╭──────────────╮",
      "  │ ▸ draft      │",
      "  ╰──────────────╯",
    ]);
    expect(composerBox(["  $ test"], width, "none", "shell")).toEqual([
      "  ╭─ shell ──────╮",
      "  │ $ test       │",
      "  ╰──────────────╯",
    ]);
    const multiline = composerBox(["  first\nsecond"], width, "none");
    expect(multiline).toEqual(["  ╭──────────────╮", "  │ first second │", "  ╰──────────────╯"]);
    for (const line of multiline) {
      expect(line).not.toContain("\n");
      expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
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

  test("approval overlay splits multiline commands into bounded physical rows", () => {
    const lines = visible(
      approvalOverlay(
        {
          title: "run bash",
          preview: ["python3 - <<'PY'\nprint('a very long value that must truncate')\nPY"],
          selectedIndex: 0,
        },
        24,
        "none",
      ),
    );
    expect(lines.slice(1, 4)).toEqual(["  python3 - <<'PY'", "  print('a very long va…", "  PY"]);
    for (const line of lines.slice(0, 4)) {
      expect(line).not.toContain("\n");
      expect(stringWidth(line)).toBeLessThanOrEqual(24);
    }
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

  test("markdown sizes tables arithmetically even with an enormous cell", () => {
    const huge = "x".repeat(100_000);
    const lines = renderMarkdown(
      `| huge | small | medium |\n| --- | --- | --- |\n| ${huge} | ok | value |`,
      40,
      "none",
    );

    expect(lines.some((line) => line.includes("…"))).toBe(true);
    expect(lines.every((line) => stringWidth(line) <= 40)).toBe(true);
  });

  test("markdown styling applies text attributes and agent cells render it", () => {
    const rendered = renderMarkdown(
      "# Heading\n\n**bold** *italic* ~~old~~ `code` [link](https://example.com)\n\n> quote\n\n```ts\nconst value = 1;\n```",
      80,
      "truecolor",
    ).join("\n");
    expect(rendered).toContain("\u001b[1m");
    expect(rendered).toContain("\u001b[3m");
    expect(rendered).toContain("\u001b[9m");
    expect(rendered).toContain("\u001b[2;3;");
    expect(stripAnsi(rendered)).toContain("const value = 1;");

    const agent = agentCell("## Result\n\n- **done**", colored);
    expect(visible(agent)).toEqual(["  mu  Result", "", "      • done"]);
    expect(agent.join("\n")).toContain("\u001b[1m");
  });

  test("recognized fenced languages preserve their source text", () => {
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
    expect(rendered).not.toBe(stripAnsi(rendered));
  });

  test("multiline syntax scopes reopen their color on every terminal row", () => {
    const rendered = renderMarkdown("```ts\n/* first\nsecond */\n```", 80, "truecolor");
    expect(visible(rendered)).toEqual(["ts", "│ /* first", "│ second */"]);
    // Every physical row reopens the scope rather than leaning on the row above.
    const opensStyle = (row: string, text: string) => {
      const prefix = row.slice(0, row.indexOf(text));
      return prefix.includes("\u001b[") && prefix.endsWith("m");
    };
    expect(opensStyle(rendered[1] ?? "", "/* first")).toBe(true);
    expect(opensStyle(rendered[2] ?? "", "second */")).toBe(true);
  });

  test("unknown and language-less fences stay plain instead of being auto-detected", () => {
    const unknown = renderMarkdown("```not-a-language\nconst value = 1;\n```", 80, "truecolor");
    const languageLess = renderMarkdown("```\nconst value = 1;\n```", 80, "truecolor");

    expect(visible(unknown)).toEqual(["not-a-language", "│ const value = 1;"]);
    expect(visible(languageLess)).toEqual(["│ const value = 1;"]);
    // A highlighted fence splits its line into many styled spans; a plain one does not.
    const spans = (rows: string[]) => rows.join("\n").split("\u001b[").length - 1;
    const highlighted = renderMarkdown("```ts\nconst value = 1;\n```", 80, "truecolor");
    expect(spans(unknown)).toBeLessThan(spans(highlighted));
    expect(spans(languageLess)).toBeLessThan(spans(highlighted));
  });

  test("syntax highlighting degrades by color depth and preserves source text", () => {
    const source = '```html\n<div title="a&b">text</div>\n```';
    const ansi256 = renderMarkdown("```ts\nconst value = 1;\n```", 80, "ansi256").join("\n");
    const ansi16 = renderMarkdown("```ts\nconst value = 1;\n```", 80, "ansi16").join("\n");
    const noColor = renderMarkdown(source, 80, "none");

    expect(ansi256).not.toBe(stripAnsi(ansi256));
    expect(ansi16).not.toBe(stripAnsi(ansi16));
    expect(noColor.join("\n")).not.toContain("\u001b");
    expect(noColor).toEqual(["html", '│ <div title="a&b">text</div>']);
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

  test("normalizes CRLF and bare CR line endings before rendering", () => {
    const editor = new Editor();
    editor.insert("one\r\ntwo\rthree");
    expect(editor.text).toBe("one\ntwo\nthree");
    expect(editor.render(40, "none").map(stripAnsi)).toEqual(["  ▸ one", "    two", "    three "]);
  });

  test("backspace removes a whole grapheme", () => {
    const editor = new Editor();
    for (const grapheme of ["é", "👨‍👩‍👧‍👦", "👍🏽", "1️⃣", "🇺🇸"]) {
      editor.insert(grapheme);
      editor.backspace();
      expect(editor.text).toBe("");
    }
  });

  test("left and right move only across grapheme boundaries", () => {
    const editor = new Editor();
    const family = "👨‍👩‍👧‍👦";
    editor.insert(`${family}x`);

    editor.move("left");
    expect(editor.textBeforeCursor).toBe(family);
    editor.move("left");
    expect(editor.textBeforeCursor).toBe("");
    editor.move("right");
    expect(editor.textBeforeCursor).toBe(family);
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

  test("replacing history discards another session's prompts", () => {
    const editor = new Editor();
    editor.insert("old session prompt");
    editor.submit();

    editor.replaceHistory(["resumed first", "resumed second"]);

    expect(editor.recallHistory("up")).toBe(true);
    expect(editor.text).toBe("resumed second");
    expect(editor.recallHistory("up")).toBe(true);
    expect(editor.text).toBe("resumed first");
    expect(editor.recallHistory("up")).toBe(false);
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

  test("a tool verb stays bold, and plain without colour", () => {
    const verbs = [
      toolCell({ name: "read", tone: "read" }, colored)[0] ?? "",
      toolCell({ name: "edited", tone: "mutate" }, colored)[0] ?? "",
      toolCell({ name: "ran", tone: "exec" }, colored)[0] ?? "",
    ];
    for (const line of verbs) expect(line).toContain("\u001b[1;");
    expect(toolCell({ name: "read", tone: "read" }, plain)[0]).toBe("  │ read");
  });

  test("an ordinary summary is dim", () => {
    const ok = toolCell({ name: "ran", summary: "340ms" }, colored)[0] ?? "";
    expect(ok).toContain("\u001b[2m340ms");
  });

  test("composer markup does not disturb what the user typed", () => {
    const editor = new Editor();
    editor.setText("/model @src/a.ts");
    expect(stripAnsi(editor.render(60, "truecolor")[0] ?? "").trimEnd()).toBe(
      "  ▸ /model @src/a.ts",
    );

    const shell = new Editor();
    shell.setText("!rg --files @src");
    expect(stripAnsi(shell.render(60, "truecolor")[0] ?? "").trimEnd()).toBe(
      "  ▸ !rg --files @src",
    );
  });

  test("highlighting survives the cursor and only applies to the first line", () => {
    const editor = new Editor();
    editor.setText("/model x\n/notacommand");
    editor.setOffset(3);
    const lines = editor.render(60, "truecolor");
    expect(stripAnsi(lines.join("\n"))).toBe("  ▸ /model x\n    /notacommand");
    expect(lines[0]).toContain("\u001b[7m");
    expect(lines[1]).not.toContain("\u001b[");
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
