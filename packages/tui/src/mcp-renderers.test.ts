import { expect, test } from "bun:test";
import type { ToolResultMessage } from "@mu/core";
import { App } from "./app.ts";
import { InputDecoder } from "./input.ts";
import { mcpRenderers, summarizeMcpActivity } from "./mcp-renderers.ts";
import { RendererRegistry, type ToolRenderInfo } from "./registry.ts";
import { stripAnsi } from "./style.ts";
import { stringWidth } from "./width.ts";

const ctx = { width: 120, depth: "none" as const };

function result(text: string, isError = false, details?: unknown): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "mcp_call",
    content: [{ type: "text", text }],
    ...(details !== undefined ? { details } : {}),
    isError,
    timestamp: 1,
  };
}

function registry(): RendererRegistry {
  const value = new RendererRegistry();
  value.registerAll(mcpRenderers);
  return value;
}

const call = (tool: string, isError = false, server = "github"): ToolRenderInfo => ({
  toolName: "mcp_call",
  args: { server, tool, arguments: {} },
  result: result(isError ? "401 Bad credentials" : "ok", isError),
});
const opened: ToolRenderInfo = {
  toolName: "mcp_open",
  args: { server: "github" },
  result: result("github: 91 tools", false, { server: "github", tools: 91 }),
};
const describe: ToolRenderInfo = {
  toolName: "mcp_describe",
  args: { server: "github", tools: ["search_issues", "get_issue", "add_labels"] },
  result: result("search_issues(query: string)"),
};

test("a call leads with the server and tool, then its arguments", () => {
  const lines = registry().render(
    {
      toolName: "mcp_call",
      args: {
        server: "github",
        tool: "search_issues",
        arguments: { repo: "mu", query: "is:open label:bug" },
      },
      result: result("#412 Retries ignore Retry-After"),
    },
    ctx,
  );
  expect(lines.map(stripAnsi)).toEqual([
    "  │ github search_issues · ✓ repo mu, query is:open label:bug",
  ]);
});

test("a failed call shows the error instead of its arguments", () => {
  const lines = registry().render(
    {
      toolName: "mcp_call",
      args: { server: "github", tool: "add_labels", arguments: { issue_number: 412 } },
      result: result("401 Bad credentials\nmore detail", true),
    },
    ctx,
  );
  expect(lines.map(stripAnsi)).toEqual(["  │ github add_labels · ✗ 401 Bad credentials"]);
});

test("opening, looking up and loading a skill read quietly", () => {
  const render = (info: ToolRenderInfo) => registry().render(info, ctx).map(stripAnsi);
  expect(render(opened)).toEqual(["  │ opened github · 91 tools"]);
  expect(render(describe)).toEqual(["  │ looked up github · search_issues, get_issue, add_labels"]);
  expect(
    render({
      toolName: "skill",
      args: { name: "triage" },
      result: result("<skill>", false, {
        skill: "triage",
        directory: "/home/someone/.claude/skills/triage",
      }),
    }),
  ).toEqual(["  │ loaded skill triage · ~/.claude/skills/triage"]);
});

test("the summary marks each tool, merging repeats in first-call order", () => {
  const summary = stripAnsi(
    summarizeMcpActivity(
      [
        opened,
        describe,
        call("search_issues"),
        call("get_issue"),
        call("get_issue"),
        call("add_labels", true),
      ],
      "none",
    ),
  );
  expect(summary).toBe(
    "github — opened, looked up 3 tools · search_issues ✓  get_issue ✓×2  add_labels ✗",
  );
});

test("entries that do not fit are counted, and hidden failures stay visible", () => {
  const infos = [
    opened,
    describe,
    call("search_issues"),
    ...Array.from({ length: 4 }, () => call("get_issue")),
    call("add_labels", true),
    call("list_pull_requests"),
    call("get_pull_request"),
    call("get_pull_request"),
    call("add_issue_comment", true),
  ];
  for (const width of [100, 80]) {
    const summary = stripAnsi(summarizeMcpActivity(infos, "none", width));
    expect(stringWidth(summary)).toBeLessThanOrEqual(width);
    expect(summary).toMatch(/\+\d+ more \(\d failed\)$/);
  }
  expect(stripAnsi(summarizeMcpActivity(infos, "none", 100))).toBe(
    "github — opened, looked up 3 tools · search_issues ✓  get_issue ✓×4  +5 more (2 failed)",
  );
  expect(stripAnsi(summarizeMcpActivity(infos, "none", 50))).toBe(
    "github — opened, looked up 3 tools · 10 calls (2 failed)",
  );
});

test("a server that failed to open says so; names from the server are sanitized", () => {
  const summary = stripAnsi(
    summarizeMcpActivity(
      [
        {
          toolName: "mcp_open",
          args: { server: "evil\u001b[2J" },
          result: result("Server is disabled", true),
        },
        { ...call("x\u001b]0;pwned\u0007y", false, "evil\u001b[2J") },
      ],
      "none",
    ),
  );
  expect(summary).not.toContain("\u001b");
  expect(summary).toContain("couldn't open");
});

test("the App folds a server's calls into one row that expands to each call", () => {
  const app = new App({
    width: 120,
    depth: "none",
    model: "fake/fake-1",
    cwd: "~",
    contextWindow: 1000,
    registry: registry(),
    callbacks: { onSubmit: () => {}, onAbort: () => {}, onExit: () => {} },
  });
  const complete = (id: string, info: ToolRenderInfo) => {
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: info.toolName,
      args: info.args,
    });
    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: id,
      result: { ...(info.result as ToolResultMessage), toolCallId: id, toolName: info.toolName },
    });
  };
  complete("o1", opened);
  complete("c1", call("search_issues"));
  complete("c2", call("add_labels", true));
  complete("o2", { ...opened, args: { server: "context7" } });
  complete("c3", call("get-library-docs", false, "context7"));

  const transcript = app.renderTranscript().map(stripAnsi);
  expect(transcript).toContain("  › github — opened · search_issues ✓  add_labels ✗");
  expect(transcript).toContain("  › context7 — opened · get-library-docs ✓");
  expect(transcript.join("\n")).not.toContain("github add_labels");

  const feed = (raw: string) => {
    for (const event of new InputDecoder().push(raw)) app.handleInput(event);
  };
  feed("\u000f");
  feed("\u001b[A");
  feed("\r");
  const expanded = app.renderScreen().map(stripAnsi).join("\n");
  expect(expanded).toContain("github add_labels · ✗ 401 Bad credentials");
});

test("a long error is shortened before the tool name it is about", () => {
  const lines = registry().render(
    {
      toolName: "mcp_call",
      args: { server: "everything", tool: "does_not_exist", arguments: {} },
      result: result(`Unknown tool does_not_exist on everything. Tools: ${"x, ".repeat(80)}`, true),
    },
    { width: 80, depth: "none" },
  );
  const line = stripAnsi(lines[0] ?? "");
  expect(line).toContain("everything does_not_exist · ✗ Unknown tool");
  expect(stringWidth(line)).toBeLessThanOrEqual(80);
});
