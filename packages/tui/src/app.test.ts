// Integration: a scripted fake-agent event stream drives the whole UI with
// zero network, exactly as the milestone requires.
import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentMessage } from "@mu/core";
import { App, type AppCallbacks } from "./app.ts";
import { InputDecoder } from "./input.ts";
import { codingRenderers, genericRenderer, RendererRegistry } from "./registry.ts";
import { FullScreenRenderer } from "./renderer.ts";
import { stripAnsi } from "./style.ts";
import { Terminal, type TerminalIo } from "./terminal.ts";
import { stringWidth } from "./width.ts";

const ESC = "\u001b";

function harness(overrides: Partial<AppCallbacks> = {}) {
  const submitted: string[] = [];
  const steers: string[] = [];
  const followUps: string[] = [];
  const commands: string[] = [];
  const replies: { id: string; outcome: string; remember: boolean }[] = [];
  let aborted = false;
  let exited = false;

  const registry = new RendererRegistry();
  registry.registerAll(codingRenderers);

  const app = new App({
    width: 60,
    depth: "none",
    model: "fake/fake-1",
    cwd: "~/code/mu",
    contextWindow: 272_000,
    registry,
    callbacks: {
      onSubmit: (text) => submitted.push(text),
      onSteer: (text) => {
        steers.push(text);
        return true;
      },
      onFollowUp: (text) => {
        followUps.push(text);
        return true;
      },
      onAbort: () => {
        aborted = true;
      },
      onExit: () => {
        exited = true;
      },
      onCommand: (text) => commands.push(text),
      onPermissionReply: (id, outcome, remember) => replies.push({ id, outcome, remember }),
      ...overrides,
    },
  });

  return {
    app,
    submitted,
    steers,
    followUps,
    commands,
    replies,
    get aborted() {
      return aborted;
    },
    get exited() {
      return exited;
    },
  };
}

function feed(app: App, raw: string): void {
  for (const event of new InputDecoder().push(raw)) app.handleInput(event);
}

const assistant = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  model: "fake/fake-1",
  usage: {
    inputTokens: 5,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
  },
  stopReason: "end" as const,
  timestamp: 1,
});

describe("fake-agent session", () => {
  test("a scripted event stream renders a full transcript", () => {
    const { app } = harness();
    const script: AgentEvent[] = [
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "add retries" }], timestamp: 1 },
      },
      { type: "turn_start" },
      {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "read",
        args: { path: "src/api/client.ts" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        result: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "text", text: "…file…" }],
          details: { lines: 142 },
          isError: false,
          timestamp: 2,
        },
      },
      { type: "message_end", message: assistant("Done — retries added.") },
      {
        type: "usage_updated",
        sessionTotals: {
          inputTokens: 1_100,
          outputTokens: 11,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.14,
        },
        contextTokens: 1_088,
        contextPercent: 0.004,
      },
      { type: "agent_end", messages: [], reason: "done" },
    ];

    const transcript: string[] = [];
    for (const event of script) transcript.push(...app.handleEvent(event));
    const visible = transcript.map(stripAnsi);

    expect(visible).toContain("  ▸ add retries");
    expect(visible).toContain("  │ read src/api/client.ts · 142 lines");
    expect(visible.some((line) => line.startsWith("  mu  Done"))).toBe(true);

    const bottom = app.renderBottom().map(stripAnsi);
    expect(bottom.at(-2)).toBe("  ~/code/mu");
    const footerLine = bottom.at(-1) ?? "";
    expect(footerLine).toContain("0.4%/272k");
    expect(footerLine).toContain("↑1.1k ↓11");
    expect(footerLine).toContain("$0.14");
  });

  test("a failing tool renders with the error glyph", () => {
    const { app } = harness();
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "bun test" },
    });
    const lines = app.handleEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      result: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "failed" }],
        details: { exitCode: 1 },
        isError: true,
        timestamp: 2,
      },
    });
    expect(stripAnsi(lines[0] ?? "")).toContain("✗");
    expect(stripAnsi(lines[0] ?? "")).toContain("exit 1");
  });

  test("the spinner and interrupt hint appear only while running", () => {
    const { app } = harness();
    expect(stripAnsi(app.renderBottom().at(-1) ?? "")).not.toContain("esc to interrupt");
    app.handleEvent({ type: "agent_start" });
    const runningHint = app.renderBottom().map(stripAnsi).join("\n");
    expect(runningHint).toContain("enter steer");
    expect(runningHint).toContain("tab follow-up");
    expect(runningHint).toContain("esc interrupt");
    app.handleEvent({ type: "agent_end", messages: [], reason: "done" });
    expect(stripAnsi(app.renderBottom().at(-1) ?? "")).not.toContain("enter steer");
  });

  test("compaction is shown as a visible boundary", () => {
    const { app } = harness();
    const lines = app.handleEvent({ type: "compaction_end", layer: 2, tokensFreed: 5000 });
    expect(stripAnsi(lines[0] ?? "")).toContain("• Context compacted");
  });

  test("compaction shows its stage and queues enter as a follow-up", () => {
    const h = harness();
    h.app.handleEvent({ type: "agent_start" });
    h.app.handleEvent({
      type: "compaction_start",
      layer: 2,
      trigger: "manual",
      contextTokensBefore: 90_000,
    });
    h.app.handleEvent({ type: "compaction_update", layer: 2, stage: "installing" });

    const running = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(running).toContain("compacting context");
    expect(running).toContain("installing checkpoint");
    expect(running.replace(/\s+/g, " ")).toContain("enter queue");
    feed(h.app, "continue after compaction\r");
    expect(h.followUps).toEqual(["continue after compaction"]);
    expect(h.steers).toEqual([]);
  });

  test("rich compaction completion reports before, after, retained, and cleared context", () => {
    const { app } = harness();
    const lines = app.handleEvent({
      type: "compaction_end",
      layer: 2,
      trigger: "manual",
      status: "completed",
      tokensFreed: 62_000,
      contextTokensBefore: 90_000,
      contextTokensAfter: 28_000,
      keptTokens: 20_000,
      toolResultsCleared: 4,
    });
    const rendered = lines.map(stripAnsi).join(" ").replace(/\s+/g, " ");
    expect(rendered).toContain("• Context compacted");
    expect(rendered).toContain("90,000 → 28,000");
    expect(rendered).toContain("62,000 freed");
    expect(rendered).toContain("20,000 recent tokens kept");
    expect(rendered).toContain("4 tool outputs cleared");
  });

  test("background task count reaches the footer", () => {
    const { app } = harness();
    app.handleEvent({ type: "task_started", taskId: "t1", command: "bun dev", background: true });
    expect(stripAnsi(app.renderBottom().at(-1) ?? "")).toContain("1 bg");
    app.handleEvent({ type: "task_exited", taskId: "t1", exitCode: 0 });
    expect(stripAnsi(app.renderBottom().at(-1) ?? "")).not.toContain("1 bg");
  });

  test("background task output streams in a bounded live cell then collapses", () => {
    const { app } = harness();
    app.handleEvent({
      type: "task_started",
      taskId: "task_1",
      command: "bun test",
      background: true,
    });
    app.handleEvent({ type: "task_output", taskId: "task_1", chunk: "one\ntwo\nthr" });
    app.handleEvent({ type: "task_output", taskId: "task_1", chunk: "ee\n" });
    expect(app.renderBottom().map(stripAnsi).join("\n")).toContain("three");
    app.handleEvent({
      type: "task_output",
      taskId: "task_1",
      chunk: "four\nfive\nsix\nseven",
    });

    const live = app.renderBottom().map(stripAnsi).join("\n");
    expect(live).toContain("task_1 · bun test");
    expect(live).toContain("five");
    expect(live).toContain("seven");
    expect(live).not.toContain("one");

    const completed = app
      .handleEvent({
        type: "task_exited",
        taskId: "task_1",
        exitCode: 0,
        status: "exited",
      })
      .map(stripAnsi)
      .join("\n");
    expect(completed).toContain("task_1 · bun test · ✓");
    expect(app.renderBottom().map(stripAnsi).join("\n")).not.toContain("task_1");
  });

  test("a killed background task commits an explicit killed summary", () => {
    const { app } = harness();
    app.handleEvent({
      type: "task_started",
      taskId: "task_2",
      command: "bun dev",
      background: true,
    });
    const completed = app
      .handleEvent({
        type: "task_exited",
        taskId: "task_2",
        exitCode: null,
        status: "killed",
      })
      .map(stripAnsi)
      .join("\n");
    expect(completed).toContain("✗ · killed");
  });
});

describe("input handling", () => {
  test("typing and submitting", () => {
    const h = harness();
    feed(h.app, "hello\r");
    expect(h.submitted).toEqual(["hello"]);
  });

  test("Shift+Enter inserts a newline instead of submitting", () => {
    const h = harness();
    const shiftEnter = "\u001b[13;2u"; // Shift+Enter (kitty)
    feed(h.app, "first");
    feed(h.app, shiftEnter);
    feed(h.app, "second");
    expect(h.submitted).toEqual([]);
    expect(h.app.editor.text).toBe("first\nsecond");
    feed(h.app, "\r"); // plain Enter now submits the whole thing
    expect(h.submitted).toEqual(["first\nsecond"]);
  });

  test("a trailing backslash turns Enter into a newline on any terminal", () => {
    const h = harness();
    feed(h.app, "first\\\r"); // backslash then plain Enter
    feed(h.app, "second");
    expect(h.submitted).toEqual([]);
    // The continuation backslash is consumed; a newline replaces it.
    expect(h.app.editor.text).toBe("first\nsecond");
    feed(h.app, "\r");
    expect(h.submitted).toEqual(["first\nsecond"]);
  });

  test("an escaped double backslash before Enter still submits", () => {
    const h = harness();
    feed(h.app, "path\\\\\r"); // two backslashes = one literal, not a continuation
    expect(h.submitted).toEqual(["path\\\\"]);
  });

  test("Ctrl+J inserts a newline on any terminal, no protocol needed", () => {
    const h = harness();
    feed(h.app, "first");
    feed(h.app, "\n"); // Ctrl+J
    feed(h.app, "second");
    expect(h.submitted).toEqual([]);
    expect(h.app.editor.text).toBe("first\nsecond");
    feed(h.app, "\r");
    expect(h.submitted).toEqual(["first\nsecond"]);
  });

  test("tab queues a follow-up only while the agent is running", () => {
    const h = harness();
    feed(h.app, "not yet\t");
    expect(h.followUps).toEqual([]);
    expect(h.app.editor.text).toBe("not yet");

    h.app.handleEvent({ type: "agent_start" });
    feed(h.app, "\t");
    expect(h.followUps).toEqual(["not yet"]);
    expect(h.submitted).toEqual([]);
    expect(h.app.editor.text).toBe("");
    expect(h.app.renderBottom().map(stripAnsi).join("\n")).toContain("▸ follow-up · not yet");

    h.app.handleEvent({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "not yet" }],
        timestamp: 1,
      },
    });
    expect(h.app.renderBottom().map(stripAnsi).join("\n")).not.toContain("follow-up · not yet");
  });

  test("pending steers and follow-ups stay labeled until each is delivered", () => {
    const h = harness();
    h.app.handleEvent({ type: "agent_start" });
    feed(h.app, "same\t");
    feed(h.app, "same\r");

    expect(h.followUps).toEqual(["same"]);
    expect(h.steers).toEqual(["same"]);
    let pending = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(pending).toContain("▸ steer · same");
    expect(pending).toContain("▸ follow-up · same");

    h.app.handleEvent({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "same" }], timestamp: 1 },
    });
    pending = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(pending).not.toContain("▸ steer · same");
    expect(pending).toContain("▸ follow-up · same");
  });

  test("alt+up restores only the newest queued message for editing", () => {
    const edited: { kind: string; text: string }[] = [];
    const h = harness({
      onEditQueued: (kind, text) => {
        edited.push({ kind, text });
        return true;
      },
    });
    h.app.handleEvent({ type: "agent_start" });
    feed(h.app, "run tests\t");
    feed(h.app, "dojopj\r");

    const before = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(before).toContain("▸ steer · dojopj · alt+up edit");
    expect(before).not.toContain("follow-up · run tests · alt+up edit");

    feed(h.app, "draft");
    feed(h.app, `${ESC}[1;3A`);

    expect(edited).toEqual([{ kind: "steer", text: "dojopj" }]);
    expect(h.app.editor.text).toBe("dojopj\n\ndraft");
    const after = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(after).not.toContain("steer · dojopj");
    expect(after).toContain("▸ follow-up · run tests · alt+up edit");
  });

  test("alt+up leaves a queued message visible when it is already being delivered", () => {
    const h = harness({ onEditQueued: () => false });
    h.app.handleEvent({ type: "agent_start" });
    feed(h.app, "too late\t");
    feed(h.app, `${ESC}[1;3A`);

    expect(h.app.editor.text).toBe("");
    expect(h.app.renderBottom().map(stripAnsi).join("\n")).toContain(
      "▸ follow-up · too late · alt+up edit",
    );
  });

  test("rejected follow-ups are not displayed as queued", () => {
    const h = harness({ onFollowUp: () => false });
    h.app.handleEvent({ type: "agent_start" });
    feed(h.app, "cannot queue\t");
    expect(h.app.renderBottom().map(stripAnsi).join("\n")).not.toContain("cannot queue");
  });

  test("the pending area keeps the newest inputs and summarizes older ones", () => {
    const h = harness();
    h.app.handleEvent({ type: "agent_start" });
    for (const text of ["first", "second", "third", "fourth"]) feed(h.app, `${text}\t`);

    const pending = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(pending).toContain("… 1 earlier queued input");
    expect(pending).not.toContain("follow-up · first");
    expect(pending).toContain("follow-up · second");
    expect(pending).toContain("follow-up · third");
    expect(pending).toContain("follow-up · fourth");
  });

  test("a multi-line paste does not submit", () => {
    const h = harness();
    feed(h.app, `${ESC}[200~line one\nline two${ESC}[201~`);
    expect(h.submitted).toEqual([]);
    expect(h.app.editor.text).toBe("line one\nline two");
    feed(h.app, "\r");
    expect(h.submitted).toEqual(["line one\nline two"]);
  });

  test("escape aborts a running agent but not an idle one", () => {
    const h = harness();
    feed(h.app, ESC);
    h.app.handleInput({
      type: "key",
      key: { name: "escape", ctrl: false, alt: false, shift: false },
    });
    expect(h.aborted).toBe(false);

    h.app.handleEvent({ type: "agent_start" });
    h.app.handleInput({
      type: "key",
      key: { name: "escape", ctrl: false, alt: false, shift: false },
    });
    expect(h.aborted).toBe(true);
  });

  test("ctrl+c exits cleanly", () => {
    const h = harness();
    feed(h.app, "\u0003");
    expect(h.exited).toBe(true);
  });

  test("slash opens the command popup and selects a command", () => {
    const h = harness();
    h.app.setCommands([
      { label: "model", description: "switch model" },
      { label: "compact", description: "summarize" },
    ]);
    feed(h.app, "/");
    expect(h.app.currentMode).toBe("select");
    feed(h.app, "\r");
    expect(h.commands).toEqual(["/model"]);
    expect(h.app.currentMode).toBe("composing");
  });

  test("a typed slash command submits as a command, not a prompt", () => {
    const h = harness();
    h.app.setCommands([{ label: "model" }]);
    feed(h.app, "/model gpt\r");
    expect(h.commands).toEqual(["/model gpt"]);
    expect(h.submitted).toEqual([]);
  });

  test("a slash command remains a command while the agent is running", () => {
    const h = harness();
    h.app.handleEvent({ type: "agent_start" });

    feed(h.app, "/permissions\r");

    expect(h.commands).toEqual(["/permissions"]);
    expect(h.steers).toEqual([]);
  });

  test("a leading bang enters shell mode and submits without the prefix", () => {
    const shellCommands: string[] = [];
    const h = harness({ onShell: (command) => shellCommands.push(command) });

    feed(h.app, "!");
    expect(h.app.isShellMode).toBe(true);
    expect(h.app.renderBottom().map(stripAnsi).join("\n")).toContain("shell mode · runs locally");

    feed(h.app, "printf ok\r");
    expect(shellCommands).toEqual(["printf ok"]);
    expect(h.submitted).toEqual([]);
    expect(h.app.isShellMode).toBe(false);

    feed(h.app, "\u001b[A");
    expect(h.app.editor.text).toBe("!printf ok");
    expect(h.app.isShellMode).toBe(true);
  });

  test("an empty shell command stays in the editor and escape cancels the mode", () => {
    const shellCommands: string[] = [];
    const h = harness({ onShell: (command) => shellCommands.push(command) });

    feed(h.app, "!\r");
    expect(shellCommands).toEqual([]);
    expect(h.app.editor.text).toBe("!");
    feed(h.app, ESC);
    h.app.handleInput({
      type: "key",
      key: { name: "escape", ctrl: false, alt: false, shift: false },
    });
    expect(h.app.editor.text).toBe("");
    expect(h.app.isShellMode).toBe(false);
  });
});

describe("approval overlay", () => {
  const ask: AgentEvent = {
    type: "permission_asked",
    request: {
      id: "p1",
      toolCallId: "c1",
      toolName: "bash",
      permission: "bash",
      pattern: "rm -rf build",
      description: "run bash",
    },
  };

  test("an ask switches to the approval mode and shows the options", () => {
    const h = harness();
    h.app.handleEvent(ask);
    expect(h.app.currentMode).toBe("approval");
    const rendered = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("run bash");
    expect(rendered).toContain("rm -rf build");
    expect(rendered).toContain("allow once");
  });

  test("a file permission renders a colored diff preview", () => {
    const h = harness();
    h.app.handleEvent({
      type: "permission_asked",
      request: {
        id: "p2",
        toolCallId: "c2",
        toolName: "edit",
        permission: "edit",
        pattern: '{"path":"code.ts"}',
        description: "Edit code.ts",
        preview: {
          kind: "diff",
          file: {
            path: "code.ts",
            added: 1,
            removed: 1,
            hunks: ["@@ -1,1 +1,1 @@", "-const a = 1;", "+const a = 42;"],
          },
        },
      },
    });

    const rendered = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("Edit code.ts");
    expect(rendered).toContain("code.ts · +1 −1");
    expect(rendered).toContain("− const a = 1;");
    expect(rendered).toContain("+ const a = 42;");
    expect(rendered).not.toContain('{"path":"code.ts"}');
  });

  test("enter allows once", () => {
    const h = harness();
    h.app.handleEvent(ask);
    h.app.handleInput({
      type: "key",
      key: { name: "return", ctrl: false, alt: false, shift: false },
    });
    expect(h.replies).toEqual([{ id: "p1", outcome: "allow", remember: false }]);
  });

  test("right then enter selects always allow", () => {
    const h = harness();
    h.app.handleEvent(ask);
    h.app.handleInput({
      type: "key",
      key: { name: "right", ctrl: false, alt: false, shift: false },
    });
    h.app.handleInput({
      type: "key",
      key: { name: "return", ctrl: false, alt: false, shift: false },
    });
    expect(h.replies[0]?.remember).toBe(true);
  });

  test("escape denies", () => {
    const h = harness();
    h.app.handleEvent(ask);
    h.app.handleInput({
      type: "key",
      key: { name: "escape", ctrl: false, alt: false, shift: false },
    });
    expect(h.replies[0]?.outcome).toBe("deny");
  });

  test("resolving returns to composing", () => {
    const h = harness();
    h.app.handleEvent(ask);
    h.app.handleEvent({ type: "permission_resolved", requestId: "p1", outcome: "allow" });
    expect(h.app.currentMode).toBe("composing");
  });
});

describe("renderer registry", () => {
  test("an unknown tool falls back to the generic cell", () => {
    const registry = new RendererRegistry();
    const lines = registry.render(
      { toolName: "mystery_tool", args: { query: "something" } },
      { width: 60, depth: "none" },
    );
    expect(stripAnsi(lines[0] ?? "")).toContain("mystery_tool");
    expect(stripAnsi(lines[0] ?? "")).toContain("something");
  });

  test("a registered renderer overrides the fallback", () => {
    const registry = new RendererRegistry();
    registry.register("custom", () => ["  │ custom rendering"]);
    const lines = registry.render({ toolName: "custom", args: {} }, { width: 60, depth: "none" });
    expect(lines).toEqual(["  │ custom rendering"]);
  });

  test("a throwing renderer degrades to the generic cell instead of crashing", () => {
    const registry = new RendererRegistry();
    registry.register("broken", () => {
      throw new Error("renderer bug");
    });
    const lines = registry.render({ toolName: "broken", args: {} }, { width: 60, depth: "none" });
    expect(stripAnsi(lines[0] ?? "")).toContain("broken");
  });

  test("the generic renderer summarizes the result", () => {
    const lines = genericRenderer(
      {
        toolName: "anything",
        args: {},
        result: {
          role: "toolResult",
          toolCallId: "c",
          toolName: "anything",
          content: [{ type: "text", text: "first line\nsecond" }],
          isError: false,
          timestamp: 1,
        },
      },
      { width: 60, depth: "none" },
    );
    expect(stripAnsi(lines[0] ?? "")).toContain("first line");
  });

  test("expanded mode appends sanitized tool output even for custom renderers", () => {
    const registry = new RendererRegistry();
    registry.register("custom", () => ["  │ custom rendering"]);
    const lines = registry.render(
      {
        toolName: "custom",
        args: {},
        expanded: true,
        result: {
          role: "toolResult",
          toolCallId: "c",
          toolName: "custom",
          content: [{ type: "text", text: "line one\nline two" }],
          isError: false,
          timestamp: 1,
        },
      },
      { width: 60, depth: "none" },
    );
    expect(lines.map(stripAnsi)).toEqual(["  │ custom rendering", "  │ line one", "  │ line two"]);
  });

  test("a single enormous command-output line stays compact in the transcript", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const lines = registry.render(
      {
        toolName: "bash",
        args: { command: "print-a-lot" },
        result: {
          role: "toolResult",
          toolCallId: "c",
          toolName: "bash",
          content: [{ type: "text", text: "x".repeat(10_000) }],
          details: { exitCode: 0, durationMs: 12 },
          isError: false,
          timestamp: 1,
        },
      },
      { width: 60, depth: "none" },
    );
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(60);
  });

  test("an explicit user shell command uses the dollar action", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const lines = registry.render(
      {
        toolName: "bash",
        args: { command: "pwd", userShell: true },
        result: {
          role: "toolResult",
          toolCallId: "shell-1",
          toolName: "bash",
          content: [{ type: "text", text: "/tmp" }],
          details: { exitCode: 0, durationMs: 10 },
          isError: false,
          timestamp: 1,
        },
      },
      { width: 60, depth: "none" },
    );

    expect(stripAnsi(lines[0] ?? "")).toBe("  │ $ pwd · ✓ 10ms");
    expect(stripAnsi(lines[1] ?? "")).toBe("  │ /tmp");
  });
});

describe("tool output toggle", () => {
  test("ctrl+o expands completed commands and collapses them again", () => {
    const { app } = harness();
    app.handleEvent({ type: "agent_start" });
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "bun test" },
    });
    const collapsed = app.handleEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      result: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [
          {
            type: "text",
            text: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
          },
        ],
        details: { exitCode: 0 },
        isError: false,
        timestamp: 1,
      },
    });
    expect(collapsed.map(stripAnsi).join("\n")).toContain("lines omitted · ctrl+o to expand");
    expect(app.renderScreen().map(stripAnsi).join("\n")).not.toContain("│ line 6");

    feed(app, "\u000f");
    expect(app.areToolOutputsExpanded).toBe(true);
    const expanded = app.renderScreen().map(stripAnsi).join("\n");
    expect(expanded).toContain("ran bun test");
    expect(expanded).toContain("│ line 6");

    feed(app, "\u000f");
    expect(app.areToolOutputsExpanded).toBe(false);
    expect(app.renderScreen().map(stripAnsi).join("\n")).not.toContain("│ line 6");
  });

  test("expanded tools keep the final assistant response last", () => {
    const { app } = harness();
    app.handleEvent({ type: "agent_start" });
    app.handleEvent({
      type: "message_end",
      message: { ...assistant("I’ll inspect the project first."), stopReason: "toolUse" },
    });
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "bun test" },
    });
    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      result: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "one\ntwo" }],
        details: { exitCode: 0 },
        isError: false,
        timestamp: 1,
      },
    });
    app.handleEvent({
      type: "message_end",
      message: assistant("Done — the tests pass."),
    });

    feed(app, "\u000f");
    const expanded = app.renderScreen().map(stripAnsi);
    const preambleIndex = expanded.findIndex((line) => line.includes("inspect the project"));
    const toolIndex = expanded.findIndex((line) => line.includes("ran bun test"));
    const resultIndex = expanded.findIndex((line) => line.includes("│ two"));
    const finalIndex = expanded.findIndex((line) => line.includes("the tests pass"));

    expect(preambleIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(preambleIndex);
    expect(resultIndex).toBeGreaterThan(toolIndex);
    expect(finalIndex).toBeGreaterThan(resultIndex);
  });

  test("the expanded output stays complete and in place before the final response", () => {
    const { app } = harness();
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "long command" },
    });
    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      result: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [
          {
            type: "text",
            text: Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n"),
          },
        ],
        details: { exitCode: 0 },
        isError: false,
        timestamp: 1,
      },
    });
    app.handleEvent({
      type: "message_end",
      message: assistant("Done — this response stays after the expanded output."),
    });
    feed(app, "\u000f");
    const screen = app.renderScreen().map(stripAnsi);
    const toolIndex = screen.findIndex((line) => line.includes("ran long command"));
    const resultIndex = screen.findIndex((line) => line.includes("line 80"));
    const finalIndex = screen.findIndex((line) => line.includes("this response stays"));
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(toolIndex);
    expect(finalIndex).toBeGreaterThan(resultIndex);
    expect(screen.some((line) => line.includes("keeps this view bounded"))).toBe(false);
  });

  test("a resumed session restores expandable tools at their original position", () => {
    const { app } = harness();
    app.appendTranscript(["stale session"]);
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "explain it" }],
        timestamp: 1,
      },
      {
        ...assistant("I’ll read it first."),
        content: [
          { type: "text", text: "I’ll read it first." },
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: { path: "numpy_stock_trading.py" },
          },
        ],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [
          {
            type: "text",
            text: Array.from({ length: 12 }, (_, index) => `source line ${index + 1}`).join("\n"),
          },
        ],
        details: { lines: 12 },
        isError: false,
        timestamp: 2,
      },
      assistant("The explanation remains last."),
    ];

    app.replaceTranscript(messages, ["restored session"]);
    let screen = app.renderScreen().map(stripAnsi);
    expect(screen.join("\n")).not.toContain("stale session");
    expect(screen.join("\n")).not.toContain("source line 6");

    feed(app, "\u000f");
    screen = app.renderScreen().map(stripAnsi);
    const preambleIndex = screen.findIndex((line) => line.includes("read it first"));
    const toolIndex = screen.findIndex((line) => line.includes("read numpy_stock_trading.py"));
    const outputIndex = screen.findIndex((line) => line.includes("source line 12"));
    const finalIndex = screen.findIndex((line) => line.includes("explanation remains last"));

    expect(screen).toContain("restored session");
    expect(screen.join("\n")).toContain("source line 6");
    expect(toolIndex).toBeGreaterThan(preambleIndex);
    expect(outputIndex).toBeGreaterThan(toolIndex);
    expect(finalIndex).toBeGreaterThan(outputIndex);
  });

  test("the managed region never exceeds the terminal viewport", () => {
    const app = new App({
      width: 60,
      height: 10,
      depth: "none",
      model: "fake/fake-1",
      callbacks: {
        onSubmit: () => {},
        onAbort: () => {},
        onExit: () => {},
      },
    });
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "long command" },
    });
    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      result: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [
          {
            type: "text",
            text: Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n"),
          },
        ],
        details: { exitCode: 0 },
        isError: false,
        timestamp: 1,
      },
    });
    feed(app, "\u000f");
    app.handleEvent({
      type: "permission_asked",
      request: {
        id: "p1",
        toolCallId: "c2",
        toolName: "edit",
        permission: "edit",
        pattern: "{}",
        description: "Edit large.txt",
        preview: {
          kind: "text",
          lines: Array.from({ length: 20 }, (_, index) => `change ${index + 1}`),
        },
      },
    });

    const bottom = app.renderBottom().map(stripAnsi);
    expect(bottom.length).toBeLessThanOrEqual(9);
    expect(bottom.join("\n")).toContain("allow once");
    expect(bottom.at(-1)).toContain("ctrl+o");
  });
});

describe("resize", () => {
  test("the complete retained screen re-wraps to the new width", () => {
    const h = harness();
    h.app.handleEvent({
      type: "message_end",
      message: assistant(
        "A retained assistant response with enough words to wrap differently after a resize.",
      ),
    });
    h.app.editor.insert("x".repeat(120));

    h.app.setWidth(40);
    const narrow = h.app.renderScreen();
    for (const line of narrow) expect(stringWidth(line)).toBeLessThanOrEqual(40);

    h.app.setWidth(100);
    const wide = h.app.renderScreen();
    for (const line of wide) expect(stringWidth(line)).toBeLessThanOrEqual(100);
    expect(wide.length).toBeLessThan(narrow.length);
  });
});

describe("terminal safety", () => {
  async function runSafetyChild(mode: "signal" | "throw") {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./fixtures/terminal-safety-child.ts", import.meta.url).pathname,
        mode,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let stdout = "";
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const stdoutDone = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        stdout += decoder.decode(chunk, { stream: true });
        if (stdout.includes("ready\n")) ready();
      }
      stdout += decoder.decode();
    })();

    await isReady;
    if (mode === "signal") child.kill("SIGTERM");
    const [, stderr, exitCode] = await Promise.all([
      stdoutDone,
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  function fakeIo(): { io: TerminalIo; written: string[] } {
    const written: string[] = [];
    return {
      written,
      io: {
        write: (data) => written.push(data),
        columns: 80,
        rows: 24,
        isTty: true,
        setRawMode: (value) => written.push(`raw:${value}`),
        onResize: () => () => {},
      },
    };
  }

  test("restore always re-shows the cursor and leaves raw mode", () => {
    const { io, written } = fakeIo();
    const terminal = new Terminal(io);
    terminal.start();
    terminal.restore();

    const output = written.join("");
    expect(output).toContain("\u001b[?25l"); // hid the cursor
    expect(output).toContain("\u001b[?25h"); // and showed it again
    expect(written).toContain("raw:true");
    expect(written).toContain("raw:false");
    // Bracketed paste is turned back off too.
    expect(output).toContain("\u001b[?2004l");
  });

  test("restore is idempotent", () => {
    const { io } = fakeIo();
    const terminal = new Terminal(io);
    terminal.start();
    terminal.restore();
    expect(() => terminal.restore()).not.toThrow();
  });

  test("an actual SIGTERM restores terminal state before exit", async () => {
    const result = await runSafetyChild("signal");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('write:"\\u001b[<u\\u001b[>4;0m\\u001b[?2004l\\u001b[?25h"');
    expect(result.stdout).toContain("raw:false");
    expect(result.stdout).toContain("signal:SIGTERM");
  });

  test("an uncaught throw restores terminal state before exit", async () => {
    const result = await runSafetyChild("throw");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('write:"\\u001b[<u\\u001b[>4;0m\\u001b[?2004l\\u001b[?25h"');
    expect(result.stdout).toContain("raw:false");
    expect(result.stderr).toContain("mu crashed: Error: terminal safety fixture crash");
  });

  test("frames are wrapped in synchronized-output markers", () => {
    const { io, written } = fakeIo();
    const terminal = new Terminal(io);
    terminal.frame("hello");
    expect(written[0]).toBe("\u001b[?2026hhello\u001b[?2026l");
  });

  test("terminal titles use OSC 0 and strip injected controls", () => {
    const { io, written } = fakeIo();
    const terminal = new Terminal(io);
    terminal.setTitle("mu - project\u0007\u001b]0;injected");
    expect(written).toEqual(["\u001b]0;mu - project]0;injected\u0007"]);
  });
});

describe("full-screen renderer", () => {
  class VirtualScreen {
    readonly scrollback: string[] = [];
    readonly lines: string[];
    private row = 0;
    private column = 0;

    constructor(private height: number) {
      this.lines = Array.from({ length: height }, () => "");
    }

    write(data: string): void {
      for (let index = 0; index < data.length; ) {
        const char = data[index] ?? "";
        if (char === ESC && data[index + 1] === "[") {
          const sequence = data.slice(index + 2);
          const commandOffset = sequence.search(/[A-Za-z]/);
          if (commandOffset < 0) {
            index += 1;
            continue;
          }
          this.control(sequence.slice(0, commandOffset), sequence[commandOffset] ?? "");
          index += commandOffset + 3;
          continue;
        }
        if (char === "\r") {
          this.column = 0;
        } else if (char === "\n") {
          this.lineFeed();
        } else {
          const line = this.lines[this.row] ?? "";
          this.lines[this.row] =
            line.slice(0, this.column) + char + line.slice(this.column + char.length);
          this.column += 1;
        }
        index += 1;
      }
    }

    private control(params: string, command: string): void {
      const count = Math.max(1, Number.parseInt(params, 10) || 1);
      if (command === "A") {
        this.row = Math.max(0, this.row - count);
      } else if (command === "B") {
        this.row = Math.min(this.height - 1, this.row + count);
      } else if (command === "H") {
        this.row = 0;
        this.column = 0;
      } else if (command === "K") {
        this.lines[this.row] = "";
      } else if (command === "J") {
        if (params === "3") {
          this.scrollback.length = 0;
        } else if (params === "2") {
          this.lines.fill("");
        } else {
          for (let row = this.row; row < this.height; row++) this.lines[row] = "";
        }
      }
    }

    private lineFeed(): void {
      if (this.row < this.height - 1) {
        this.row += 1;
        return;
      }
      this.scrollback.push(this.lines.shift() ?? "");
      this.lines.push("");
    }
  }

  function setup() {
    const written: string[] = [];
    const terminal = new Terminal({
      write: (data) => written.push(data),
      columns: 80,
      rows: 24,
      isTty: true,
    });
    return { written, renderer: new FullScreenRenderer(terminal, 0) };
  }

  test("identical frames are not repainted", async () => {
    const { written, renderer } = setup();
    renderer.renderNow(["a", "b"]);
    const after = written.length;
    renderer.renderNow(["a", "b"]);
    expect(written.length).toBe(after);
  });

  test("a changed frame repaints", async () => {
    const { written, renderer } = setup();
    renderer.renderNow(["a"]);
    const after = written.length;
    renderer.renderNow(["b"]);
    expect(written.length).toBeGreaterThan(after);
  });

  test("embedded newlines are counted as physical screen rows", () => {
    const { written, renderer } = setup();
    renderer.renderNow(["first\nsecond", "third"]);
    expect(renderer.lineCount).toBe(3);

    renderer.renderNow(["replacement"]);
    expect(written.at(-1)).toContain(`${ESC}[2J${ESC}[H${ESC}[3J`);
  });

  test("tool expansion replaces its original row and keeps the final response after it", () => {
    const screen = new VirtualScreen(8);
    const terminal = new Terminal({
      write: (data) => screen.write(data),
      columns: 80,
      rows: 8,
      isTty: true,
    });
    const renderer = new FullScreenRenderer(terminal, 0);
    renderer.renderNow(["user", "tool compact", "final response", "rule", "composer"]);

    const expanded = [
      "user",
      "tool",
      ...Array.from({ length: 6 }, (_, index) => `output ${index + 1}`),
      "final response",
      "rule",
      "composer",
    ];
    renderer.renderNow(expanded);
    const rendered = [...screen.scrollback, ...screen.lines];
    expect(rendered).not.toContain("tool compact");
    expect(rendered.indexOf("output 6")).toBeLessThan(rendered.indexOf("final response"));
    expect(rendered.slice(-3)).toEqual(["final response", "rule", "composer"]);
  });

  test("repeated long tool expansion never overlays or duplicates the final response", () => {
    const { app } = harness();
    const screen = new VirtualScreen(24);
    const renderer = new FullScreenRenderer(
      new Terminal({
        write: (data) => screen.write(data),
        columns: 60,
        rows: 24,
        isTty: true,
      }),
      0,
    );
    app.handleEvent({ type: "agent_start" });
    app.handleEvent({
      type: "message_end",
      message: { ...assistant("I’ll read the implementation."), stopReason: "toolUse" },
    });
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "numpy_stock_trading.py" },
    });
    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: "read-1",
      result: {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [
          {
            type: "text",
            text: Array.from({ length: 98 }, (_, index) => `${index + 1} code line`).join("\n"),
          },
        ],
        details: { lines: 98 },
        isError: false,
        timestamp: 1,
      },
    });
    app.handleEvent({
      type: "message_end",
      message: assistant(
        `${Array.from({ length: 30 }, (_, index) => `Explanation ${index + 1}`).join("\n")}\nFINAL LIMITATIONS`,
      ),
    });

    renderer.renderNow(app.renderScreen());
    for (let index = 0; index < 3; index++) {
      feed(app, "\u000f");
      renderer.renderNow(app.renderScreen());
    }

    const rendered = [...screen.scrollback, ...screen.lines].join("\n");
    expect(rendered).not.toContain("expanded turn");
    expect(rendered.match(/FINAL LIMITATIONS/g)).toHaveLength(1);
    expect(rendered.indexOf("98 code line")).toBeLessThan(rendered.indexOf("FINAL LIMITATIONS"));
  });

  test("throttled renders coalesce into one paint", async () => {
    const written: string[] = [];
    const terminal = new Terminal({
      write: (data) => written.push(data),
      columns: 80,
      rows: 24,
      isTty: true,
    });
    const renderer = new FullScreenRenderer(terminal, 10);
    renderer.render(["1"]);
    renderer.render(["2"]);
    renderer.render(["3"]);
    expect(written.length).toBe(0);
    await Bun.sleep(25);
    expect(written.length).toBe(1);
    expect(written[0]).toContain("3");
  });

  test("requested renders defer expensive frame production until after coalescing", async () => {
    const written: string[] = [];
    const terminal = new Terminal({
      write: (data) => written.push(data),
      columns: 80,
      rows: 24,
      isTty: true,
    });
    const renderer = new FullScreenRenderer(terminal, 10);
    let produced = 0;
    renderer.requestRender(() => {
      produced++;
      return ["discarded"];
    });
    renderer.requestRender(() => {
      produced++;
      return ["latest"];
    });

    expect(produced).toBe(0);
    await Bun.sleep(25);
    expect(produced).toBe(1);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("latest");
    expect(written[0]).not.toContain("discarded");
  });
});

describe("@-file mention popup", () => {
  function mentionHarness() {
    const files = ["src/api/client.ts", "src/api/server.ts", "README.md"];
    const submitted: string[] = [];
    const app = new App({
      width: 60,
      depth: "none",
      model: "fake/fake-1",
      callbacks: {
        onSubmit: (text) => submitted.push(text),
        onAbort: () => {},
        onExit: () => {},
        onMentionQuery: (query) =>
          files.filter((f) => f.includes(query)).map((label) => ({ label })),
      },
    });
    return { app, submitted };
  }

  test("@ opens the popup and lists files", () => {
    const { app } = mentionHarness();
    feed(app, "@");
    expect(app.currentMode).toBe("mention");
    expect(app.renderBottom().map(stripAnsi).join("\n")).toContain("src/api/client.ts");
  });

  test("typing filters the list", () => {
    const { app } = mentionHarness();
    feed(app, "@server");
    const rendered = app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("src/api/server.ts");
    expect(rendered).not.toContain("README.md");
  });

  test("enter completes the path into the composer without submitting", () => {
    const { app, submitted } = mentionHarness();
    feed(app, "look at @server");
    app.handleInput({
      type: "key",
      key: { name: "return", ctrl: false, alt: false, shift: false },
    });

    expect(submitted).toEqual([]);
    expect(app.editor.text).toBe("look at src/api/server.ts ");
    expect(app.currentMode).toBe("composing");
  });

  test("escape closes the popup and leaves the text alone", () => {
    const { app } = mentionHarness();
    feed(app, "@ser");
    app.handleInput({
      type: "key",
      key: { name: "escape", ctrl: false, alt: false, shift: false },
    });
    expect(app.currentMode).toBe("composing");
    expect(app.editor.text).toBe("@ser");
  });

  test("a space closes the popup — @ was not a mention after all", () => {
    const { app } = mentionHarness();
    feed(app, "@ ");
    expect(app.currentMode).toBe("composing");
  });
});

describe("selection pickers (/model, /resume)", () => {
  test("a picker lists options and returns the chosen one", () => {
    const chosen: string[] = [];
    const h = harness();
    h.app.openPicker({
      title: "select a model",
      items: [
        { label: "anthropic/claude-opus-5", description: "most capable" },
        { label: "openai/gpt-5.1" },
      ],
      onChoose: (label) => chosen.push(label),
    });

    expect(h.app.currentMode).toBe("picker");
    const rendered = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("select a model");
    expect(rendered).toContain("anthropic/claude-opus-5");

    h.app.handleInput({
      type: "key",
      key: { name: "down", ctrl: false, alt: false, shift: false },
    });
    h.app.handleInput({
      type: "key",
      key: { name: "return", ctrl: false, alt: false, shift: false },
    });

    expect(chosen).toEqual(["openai/gpt-5.1"]);
    expect(h.app.currentMode).toBe("composing");
  });

  test("a picker can display a friendly label while returning an opaque value", () => {
    const chosen: string[] = [];
    const h = harness();
    h.app.openPicker({
      title: "resume a session",
      items: [{ label: "fix the login flow", value: "sms3cabdw" }],
      onChoose: (value) => chosen.push(value),
    });

    expect(h.app.renderBottom().map(stripAnsi).join("\n")).toContain("fix the login flow");
    h.app.handleInput({
      type: "key",
      key: { name: "return", ctrl: false, alt: false, shift: false },
    });
    expect(chosen).toEqual(["sms3cabdw"]);
  });

  test("escape cancels a picker without choosing", () => {
    const chosen: string[] = [];
    const h = harness();
    h.app.openPicker({
      title: "pick",
      items: [{ label: "a" }],
      onChoose: (label) => chosen.push(label),
    });
    h.app.handleInput({
      type: "key",
      key: { name: "escape", ctrl: false, alt: false, shift: false },
    });
    expect(chosen).toEqual([]);
    expect(h.app.currentMode).toBe("composing");
  });

  test("left arrow returns a picker to its parent menu", () => {
    const h = harness();
    let wentBack = false;
    h.app.openPicker({
      title: "child menu",
      items: [{ label: "a" }],
      onChoose: () => {},
      onBack: () => {
        wentBack = true;
        h.app.openCommandMenu();
      },
    });

    expect(h.app.renderBottom().map(stripAnsi).join("\n")).toContain("← back");
    h.app.handleInput({
      type: "key",
      key: { name: "left", ctrl: false, alt: false, shift: false },
    });

    expect(wentBack).toBe(true);
    expect(h.app.currentMode).toBe("select");
    expect(h.app.editor.text).toBe("/");
  });

  test("left arrow does nothing when a picker has no parent", () => {
    const h = harness();
    h.app.openPicker({
      title: "top-level picker",
      items: [{ label: "a" }],
      onChoose: () => {},
    });
    h.app.handleInput({
      type: "key",
      key: { name: "left", ctrl: false, alt: false, shift: false },
    });
    expect(h.app.currentMode).toBe("picker");
  });

  test("a filterable picker narrows and ranks models as the user types", () => {
    const chosen: string[] = [];
    const h = harness();
    h.app.openPicker({
      title: "select a model",
      filterable: true,
      items: [
        { label: "anthropic/claude-opus-5", description: "Claude Opus" },
        { label: "openai/gpt-5.1", description: "GPT 5.1" },
        { label: "google/gemini-2.5-pro", description: "Gemini Pro" },
      ],
      onChoose: (label) => chosen.push(label),
    });

    feed(h.app, "gpt51");
    const rendered = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("select a model · gpt51");
    expect(rendered).toContain("openai/gpt-5.1");
    expect(rendered).not.toContain("anthropic/claude-opus-5");
    expect(rendered).not.toContain("google/gemini-2.5-pro");

    h.app.handleInput({
      type: "key",
      key: { name: "return", ctrl: false, alt: false, shift: false },
    });
    expect(chosen).toEqual(["openai/gpt-5.1"]);
  });

  test("backspace broadens a filter and enter does nothing when there are no matches", () => {
    const chosen: string[] = [];
    const h = harness();
    h.app.openPicker({
      title: "select a model",
      filterable: true,
      items: [{ label: "anthropic/claude-opus-5" }, { label: "openai/gpt-5.1" }],
      onChoose: (label) => chosen.push(label),
    });

    feed(h.app, "gptx");
    expect(h.app.renderBottom().map(stripAnsi).join("\n")).toContain("no matches");
    h.app.handleInput({
      type: "key",
      key: { name: "return", ctrl: false, alt: false, shift: false },
    });
    expect(h.app.currentMode).toBe("picker");

    h.app.handleInput({
      type: "key",
      key: { name: "backspace", ctrl: false, alt: false, shift: false },
    });
    expect(h.app.renderBottom().map(stripAnsi).join("\n")).toContain("openai/gpt-5.1");
    expect(chosen).toEqual([]);
  });
});

describe("credential prompts", () => {
  test("a secret prompt never renders the API key and submits it once", () => {
    const h = harness();
    const submitted: string[] = [];
    h.app.openPrompt({
      title: "Enter API key for OpenAI:",
      secret: true,
      onSubmit: (value) => submitted.push(value),
    });

    feed(h.app, "sk-secret-value");
    const rendered = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("Enter API key for OpenAI:");
    expect(rendered).not.toContain("sk-secret-value");
    expect(rendered).toContain("••••");

    feed(h.app, "\r");
    expect(submitted).toEqual(["sk-secret-value"]);
    expect(h.app.currentMode).toBe("composing");
    expect(h.app.editor.text).toBe("");
  });

  test("escape cancels a secret prompt without submitting", () => {
    const h = harness();
    let cancelled = false;
    const submitted: string[] = [];
    h.app.openPrompt({
      title: "Enter key:",
      secret: true,
      onSubmit: (value) => submitted.push(value),
      onCancel: () => {
        cancelled = true;
      },
    });
    feed(h.app, "secret");
    h.app.handleInput({
      type: "key",
      key: { name: "escape", ctrl: false, alt: false, shift: false },
    });
    expect(cancelled).toBe(true);
    expect(submitted).toEqual([]);
    expect(h.app.currentMode).toBe("composing");
  });
});

describe("error reporting", () => {
  test("the real provider error is shown, not a generic line", () => {
    const { app } = harness();
    app.handleEvent({ type: "agent_start" });
    app.handleEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        model: "anthropic/claude-opus-5",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "error",
        errorMessage: 'No API key for provider "anthropic" (set ANTHROPIC_API_KEY)',
        timestamp: 1,
      },
    });
    const lines = app.handleEvent({ type: "agent_end", messages: [], reason: "error" });
    const text = lines.map(stripAnsi).join("\n");

    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).not.toContain("run ended with an error");
  });

  test("an error with no message still says something useful", () => {
    const { app } = harness();
    const lines = app.handleEvent({ type: "agent_end", messages: [], reason: "error" });
    expect(stripAnsi(lines[0] ?? "")).toContain("provider returned an error");
  });
});

describe("live streaming region", () => {
  test("streaming text appears before the turn completes", () => {
    const { app } = harness();
    app.handleEvent({ type: "agent_start" });
    app.handleEvent({
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        model: "fake/fake-1",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end",
        timestamp: 1,
      },
    });
    app.handleEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        model: "fake/fake-1",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end",
        timestamp: 1,
      },
      delta: { kind: "text_delta", contentIndex: 0, text: "thinking out loud" },
    });

    expect(app.renderBottom().map(stripAnsi).join("\n")).toContain("thinking out loud");
  });

  test("long assistant output remains one mutable screen cell while streaming", () => {
    const { app } = harness();
    const text = Array.from({ length: 80 }, (_, index) => `word-${index}`).join(" ");
    app.handleEvent({ type: "agent_start" });
    app.handleEvent({ type: "message_start", message: assistant("") });

    const committed = app.handleEvent({
      type: "message_update",
      message: assistant(text),
      delta: { kind: "text_delta", contentIndex: 0, text },
    });
    const live = app.renderScreen().map(stripAnsi);
    const final = app.handleEvent({ type: "message_end", message: assistant(text) });
    const screen = app.renderScreen().map(stripAnsi);

    expect(committed).toEqual([]);
    expect(live.some((line) => line.includes("word-79"))).toBe(true);
    expect(final.length).toBeGreaterThan(0);
    expect(screen.filter((line) => line.startsWith("  mu  "))).toHaveLength(1);
  });

  test("very large live Markdown renders a bounded tail and completes in full", () => {
    const { app } = harness();
    const code = [
      "```ts",
      "const firstGeneratedLine = 0;",
      ...Array.from(
        { length: 2_000 },
        (_, index) => `const generatedValue${index}: number = ${index};`,
      ),
      "const finalGeneratedLine = true;",
      "```",
    ].join("\n");
    app.handleEvent({ type: "agent_start" });
    app.handleEvent({ type: "message_start", message: assistant("") });
    app.handleEvent({
      type: "message_update",
      message: assistant(code),
      delta: { kind: "text_delta", contentIndex: 0, text: code },
    });

    const live = app.renderScreen().map(stripAnsi);
    expect(live.join("\n")).toContain("earlier characters retained while streaming");
    expect(live.join("\n")).not.toContain("firstGeneratedLine");
    expect(live.join("\n")).toContain("finalGeneratedLine");
    expect(live.length).toBeLessThan(1_000);

    app.handleEvent({ type: "message_end", message: assistant(code) });
    const completed = app.renderScreen().map(stripAnsi).join("\n");
    expect(completed).toContain("firstGeneratedLine");
    expect(completed).toContain("finalGeneratedLine");
    expect(completed).not.toContain("earlier characters retained while streaming");
  });

  test("streaming updates do not rerender unchanged transcript tools", () => {
    const registry = new RendererRegistry();
    let toolRenders = 0;
    registry.register("counted", () => {
      toolRenders++;
      return ["  │ counted"];
    });
    const app = new App({
      width: 80,
      height: 24,
      depth: "none",
      model: "fake/fake-1",
      registry,
      callbacks: {
        onSubmit: () => {},
        onAbort: () => {},
        onExit: () => {},
      },
    });
    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: "counted-1",
      result: {
        role: "toolResult",
        toolCallId: "counted-1",
        toolName: "counted",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 1,
      },
    });
    app.renderScreen();
    const afterInitialRender = toolRenders;
    app.renderScreen();
    app.handleEvent({ type: "message_start", message: assistant("") });
    app.handleEvent({
      type: "message_update",
      message: assistant("new streamed text"),
      delta: { kind: "text_delta", contentIndex: 0, text: "new streamed text" },
    });
    app.renderScreen();

    expect(afterInitialRender).toBeGreaterThan(0);
    expect(toolRenders).toBe(afterInitialRender);
  });

  test("a running tool shows a live cell with its output tail", () => {
    const { app } = harness();
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "bun test" },
    });
    app.handleEvent({
      type: "tool_execution_update",
      toolCallId: "c1",
      partial: [{ type: "text", text: "ok 1 - first" }],
    });

    const rendered = app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("running bun test");
    expect(rendered).toContain("ok 1 - first");
  });

  test("a multiline command preview stays inside the managed viewport", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const app = new App({
      width: 60,
      height: 10,
      depth: "none",
      model: "fake/fake-1",
      registry,
      callbacks: {
        onSubmit: () => {},
        onAbort: () => {},
        onExit: () => {},
      },
    });
    const command = Array.from({ length: 30 }, (_, index) => `command line ${index + 1}`).join(
      "\n",
    );
    app.handleEvent({
      type: "message_update",
      message: {
        ...assistant(""),
        content: [
          {
            type: "toolCall",
            id: "bash-1",
            name: "bash",
            arguments: { command },
          },
        ],
      },
      delta: { kind: "toolcall_delta", contentIndex: 0, argsFragment: "line 30" },
    });

    const bottom = app.renderBottom().map(stripAnsi);
    expect(bottom.length).toBeLessThanOrEqual(9);
    expect(bottom[0]).toContain("rows above hidden");
    expect(bottom.every((line) => !line.includes("\n"))).toBe(true);
  });

  test("live tool chunks join partial lines and stay bounded", () => {
    const { app } = harness();
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "long command" },
    });
    app.handleEvent({
      type: "tool_execution_update",
      toolCallId: "c1",
      partial: [{ type: "text", text: "hel" }],
    });
    app.handleEvent({
      type: "tool_execution_update",
      toolCallId: "c1",
      partial: [{ type: "text", text: "lo\nworld" }],
    });
    for (let index = 0; index < 60; index++) {
      app.handleEvent({
        type: "tool_execution_update",
        toolCallId: "c1",
        partial: [{ type: "text", text: `\nline ${index}` }],
      });
    }

    const rendered = app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("earlier lines · ctrl+o to expand");
    expect(rendered).toContain("line 59");
    expect(rendered).not.toContain("line 0\n");
  });

  test("streaming tool-call arguments preview a write before execution starts", () => {
    const { app } = harness();
    app.handleEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "write-1",
            name: "write",
            arguments: { path: "demo.py", content: "print('hello')\nprint('world')" },
          },
        ],
        model: "fake/fake-1",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
      delta: { kind: "toolcall_delta", contentIndex: 0, argsFragment: "world" },
    });

    const preview = app.renderBottom().map(stripAnsi).join("\n");
    expect(preview).toContain("write demo.py");
    expect(preview).toContain("+ print('hello')");

    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: "write-1",
      toolName: "write",
      args: { path: "demo.py", content: "print('hello')\nprint('world')" },
    });
    const running = app.renderBottom().map(stripAnsi).join("\n");
    expect(running.match(/write demo\.py/g)?.length).toBe(1);
  });
});

describe("concurrent permission asks", () => {
  const ask = (id: string, tool: string): AgentEvent => ({
    type: "permission_asked",
    request: {
      id,
      toolCallId: `c-${id}`,
      toolName: tool,
      permission: tool,
      pattern: "{}",
      description: `run ${tool}`,
    },
  });

  test("a second ask queues instead of overwriting the first", () => {
    const h = harness();
    h.app.handleEvent(ask("p1", "alpha"));
    h.app.handleEvent(ask("p2", "beta"));
    // The first is still the one displayed.
    expect(h.app.renderBottom().map(stripAnsi).join("\n")).toContain("run alpha");
  });

  test("resolving the visible ask advances to the queued one", () => {
    const h = harness();
    h.app.handleEvent(ask("p1", "alpha"));
    h.app.handleEvent(ask("p2", "beta"));
    h.app.handleEvent({ type: "permission_resolved", requestId: "p1", outcome: "allow" });

    expect(h.app.currentMode).toBe("approval");
    expect(h.app.renderBottom().map(stripAnsi).join("\n")).toContain("run beta");
  });

  test("resolving an unknown id does not close the visible ask", () => {
    const h = harness();
    h.app.handleEvent(ask("p1", "alpha"));
    h.app.handleEvent({ type: "permission_resolved", requestId: "stale", outcome: "allow" });
    expect(h.app.currentMode).toBe("approval");
  });

  test("the composer returns only when every ask is resolved", () => {
    const h = harness();
    h.app.handleEvent(ask("p1", "alpha"));
    h.app.handleEvent(ask("p2", "beta"));
    h.app.handleEvent({ type: "permission_resolved", requestId: "p1", outcome: "allow" });
    h.app.handleEvent({ type: "permission_resolved", requestId: "p2", outcome: "deny" });
    expect(h.app.currentMode).toBe("composing");
  });
});

describe("command popup filtering", () => {
  test("backspace widens the filtered list again", () => {
    const h = harness();
    h.app.setCommands([{ label: "model" }, { label: "compact" }, { label: "undo" }]);
    feed(h.app, "/m");
    let rendered = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("model");
    expect(rendered).not.toContain("undo");

    h.app.handleInput({
      type: "key",
      key: { name: "backspace", ctrl: false, alt: false, shift: false },
    });
    rendered = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("model");
    expect(rendered).toContain("undo");
  });
});

describe("thinking toggle", () => {
  test("ctrl+t cycles the level and reports it", () => {
    const levels: string[] = [];
    const app = new App({
      width: 60,
      depth: "none",
      model: "fake/fake-1",
      callbacks: {
        onSubmit: () => {},
        onAbort: () => {},
        onExit: () => {},
        onThinkingChange: (level) => levels.push(level),
      },
    });

    const ctrlT = {
      type: "key" as const,
      key: { name: "t", ctrl: true, alt: false, shift: false },
    };
    app.handleInput(ctrlT);
    app.handleInput(ctrlT);
    expect(levels).toEqual(["low", "medium"]);
    expect(app.thinking).toBe("medium");
  });

  test("ctrl+t follows the active model's thinking levels", () => {
    const levels: string[] = [];
    const app = new App({
      width: 60,
      depth: "none",
      model: "openai-codex/gpt-specific",
      thinkingLevels: ["low", "xhigh", "max", "ultra"],
      callbacks: {
        onSubmit: () => {},
        onAbort: () => {},
        onExit: () => {},
        onThinkingChange: (level) => levels.push(level),
      },
    });
    app.setThinking("low");

    const ctrlT = {
      type: "key" as const,
      key: { name: "t", ctrl: true, alt: false, shift: false },
    };
    app.handleInput(ctrlT);
    app.handleInput(ctrlT);
    app.handleInput(ctrlT);

    expect(levels).toEqual(["xhigh", "max", "ultra"]);
    expect(app.thinking).toBe("ultra");
  });

  test("the footer shows the current thinking level when idle", () => {
    const h = harness();
    expect(stripAnsi(h.app.renderBottom().at(-1) ?? "")).toContain("think off");
  });
});

describe("startup banner", () => {
  test("identifies mu and lists the key affordances", () => {
    const h = harness();
    h.app.setModel("openai/gpt-5.1");
    const banner = h.app.banner().map(stripAnsi).join("\n");

    expect(banner).toContain("mu");
    expect(banner).toContain("openai/gpt-5.1");
    expect(banner).toContain("/ for commands");
    expect(banner).toContain("ctrl+t");
    expect(banner).toContain("ctrl+c to exit");
  });
});

describe("model footer state", () => {
  test("a model switch updates the full window and resets active context usage", () => {
    const h = harness();
    h.app.handleEvent({
      type: "usage_updated",
      sessionTotals: {
        inputTokens: 1_100,
        outputTokens: 11,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      contextTokens: 136_000,
      contextPercent: 0.5,
    });

    h.app.setModel("openai/gpt-5.1", 1_000_000);
    const footerLine = stripAnsi(h.app.renderBottom().at(-1) ?? "");
    expect(footerLine).toContain("openai/gpt-5.1 · 0.0%/1.0m");
    expect(footerLine).toContain("↑1.1k ↓11");
  });
});

describe("mid-buffer file mentions", () => {
  function mentionHarness() {
    const files = ["src/chosen.ts", "src/other.ts"];
    const submitted: string[] = [];
    const app = new App({
      width: 60,
      depth: "none",
      model: "fake/fake-1",
      callbacks: {
        onSubmit: (text) => submitted.push(text),
        onAbort: () => {},
        onExit: () => {},
        onMentionQuery: (query) =>
          files.filter((f) => f.includes(query)).map((label) => ({ label })),
      },
    });
    return { app, submitted };
  }

  test("completing a mention in the middle keeps the text after the cursor", () => {
    const { app } = mentionHarness();
    app.editor.setText("before  after");
    // Put the cursor between the two spaces, as if editing an earlier part.
    app.editor.setOffset("before ".length);

    feed(app, "@chosen");
    app.handleInput({
      type: "key",
      key: { name: "return", ctrl: false, alt: false, shift: false },
    });

    expect(app.editor.text).toBe("before src/chosen.ts  after");
  });

  test("the query is taken from the mention span, not the rest of the line", () => {
    const queries: string[] = [];
    const app = new App({
      width: 60,
      depth: "none",
      model: "fake/fake-1",
      callbacks: {
        onSubmit: () => {},
        onAbort: () => {},
        onExit: () => {},
        onMentionQuery: (query) => {
          queries.push(query);
          return [{ label: "src/chosen.ts" }];
        },
      },
    });
    app.editor.setText("head  tail");
    app.editor.setOffset("head ".length);
    feed(app, "@s");

    expect(queries.at(-1)).toBe("s");
  });

  test("a mention at the end still behaves as before", () => {
    const { app } = mentionHarness();
    feed(app, "look at @chosen");
    app.handleInput({
      type: "key",
      key: { name: "return", ctrl: false, alt: false, shift: false },
    });
    expect(app.editor.text).toBe("look at src/chosen.ts ");
  });
});
