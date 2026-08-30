// Integration: a scripted fake-agent event stream drives the whole UI with
// zero network, exactly as the milestone requires.
import { describe, expect, spyOn, test } from "bun:test";
import type { AgentEvent, AgentMessage } from "@mu/core";
import { App, type AppCallbacks, type AppOptions, CTRL_C_EXIT_WINDOW_MS } from "./app.ts";
import { InputDecoder } from "./input.ts";
import {
  codingRenderers,
  genericRenderer,
  RendererRegistry,
  subagentRenderers,
} from "./registry.ts";
import { FullScreenRenderer, type RenderFrame } from "./renderer.ts";
import { stripAnsi, styleText } from "./style.ts";
import { Terminal, type TerminalIo } from "./terminal.ts";
import { stringWidth } from "./width.ts";
import { terminalRows } from "./wrap.ts";

const ESC = "\u001b";

function physicalFrame(lines: string[], width = 80): RenderFrame {
  return { transcript: [], managed: terminalRows(lines, width), dirtyFrom: 0 };
}

function harness(
  overrides: Partial<AppCallbacks> = {},
  options: Partial<Pick<AppOptions, "depth" | "version">> = {},
) {
  const submitted: string[] = [];
  const steers: string[] = [];
  const followUps: string[] = [];
  const commands: string[] = [];
  const replies: { id: string; outcome: string; remember: boolean }[] = [];
  let aborted = false;
  let exited = false;

  const registry = new RendererRegistry();
  registry.registerAll(codingRenderers);
  registry.registerAll(subagentRenderers);

  const app = new App({
    width: 60,
    depth: "none",
    model: "fake/fake-1",
    cwd: "~/code/mu",
    contextWindow: 272_000,
    registry,
    ...options,
    callbacks: {
      onSubmit: (text) => void submitted.push(text),
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

function press(app: App, name: string): void {
  app.handleInput({ type: "key", key: { name, ctrl: false, alt: false, shift: false } });
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

    for (const event of script) app.handleEvent(event);
    const visible = app.renderTranscript().map(stripAnsi);

    expect(visible).toContain("  ▸ add retries");
    expect(visible).toContain("  › read src/api/client.ts · 142 lines");
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
    const runningHint = app.renderBottom().map(stripAnsi).join(" ").replace(/\s+/g, " ");
    expect(runningHint).toContain("enter steer");
    expect(runningHint).toContain("tab follow-up");
    expect(runningHint).toContain("esc/ctrl+c interrupt");
    app.handleEvent({ type: "agent_end", messages: [], reason: "done" });
    expect(stripAnsi(app.renderBottom().at(-1) ?? "")).not.toContain("enter steer");
  });

  test("the running row shows elapsed time, ticking without a new event", () => {
    const { app } = harness();
    const now = Date.now();
    const spy = spyOn(Date, "now").mockReturnValue(now);
    try {
      app.handleEvent({ type: "agent_start" });
      const started = app.renderBottom().map(stripAnsi).join(" ").replace(/\s+/g, " ");
      expect(started).toContain("0ms");

      // No new event — a repaint alone (e.g. the spinner's tick timer) must
      // still reflect real elapsed time, since nothing else drives this row.
      spy.mockReturnValue(now + 14_000);
      const later = app.renderBottom().map(stripAnsi).join(" ").replace(/\s+/g, " ");
      expect(later).toContain("14s");

      app.handleEvent({ type: "agent_end", messages: [], reason: "done" });
      spy.mockReturnValue(now + 20_000);
      // agent_start on the next turn resets the clock, not carries it over.
      app.handleEvent({ type: "agent_start" });
      const nextTurn = app.renderBottom().map(stripAnsi).join(" ").replace(/\s+/g, " ");
      expect(nextTurn).toContain("0ms");
    } finally {
      spy.mockRestore();
    }
  });

  test("a running subagent uses Braille and replaces running with elapsed time", () => {
    const { app } = harness();
    const now = Date.now();
    const spy = spyOn(Date, "now").mockReturnValue(now);
    try {
      app.handleEvent({
        type: "tool_execution_start",
        toolCallId: "counsel-1",
        toolName: "counsel",
        args: { question: "Review parser" },
      });
      const started = app.renderScreen().map(stripAnsi).join("\n");
      expect(started).toContain("⠋ consulting counsel Review parser · 0ms");

      spy.mockReturnValue(now + 12_000);
      app.tickSpinner();
      const later = app.renderScreen().map(stripAnsi).join("\n");
      expect(later).toContain("⠙ consulting counsel Review parser · 12s");
      expect(later).not.toContain("· running");
    } finally {
      spy.mockRestore();
    }
  });

  test("a running subagent streams an expandable activity trace", () => {
    const { app } = harness();
    const progress = (event: Record<string, unknown>) => ({
      type: "subagent-progress",
      kind: "search",
      description: "Trace parser ownership",
      model: "openai/gpt-5.6-terra",
      thinkingLevel: "low",
      event,
    });
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: "search-1",
      toolName: "search",
      args: { query: "Trace parser ownership across every relevant package" },
    });
    app.handleEvent({
      type: "tool_execution_update",
      toolCallId: "search-1",
      partial: [],
      details: progress({ type: "assistant_start" }),
    });
    app.handleEvent({
      type: "tool_execution_update",
      toolCallId: "search-1",
      partial: [],
      details: progress({
        type: "message",
        message: {
          ...assistant(""),
          content: [
            {
              type: "toolCall",
              id: "read-1",
              name: "read",
              arguments: { path: "packages/parser.ts", offset: 10, limit: 20 },
            },
          ],
        },
      }),
    });
    app.handleEvent({
      type: "tool_execution_update",
      toolCallId: "search-1",
      partial: [],
      details: progress({ type: "assistant_start" }),
    });
    app.handleEvent({
      type: "tool_execution_update",
      toolCallId: "search-1",
      partial: [],
      details: progress({ type: "text_delta", text: "## Finding\n\nParser owns the flow." }),
    });

    feed(app, "\u000f");
    expect(app.currentMode).toBe("activity");
    press(app, "right");
    const expanded = app.renderScreen().map(stripAnsi).join("\n");
    expect(expanded).toContain("❯ ⠋ searching codebase");
    expect(expanded).toContain("prompt");
    expect(expanded).toContain("Trace parser ownership across every relevant package");
    expect(expanded).toContain("read packages/parser.ts L10-29");
    expect(expanded).toContain("response");
    expect(expanded).toContain("Finding");
    expect(expanded).toContain("Parser owns the flow.");

    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: "search-1",
      result: {
        role: "toolResult",
        toolCallId: "search-1",
        toolName: "search",
        content: [{ type: "text", text: "## Finding\n\nParser owns the flow." }],
        details: {
          type: "subagent",
          kind: "search",
          description: "Trace parser ownership",
          model: "openai/gpt-5.6-terra",
          thinkingLevel: "low",
          durationMs: 1000,
          messages: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          reason: "done",
        },
        isError: false,
        timestamp: 1,
      },
    });
    const completed = app.renderScreen().map(stripAnsi).join("\n");
    expect(completed).not.toContain("❯ consulted counsel");
    expect(completed).toContain("❯ searched codebase");
    expect(completed).toContain("Parser owns the flow.");
  });

  test("a completed run leaves a permanent 'worked for' transcript line", () => {
    const { app } = harness();
    const now = Date.now();
    const spy = spyOn(Date, "now").mockReturnValue(now);
    try {
      app.handleEvent({ type: "agent_start" });
      spy.mockReturnValue(now + 191_000); // 3m 11s
      const returned = app.handleEvent({ type: "agent_end", messages: [], reason: "done" });
      expect(stripAnsi(returned[0] ?? "")).toBe("  worked for 3m 11s");
      expect(returned[1]).toBe("");

      // Retained: still present in scrollback after later renders, and after
      // a second run — turns stack up rather than the caption being replaced.
      const screen = app.renderScreen().map(stripAnsi).join("\n");
      expect(screen).toContain("worked for 3m 11s");

      app.handleEvent({ type: "agent_start" });
      spy.mockReturnValue(now + 191_000 + 15_000);
      app.handleEvent({ type: "agent_end", messages: [], reason: "done" });
      const laterScreen = app.renderScreen().map(stripAnsi).join("\n");
      expect(laterScreen).toContain("worked for 3m 11s");
      expect(laterScreen).toContain("worked for 15s");
    } finally {
      spy.mockRestore();
    }
  });

  test("an error still reports elapsed time, after the error detail", () => {
    const { app } = harness();
    const lines = app.handleEvent({ type: "agent_end", messages: [], reason: "error" });
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("✗");
    expect(text).toContain("worked for");
    expect(text.indexOf("✗")).toBeLessThan(text.indexOf("worked for"));
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
    expect(h.app.renderTranscript().map(stripAnsi)).toContain("  ▸ hello");
  });

  test("an immediate submitted message is reconciled with the durable user event", () => {
    const h = harness();
    feed(h.app, "original\r");
    expect(
      h.app
        .renderTranscript()
        .map(stripAnsi)
        .filter((line) => line.includes("▸")),
    ).toEqual(["  ▸ original"]);

    h.app.handleEvent({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "rewritten by hook" }],
        timestamp: 1,
      },
    });

    expect(
      h.app
        .renderTranscript()
        .map(stripAnsi)
        .filter((line) => line.includes("▸")),
    ).toEqual(["  ▸ rewritten by hook"]);
  });

  test("a run that ends before accepting its submitted message removes the preview", () => {
    const h = harness();
    feed(h.app, "consumed by hook\r");
    h.app.handleEvent({ type: "agent_start" });
    h.app.handleEvent({ type: "agent_end", messages: [], reason: "done" });

    expect(h.app.renderTranscript().map(stripAnsi).join("\n")).not.toContain("consumed by hook");
  });

  test("a surface that rejects submission does not retain its preview", () => {
    const h = harness({ onSubmit: () => false });
    feed(h.app, "rejected\r");

    expect(h.app.renderTranscript().map(stripAnsi).join("\n")).not.toContain("rejected");
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

  test("a paste with terminal-style carriage-return newlines stays intact", () => {
    const h = harness();
    feed(h.app, `${ESC}[200~one\rtwo\r\nthree${ESC}[201~`);

    expect(h.submitted).toEqual([]);
    expect(h.app.editor.text).toBe("one\ntwo\nthree");
    const rendered = stripAnsi(h.app.renderBottom().join("\n"));
    expect(rendered).toContain("│ ▸ one");
    expect(rendered).toContain("│   two");
    expect(rendered).toContain("│   three");
  });

  test("a long pasted draft scrolls with the editor cursor", () => {
    const app = new App({
      width: 60,
      height: 10,
      depth: "none",
      model: "fake/fake-1",
      cwd: "~/code/mu",
      callbacks: {
        onSubmit: () => {},
        onAbort: () => {},
        onExit: () => {},
      },
    });
    app.editor.insert(
      Array.from({ length: 20 }, (_, index) => `draft line ${index + 1}`).join("\n"),
    );

    let bottom = app.renderBottom().map(stripAnsi);
    expect(bottom.join("\n")).toContain("draft line 20");
    expect(bottom[0]).toContain("rows above hidden");

    for (let index = 0; index < 19; index++) feed(app, `${ESC}[A`);
    bottom = app.renderBottom().map(stripAnsi);
    expect(bottom.join("\n")).toContain("draft line 1");
    expect(bottom.join("\n")).not.toContain("draft line 20");
    expect(bottom.some((line) => line.includes("rows below hidden"))).toBe(true);
    expect(bottom.at(-2)).toContain("~/code/mu");
    expect(bottom).toHaveLength(9);
  });

  test("arrow keys move through a non-empty draft instead of replacing it with history", () => {
    const h = harness();
    feed(h.app, "previous\r");
    h.app.editor.insert("first line\nsecond line");

    feed(h.app, `${ESC}[A`);
    expect(h.app.editor.text).toBe("first line\nsecond line");
    expect(h.app.editor.cursor).toEqual({ row: 0, col: "first line".length });

    feed(h.app, `${ESC}[B`);
    expect(h.app.editor.text).toBe("first line\nsecond line");
    expect(h.app.editor.cursor).toEqual({ row: 1, col: "first line".length });
  });

  test("up arrow recalls history when the editor is empty", () => {
    const h = harness();
    feed(h.app, "previous\r");
    feed(h.app, `${ESC}[A`);
    expect(h.app.editor.text).toBe("previous");
  });

  test("a resumed transcript replaces and cycles through its persisted prompt history", () => {
    const h = harness();
    feed(h.app, "prompt from current process\r");
    h.app.replaceTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "resumed first prompt" }],
        timestamp: 1,
      },
      assistant("first answer"),
      {
        role: "user",
        content: [{ type: "text", text: "resumed latest prompt" }],
        timestamp: 2,
      },
      assistant("latest answer"),
    ]);

    feed(h.app, `${ESC}[A`);
    expect(h.app.editor.text).toBe("resumed latest prompt");
    expect(h.app.editor.text).not.toBe("prompt from current process");

    feed(h.app, `${ESC}[A`);
    expect(h.app.editor.text).toBe("resumed first prompt");
    feed(h.app, `${ESC}[A`);
    expect(h.app.editor.text).toBe("resumed first prompt");
    feed(h.app, `${ESC}[B`);
    expect(h.app.editor.text).toBe("resumed latest prompt");
    feed(h.app, `${ESC}[B`);
    expect(h.app.editor.text).toBe("");
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

  test("ctrl+c aborts a running agent instead of exiting", () => {
    const h = harness();
    h.app.handleEvent({ type: "agent_start" });
    feed(h.app, "\u0003");
    expect(h.aborted).toBe(true);
    expect(h.exited).toBe(false);
  });

  test("idle ctrl+c clears composer text instead of exiting", () => {
    const h = harness();
    feed(h.app, "hello");
    expect(h.app.editor.text).toBe("hello");
    feed(h.app, "\u0003");
    expect(h.app.editor.text).toBe("");
    expect(h.exited).toBe(false);
  });

  test("idle ctrl+c on an empty composer requires a second press to exit", () => {
    const h = harness();
    feed(h.app, "\u0003");
    expect(h.exited).toBe(false);
    expect(stripAnsi(h.app.renderBottom().join("\n"))).toContain("press ctrl+c again");
    feed(h.app, "\u0003");
    expect(h.exited).toBe(true);
  });

  test("the ctrl+c exit window expires and re-arms instead of exiting", () => {
    const h = harness();
    const now = Date.now();
    const spy = spyOn(Date, "now").mockReturnValue(now);
    try {
      feed(h.app, "\u0003");
      expect(h.exited).toBe(false);
      spy.mockReturnValue(now + CTRL_C_EXIT_WINDOW_MS + 1);
      feed(h.app, "\u0003");
      expect(h.exited).toBe(false);
      expect(stripAnsi(h.app.renderBottom().join("\n"))).toContain("press ctrl+c again");
    } finally {
      spy.mockRestore();
    }
  });

  test("other input disarms a pending ctrl+c exit", () => {
    const h = harness();
    feed(h.app, "\u0003");
    feed(h.app, "a");
    feed(h.app, "\u0003");
    expect(h.exited).toBe(false);
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

  test("the local collapse command remains discoverable in the slash menu", () => {
    const h = harness();
    h.app.setCommands([{ label: "model" }]);
    feed(h.app, "/coll");
    expect(h.app.renderBottom().map(stripAnsi).join("\n")).toContain("Collapse all expanded");
    feed(h.app, "\r");
    expect(h.commands).toEqual([]);
    expect(h.app.currentMode).toBe("composing");
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
    let shell = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(shell).toContain("╭─ shell ");
    expect(shell).toContain("│ $ ");
    expect(shell).toContain("enter run · esc cancel");

    feed(h.app, "printf ok");
    shell = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(shell).toContain("│ $ printf ok");
    expect(shell).not.toContain("!printf ok");

    feed(h.app, "\r");
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

  test("a multiline bash approval remains inside an intact composer box", () => {
    const h = harness();
    h.app.handleEvent({
      type: "permission_asked",
      request: {
        id: "p2",
        toolCallId: "c2",
        toolName: "bash",
        permission: "bash",
        pattern: "python3 - <<'PY'\nprint('hello')\nPY",
        description: "Run bash",
      },
    });

    const rendered = h.app.renderBottom().map(stripAnsi);
    for (const commandLine of ["python3 - <<'PY'", "print('hello')", "PY"]) {
      const row = rendered.find((line) => line.includes(commandLine));
      expect(row).toStartWith("  │ ");
      expect(row).toEndWith("│");
    }
    for (const line of rendered) {
      expect(line).not.toContain("\n");
      expect(stringWidth(line)).toBeLessThanOrEqual(60);
    }
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

  test("expanded output has an honest per-tool row bound", () => {
    const registry = new RendererRegistry();
    registry.register("custom", () => ["  │ custom rendering"]);
    const output = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = registry
      .render(
        {
          toolName: "custom",
          args: {},
          expanded: true,
          result: {
            role: "toolResult",
            toolCallId: "c",
            toolName: "custom",
            content: [{ type: "text", text: output }],
            isError: false,
            timestamp: 1,
          },
        },
        { width: 60, depth: "none" },
      )
      .map(stripAnsi);

    expect(lines.length).toBeLessThanOrEqual(201);
    expect(lines).toContain("  │ line 1");
    expect(lines).toContain("  │ line 1000");
    expect(lines.some((line) => line.includes("801 lines omitted"))).toBe(true);
  });

  test("an expanded read syntax-highlights source while keeping its line numbers dim", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const lines = registry.render(
      {
        toolName: "read",
        args: { path: "models.py" },
        expanded: true,
        result: {
          role: "toolResult",
          toolCallId: "r",
          toolName: "read",
          content: [
            {
              type: "text",
              text: [
                '    1  """Agent models."""',
                "    2  from dataclasses import dataclass",
                "    3  ",
                "    4  @dataclass",
                "    5  class Plan:",
                "    6      name: str\u001b]52;c;unsafe\u0007",
              ].join("\n"),
            },
          ],
          details: { lines: 6 },
          isError: false,
          timestamp: 1,
        },
      },
      { width: 80, depth: "truecolor" },
    );

    expect(lines[1]).toContain(styleText("    1  ", { dim: true }, "truecolor"));
    expect(lines.join("\n")).toContain(styleText("from", { syntax: "keyword" }, "truecolor"));
    expect(lines.join("\n")).toContain(
      styleText('"""Agent models."""', { syntax: "string" }, "truecolor"),
    );
    expect(lines.join("\n")).not.toContain("\u001b]52");
    expect(lines.map(stripAnsi)).toContain("  │     5  class Plan:");
  });

  test("expanded syntax-highlighted reads retain the output row bound", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const output = Array.from(
      { length: 1_000 },
      (_, index) => `${String(index + 1).padStart(5)}  value_${index + 1} = ${index + 1}`,
    ).join("\n");
    const lines = registry
      .render(
        {
          toolName: "read",
          args: { path: "values.py" },
          expanded: true,
          result: {
            role: "toolResult",
            toolCallId: "r",
            toolName: "read",
            content: [{ type: "text", text: output }],
            details: { lines: 1_000 },
            isError: false,
            timestamp: 1,
          },
        },
        { width: 80, depth: "none" },
      )
      .map(stripAnsi);

    expect(lines.length).toBeLessThanOrEqual(201);
    expect(lines).toContain("  │     1  value_1 = 1");
    expect(lines).toContain("  │  1000  value_1000 = 1000");
    expect(lines.some((line) => line.includes("801 lines omitted"))).toBe(true);
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

  test("a completed edit numbers its diff with the file's own lines", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const args = {
      path: "code.ts",
      edits: [
        { oldString: "const c = 3;", newString: "const c = 30;" },
        { oldString: "const a = 1;", newString: "const a = 10;\nconst extra = 0;" },
      ],
    };
    const result = {
      role: "toolResult" as const,
      toolCallId: "e",
      toolName: "edit",
      content: [{ type: "text" as const, text: "Edited code.ts (2 replacements)" }],
      details: {
        occurrences: 2,
        hunks: [
          { edit: 1, oldLine: 1, newLine: 1 },
          { edit: 0, oldLine: 3, newLine: 4 },
        ],
        diff: {
          path: "code.ts",
          added: 3,
          removed: 2,
          hunks: [
            "@@ -1,1 +1,2 @@",
            "-const a = 1;",
            "+const a = 10;",
            "+const extra = 0;",
            "@@ -3,1 +4,1 @@",
            "-const c = 3;",
            "+const c = 30;",
          ],
        },
      },
      isError: false,
      timestamp: 1,
    };

    const lines = registry
      .render({ toolName: "edit", args, result, expanded: true }, { width: 60, depth: "none" })
      .map(stripAnsi);

    // File order, not the order the model sent, and the added line shifts the
    // later hunk's new-side number past its old-side one.
    expect(lines.slice(1)).toEqual([
      "  │     1 − const a = 1;",
      "  │     1 + const a = 10;",
      "  │     2 + const extra = 0;",
      "  │     3 − const c = 3;",
      "  │     4 + const c = 30;",
    ]);
    expect(lines.filter((line) => line.includes("code.ts"))).toHaveLength(1);
  });

  test("a completed edit uses the actual file diff instead of replacement payload counts", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const result = {
      role: "toolResult" as const,
      toolCallId: "e",
      toolName: "edit",
      content: [{ type: "text" as const, text: "Edited pyproject.toml (1 replacement)" }],
      details: {
        occurrences: 1,
        hunks: [{ edit: 0, oldLine: 13, newLine: 13 }],
        diff: {
          path: "pyproject.toml",
          added: 1,
          removed: 0,
          hunks: [
            "@@ -13,3 +13,4 @@",
            " [project.scripts]",
            ' multiagent-coder = "multiagent_coder.cli:main"',
            '+coding-agent = "multiagent_coder.tui:main"',
            " ",
          ],
        },
      },
      isError: false,
      timestamp: 1,
    };
    const lines = registry
      .render(
        {
          toolName: "edit",
          args: {
            path: "pyproject.toml",
            oldString: '[project.scripts]\nmultiagent-coder = "multiagent_coder.cli:main"\n',
            newString:
              '[project.scripts]\nmultiagent-coder = "multiagent_coder.cli:main"\ncoding-agent = "multiagent_coder.tui:main"\n',
          },
          result,
          expanded: true,
        },
        { width: 80, depth: "none" },
      )
      .map(stripAnsi);

    expect(lines[0]).toBe("  │ edited pyproject.toml · 1 replacement");
    expect(lines.join("\n")).not.toContain("+4 −3");
    expect(lines.filter((line) => line.includes("pyproject.toml"))).toHaveLength(1);
    expect(lines).not.toContain("  │ Edited pyproject.toml (1 replacement)");
    expect(lines).toContain('  │    15 + coding-agent = "multiagent_coder.tui:main"');
  });

  test("an expanded failed edit still shows its error", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const lines = registry
      .render(
        {
          toolName: "edit",
          args: { path: "code.ts", oldString: "old", newString: "new" },
          expanded: true,
          result: {
            role: "toolResult",
            toolCallId: "e",
            toolName: "edit",
            content: [{ type: "text", text: "code.ts changed since it was read" }],
            isError: true,
            timestamp: 1,
          },
        },
        { width: 60, depth: "none" },
      )
      .map(stripAnsi);

    expect(lines.join("\n")).toContain("code.ts changed since it was read");
  });

  test("an edit still running renders its diff without invented line numbers", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const lines = registry
      .render(
        {
          toolName: "edit",
          args: { path: "code.ts", oldString: "a", newString: "b" },
          running: true,
        },
        { width: 60, depth: "none" },
      )
      .map(stripAnsi);

    expect(lines.slice(1)).toEqual(["  │       − a", "  │       + b"]);
  });

  test("an edit whose arguments are still streaming renders no partial diff", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    // A deletion whose replacement has not arrived yet: the worst frame to show.
    const args = { path: "a.ts", oldString: "const limit = 3;", newString: "const li" };

    const streaming = registry.render(
      { toolName: "edit", args, argsStreaming: true },
      { width: 60, depth: "none" },
    );
    expect(streaming.map(stripAnsi)).toEqual(["  │ edit a.ts"]);

    const complete = registry.render({ toolName: "edit", args }, { width: 60, depth: "none" });
    expect(complete.length).toBeGreaterThan(1);
    expect(complete.map(stripAnsi).join("\n")).toContain("const limit = 3;");
  });

  test("a todo call renders a bracketed plan instead of one truncated line", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const items = [
      { content: "add the plan cell", status: "completed" },
      { content: "update the docs", status: "in_progress" },
      { content: "run the full ci pass", status: "pending" },
    ];

    const lines = registry
      .render(
        {
          toolName: "todo",
          args: { items },
          result: {
            role: "toolResult",
            toolCallId: "p",
            toolName: "todo",
            content: [{ type: "text", text: "[x] add the plan cell" }],
            details: { items },
            isError: false,
            timestamp: 1,
          },
        },
        { width: 60, depth: "none" },
      )
      .map(stripAnsi);

    expect(lines).toEqual([
      "  ┌ plan · 1/3 done",
      "  │ ✓ add the plan cell",
      "  │ ▸ update the docs",
      "  └ ▹ run the full ci pass",
    ]);
  });

  test("an expanded plan is not also dumped as raw result text", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const items = [{ content: "update the docs", status: "in_progress" }];
    const lines = registry
      .render(
        {
          toolName: "todo",
          args: { items },
          expanded: true,
          result: {
            role: "toolResult",
            toolCallId: "p",
            toolName: "todo",
            content: [{ type: "text", text: "[~] update the docs" }],
            details: { items },
            isError: false,
            timestamp: 1,
          },
        },
        { width: 60, depth: "none" },
      )
      .map(stripAnsi);

    expect(lines).toEqual(["  ┌ plan · 0/1 done", "  └ ▸ update the docs"]);
  });

  test("a plan whose arguments are still streaming renders no partial list", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    // Half the list has arrived; showing it would report tasks never recorded.
    const args = { items: [{ content: "add the plan c", status: "in_progress" }] };

    const streaming = registry.render(
      { toolName: "todo", args, argsStreaming: true },
      { width: 60, depth: "none" },
    );
    expect(streaming.map(stripAnsi)).toEqual(["  │ plan"]);
  });

  test("a malformed plan degrades to its header rather than half a list", () => {
    const registry = new RendererRegistry();
    registry.registerAll(codingRenderers);
    const lines = registry.render(
      { toolName: "todo", args: { items: [{ content: "no status" }] } },
      { width: 60, depth: "none" },
    );
    expect(lines.map(stripAnsi)).toEqual(["  │ plan"]);
  });
});

describe("transcript spacing", () => {
  const ran = (app: App, id: string, command: string, output: string) => {
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: "bash",
      args: { command },
    });
    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: id,
      result: {
        role: "toolResult",
        toolCallId: id,
        toolName: "bash",
        content: [{ type: "text", text: output }],
        details: { exitCode: 0, durationMs: 5 },
        isError: false,
        timestamp: 1,
      },
    });
  };

  test("consecutive commands collapse into one chronological activity group", () => {
    const { app } = harness();
    app.handleEvent({ type: "agent_start" });
    ran(app, "c1", "bun test", "270 pass\n0 fail");
    ran(app, "c2", "pwd", "");
    ran(app, "c3", "whoami", "");

    const screen = app.renderScreen().map(stripAnsi);
    expect(screen).toContain("  › Ran 3 commands");
    expect(screen.some((line) => line.includes("270 pass"))).toBe(false);
  });

  test("speech after machinery always gets a break", () => {
    const { app } = harness();
    app.handleEvent({ type: "agent_start" });
    ran(app, "c1", "pwd", "");
    app.handleEvent({ type: "message_end", message: assistant("Done — that is the cwd.") });

    const screen = app.renderScreen().map(stripAnsi);
    const cell = screen.findIndex((line) => line.includes("ran pwd"));
    expect(screen[cell + 1]).toBe("");
    expect(screen[cell + 2]).toContain("Done — that is the cwd.");
  });
});

describe("activity disclosure", () => {
  const complete = (
    app: App,
    id: string,
    toolName: string,
    args: unknown,
    output: string,
    details: unknown = {},
    isError = false,
  ) => {
    app.handleEvent({ type: "tool_execution_start", toolCallId: id, toolName, args });
    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: id,
      result: {
        role: "toolResult",
        toolCallId: id,
        toolName,
        content: [{ type: "text", text: output }],
        details,
        isError,
        timestamp: 1,
      },
    });
  };

  test("groups exploration and expands a selected child with the keyboard", () => {
    const { app } = harness();
    app.handleEvent({
      type: "message_end",
      message: assistant("I’m checking the relevant files."),
    });
    complete(app, "r1", "read", { path: "a.ts" }, "a1\na2\na3\na4\na5\na6", { lines: 6 });
    complete(app, "r2", "read", { path: "b.ts" }, "b", { lines: 1 });
    complete(app, "s1", "bash", { command: "rg -n TODO packages" }, "packages/a.ts:4:TODO", {
      exitCode: 0,
    });

    expect(app.renderTranscript().map(stripAnsi)).toContain("  › Explored 2 files, 1 search");

    feed(app, "\u000f");
    expect(app.currentMode).toBe("activity");
    let review = app.renderScreen().map(stripAnsi);
    expect(review.some((line) => line.includes("checking the relevant files"))).toBe(true);
    expect(review.some((line) => line.includes("fake/fake-1"))).toBe(true);
    expect(review).not.toContain("  Activity");
    expect(app.renderScreen().join("\n")).not.toContain("\u001b[7m");
    expect(review.some((line) => line.includes("read a.ts"))).toBe(false);

    press(app, "right");
    review = app.renderScreen().map(stripAnsi);
    expect(review.some((line) => line.includes("read a.ts"))).toBe(true);
    expect(review.some((line) => line.includes("rg -n TODO packages"))).toBe(true);
    expect(review.some((line) => line.includes("│ a1"))).toBe(false);
    expect(review.some((line) => line.includes("packages/a.ts:4:TODO"))).toBe(false);

    press(app, "down");
    press(app, "return");
    review = app.renderScreen().map(stripAnsi);
    expect(review.some((line) => line.includes("│ a4"))).toBe(true);

    feed(app, "\u000f");
    expect(app.currentMode).toBe("composing");
    expect(
      app
        .renderTranscript()
        .map(stripAnsi)
        .some((line) => line.includes("│ a4")),
    ).toBe(true);

    feed(app, "/collapse\r");
    expect(app.areToolOutputsExpanded).toBe(false);
    expect(app.renderTranscript().map(stripAnsi)).not.toContain("  › read a.ts · 6 lines");
  });

  test("searches the transcript and temporarily reveals collapsed content", () => {
    const { app } = harness();
    app.handleEvent({
      type: "message_end",
      message: {
        ...assistant("The visible response has no match."),
        content: [
          { type: "thinking", thinking: "private quartz thought" },
          { type: "text", text: "The visible response has no match." },
        ],
      },
    });
    complete(app, "r1", "read", { path: "a.ts" }, "hidden quartz output", { lines: 1 });
    app.appendTranscript(["  local quartz notice"]);

    expect(app.renderTranscript().map(stripAnsi).join("\n")).not.toContain("hidden quartz output");
    feed(app, "\u000f/QUARTZ\r");

    let screen = app.renderScreen().map(stripAnsi);
    expect(screen.join("\n")).toContain("search transcript");
    expect(screen.join("\n")).toContain("1/3 · n/N next/previous");
    expect(screen.find((line) => line.startsWith("❯ "))).toContain("private quartz thought");

    feed(app, "n");
    screen = app.renderScreen().map(stripAnsi);
    expect(screen.find((line) => line.startsWith("❯ "))).toContain("hidden quartz output");

    feed(app, "N");
    screen = app.renderScreen().map(stripAnsi);
    expect(screen.find((line) => line.startsWith("❯ "))).toContain("private quartz thought");

    feed(app, "n");
    press(app, "escape");
    expect(app.currentMode).toBe("activity");
    expect(app.areToolOutputsExpanded).toBe(false);
    screen = app.renderScreen().map(stripAnsi);
    expect(screen.join("\n")).not.toContain("search transcript");
    expect(screen.find((line) => line.startsWith("❯ "))).toContain("hidden quartz output");
    press(app, "escape");
    expect(app.currentMode).toBe("composing");
    expect(app.renderTranscript().map(stripAnsi).join("\n")).not.toContain("hidden quartz output");
  });

  test("reports an empty transcript search without leaving activity navigation", () => {
    const { app } = harness();
    app.handleEvent({ type: "message_end", message: assistant("alpha") });

    feed(app, "\u000f/missing\r");

    expect(app.currentMode).toBe("activity");
    expect(app.renderBottom().map(stripAnsi).join("\n")).toContain("no matches");
  });

  test("edit groups show colored aggregate and per-file line totals", () => {
    const { app } = harness({}, { depth: "truecolor" });
    complete(app, "e1", "edit", { path: "a.ts", edits: [] }, "Edited a.ts (1 replacement)", {
      occurrences: 1,
      diff: {
        path: "a.ts",
        added: 3,
        removed: 1,
        hunks: ["@@ -1,1 +1,3 @@", "-old", "+new", "+extra", "+more"],
      },
    });
    complete(app, "e2", "write", { path: "b.ts", content: "x\ny" }, "Updated b.ts", {
      diff: { path: "b.ts", added: 1, removed: 2, hunks: [] },
    });

    const collapsed = app.renderTranscript().join("\n");
    expect(stripAnsi(collapsed)).toContain("Edited 2 files +4 -3");
    expect(collapsed).toContain("[32m+4");
    expect(collapsed).toContain("[31m-3");

    feed(app, "\u000f");
    press(app, "right");
    let expanded = app.renderScreen().map(stripAnsi).join("\n");
    expect(expanded).toContain("edited a.ts · 1 replacement +3 -1");
    expect(expanded).toContain("updated b.ts +1 -2");

    press(app, "down");
    press(app, "right");
    expanded = app.renderScreen().map(stripAnsi).join("\n");
    expect(expanded.match(/a\.ts/g)).toHaveLength(1);
    expect(expanded.match(/b\.ts/g)).toHaveLength(1);
    expect(expanded).not.toContain("Edited a.ts (1 replacement)");
    expect(expanded).toContain("│     1 − old");
  });

  test("expanded group children align with standalone activity", () => {
    const { app } = harness();
    complete(app, "c1", "bash", { command: "git status --short" }, "clean", { exitCode: 0 });
    complete(app, "c2", "bash", { command: "git log -1" }, "abc change", { exitCode: 0 });
    complete(app, "s1", "bash", { command: "rg -n TODO packages" }, "packages/a.ts:1:TODO", {
      exitCode: 0,
    });

    feed(app, "\u000f");
    press(app, "up");
    let rows = app.renderScreen().map(stripAnsi);
    let searchIndex = rows.findIndex((line) => line.includes("ran rg -n TODO packages"));
    expect(rows[searchIndex - 1]).toBe("");

    press(app, "return");
    rows = app.renderScreen().map(stripAnsi);
    const command = rows.find((line) => line.includes("ran git status --short"));
    searchIndex = rows.findIndex((line) => line.includes("ran rg -n TODO packages"));
    const search = rows[searchIndex];

    expect(command?.indexOf("ran")).toBe(4);
    expect(search?.indexOf("ran")).toBe(4);
    expect(rows[searchIndex - 1]).toBe("");
  });

  test("an explicit user shell command stays standalone and starts expanded", () => {
    const { app, commands } = harness();
    complete(app, "c1", "bash", { command: "git status --short" }, "clean", {
      exitCode: 0,
    });
    complete(app, "shell-1", "bash", { command: "pwd", userShell: true }, "/tmp", {
      exitCode: 0,
    });

    const expanded = app.renderScreen().map(stripAnsi).join("\n");
    expect(expanded).toContain("› ran git status --short");
    expect(expanded).toContain("⌄ $ pwd");
    expect(expanded).toContain("│ /tmp");
    expect(expanded).not.toContain("Ran 2 commands");

    feed(app, "/collapse\r");
    expect(commands).toEqual([]);
    const collapsed = app.renderScreen().map(stripAnsi).join("\n");
    expect(collapsed).toContain("› $ pwd");
    expect(collapsed).not.toContain("│ /tmp");
  });

  test("an explicit user shell result has a blank boundary on both sides", () => {
    const { app } = harness();
    app.appendTranscript(["  Keybindings"]);
    complete(app, "shell-1", "bash", { command: "ls", userShell: true }, "README.md", {
      exitCode: 0,
    });
    app.appendTranscript(["  worked for 5ms"]);

    const rows = app.renderScreen().map(stripAnsi);
    const shellIndex = rows.findIndex((line) => line.includes("$ ls"));
    const outputIndex = rows.findIndex((line) => line.includes("│ README.md"));
    expect(rows[shellIndex - 2]).toBe("  Keybindings");
    expect(rows[shellIndex - 1]).toBe("");
    expect(rows[outputIndex + 1]).toBe("");
    expect(rows[outputIndex + 2]).toBe("  worked for 5ms");
  });
});

describe("superseded plans", () => {
  const plan = (statuses: ("completed" | "in_progress" | "pending")[]) =>
    statuses.map((status, index) => ({ content: `task ${index + 1}`, status }));

  const record = (app: App, id: string, items: ReturnType<typeof plan>) => {
    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: "todo",
      args: { items },
    });
    app.handleEvent({
      type: "tool_execution_end",
      toolCallId: id,
      result: {
        role: "toolResult",
        toolCallId: id,
        toolName: "todo",
        content: [{ type: "text", text: "[~] task 1" }],
        details: { items },
        isError: false,
        timestamp: 1,
      },
    });
  };

  test("only the newest plan stays a full list; earlier ones become one row", () => {
    const { app } = harness();
    app.handleEvent({ type: "agent_start" });
    record(app, "p1", plan(["in_progress", "pending", "pending"]));
    record(app, "p2", plan(["completed", "in_progress", "pending"]));
    record(app, "p3", plan(["completed", "completed", "in_progress"]));

    const screen = app.renderScreen().map(stripAnsi);
    expect(screen).toContain("  › plan · 0/3 · task 1");
    expect(screen).toContain("  › plan · 1/3 · task 2");
    // The disclosure marker replaces the bracket's opening glyph; its task rail still closes.
    expect(screen).toContain("  › plan · 2/3 done");
    expect(screen).toContain("  │ ✓ task 1");
    expect(screen).toContain("  └ ▸ task 3");
    // Three plans of three tasks would be twelve rows unfolded.
    expect(screen.filter((line) => line.includes("task 1"))).toHaveLength(2);
  });

  test("a superseded plan that finished reports done rather than a live task", () => {
    const { app } = harness();
    app.handleEvent({ type: "agent_start" });
    record(app, "p1", plan(["completed", "completed"]));
    record(app, "p2", plan(["completed", "completed", "in_progress"]));

    expect(app.renderScreen().map(stripAnsi)).toContain("  › plan · 2/2 done");
  });

  test("ctrl+o restores a superseded plan to its full list", () => {
    const { app } = harness();
    app.handleEvent({ type: "agent_start" });
    record(app, "p1", plan(["in_progress", "pending"]));
    record(app, "p2", plan(["completed", "in_progress"]));

    expect(app.renderScreen().map(stripAnsi)).toContain("  › plan · 0/2 · task 1");
    feed(app, "\u000f");
    feed(app, "\u001b[A");
    press(app, "return");
    feed(app, "\u000f");
    const expanded = app.renderScreen().map(stripAnsi);
    expect(expanded.filter((line) => line.includes("⌄ plan · 0/2 done"))).toHaveLength(1);
    expect(expanded.filter((line) => line.includes("task 1"))).toHaveLength(2);
  });

  test("consecutive exploration tools collapse without losing their count", () => {
    const { app } = harness();
    app.handleEvent({ type: "agent_start" });
    for (const id of ["c1", "c2"]) {
      app.handleEvent({
        type: "tool_execution_end",
        toolCallId: id,
        result: {
          role: "toolResult",
          toolCallId: id,
          toolName: "read",
          content: [{ type: "text", text: "contents" }],
          details: { lines: 4 },
          isError: false,
          timestamp: 1,
        },
      });
    }
    const screen = app.renderScreen().map(stripAnsi);
    expect(screen).toContain("  › Explored 2 files");
  });
});

describe("tool output toggle", () => {
  test("ctrl+o navigates without toggling and /collapse closes every disclosure", () => {
    const { app, commands } = harness();
    app.handleEvent({ type: "agent_start" });
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
    const collapsed = app.renderScreen().map(stripAnsi).join("\n");
    expect(collapsed).not.toContain("│ line 1");
    expect(collapsed).not.toContain("lines omitted");

    feed(app, "\u000f");
    expect(app.currentMode).toBe("activity");
    expect(app.areToolOutputsExpanded).toBe(false);
    press(app, "right");
    expect(app.areToolOutputsExpanded).toBe(true);
    const expanded = app.renderScreen().map(stripAnsi).join("\n");
    expect(expanded).toContain("ran bun test");
    expect(expanded).toContain("│ line 6");

    feed(app, "\u000f");
    expect(app.currentMode).toBe("composing");
    expect(app.areToolOutputsExpanded).toBe(true);

    feed(app, "/collapse\r");
    expect(app.areToolOutputsExpanded).toBe(false);
    expect(commands).toEqual([]);
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
    press(app, "right");
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
    press(app, "right");
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
    press(app, "right");
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
  test("renderFrame stays physical, viewport-bounded, and compatible with renderScreen", () => {
    const app = new App({
      width: 40,
      height: 6,
      depth: "none",
      model: "fake/fake-1",
      callbacks: {
        onSubmit: () => {},
        onAbort: () => {},
        onExit: () => {},
      },
    });
    app.editor.insert("one two three four five six seven eight nine ten eleven twelve");

    const frame = app.renderFrame();
    expect(frame.managed.length).toBeLessThanOrEqual(5);
    expect(frame.managed.every((row) => !row.includes("\n") && stringWidth(row) <= 40)).toBe(true);
    expect(app.renderScreen()).toEqual([...frame.transcript, ...frame.managed]);
  });

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
    renderer.renderNow(physicalFrame(["a", "b"]));
    const after = written.length;
    renderer.renderNow(physicalFrame(["a", "b"]));
    expect(written.length).toBe(after);
  });

  test("a managed-only update does not scan a stable transcript", () => {
    const { written, renderer } = setup();
    let transcriptReads = 0;
    const rows = Array.from({ length: 9_000 }, (_, index) => `history ${index}`);
    const transcript = new Proxy(rows, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) transcriptReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    renderer.renderNow({ transcript, managed: ["composer a"], dirtyFrom: transcript.length });
    transcriptReads = 0;
    const after = written.length;

    renderer.renderNow({ transcript, managed: ["composer b"], dirtyFrom: transcript.length });

    expect(transcriptReads).toBe(0);
    expect(written.length).toBe(after + 1);
    expect(written.at(-1)).toContain("composer b");
  });

  test("an appended transcript replaces the old managed tail without duplication", () => {
    const screen = new VirtualScreen(8);
    const terminal = new Terminal({
      write: (data) => screen.write(data),
      columns: 80,
      rows: 8,
      isTty: true,
    });
    const renderer = new FullScreenRenderer(terminal, 0);
    renderer.renderNow({ transcript: ["history"], managed: ["draft"], dirtyFrom: 1 });
    renderer.renderNow({
      transcript: ["history", "committed"],
      managed: ["composer"],
      dirtyFrom: 2,
    });

    const rendered = [...screen.scrollback, ...screen.lines];
    expect(rendered.filter((row) => row === "history")).toHaveLength(1);
    expect(rendered.filter((row) => row === "committed")).toHaveLength(1);
    expect(rendered.filter((row) => row === "composer")).toHaveLength(1);
    expect(rendered).not.toContain("draft");
  });

  test("a changed frame repaints", async () => {
    const { written, renderer } = setup();
    renderer.renderNow(physicalFrame(["a"]));
    const after = written.length;
    renderer.renderNow(physicalFrame(["b"]));
    expect(written.length).toBeGreaterThan(after);
  });

  test("embedded newlines are counted as physical screen rows", () => {
    const { written, renderer } = setup();
    renderer.renderNow(physicalFrame(["first\nsecond", "third"]));
    expect(renderer.lineCount).toBe(3);

    renderer.renderNow(physicalFrame(["replacement"]));
    expect(written.at(-1)).toContain(`${ESC}[2J${ESC}[H${ESC}[3J`);
  });

  test("a terminal resize forces a complete replay", () => {
    const written: string[] = [];
    const io: TerminalIo = {
      write: (data) => written.push(data),
      columns: 80,
      rows: 24,
      isTty: true,
    };
    const renderer = new FullScreenRenderer(new Terminal(io), 0);
    const frame = physicalFrame(["history", "composer"]);
    renderer.renderNow(frame);
    io.columns = 40;

    renderer.renderNow(frame);

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
    renderer.renderNow(
      physicalFrame(["user", "tool compact", "final response", "rule", "composer"]),
    );

    const expanded = [
      "user",
      "tool",
      ...Array.from({ length: 6 }, (_, index) => `output ${index + 1}`),
      "final response",
      "rule",
      "composer",
    ];
    renderer.renderNow(physicalFrame(expanded));
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

    renderer.renderNow(app.renderFrame());
    for (let index = 0; index < 3; index++) {
      feed(app, "\u000f");
      press(app, "right");
      renderer.renderNow(app.renderFrame());
      feed(app, "\u000f");
      renderer.renderNow(app.renderFrame());
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
    renderer.render(physicalFrame(["1"]));
    renderer.render(physicalFrame(["2"]));
    renderer.render(physicalFrame(["3"]));
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
      return physicalFrame(["discarded"]);
    });
    renderer.requestRender(() => {
      produced++;
      return physicalFrame(["latest"]);
    });

    expect(produced).toBe(0);
    await Bun.sleep(25);
    expect(produced).toBe(1);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("latest");
    expect(written[0]).not.toContain("discarded");
  });

  test("an immediate input frame cancels a pending throttled frame", async () => {
    const written: string[] = [];
    const terminal = new Terminal({
      write: (data) => written.push(data),
      columns: 80,
      rows: 24,
      isTty: true,
    });
    const renderer = new FullScreenRenderer(terminal, 10);
    renderer.requestRender(() => physicalFrame(["stale stream"]));
    renderer.renderNow(physicalFrame(["typed input"]));

    expect(written).toHaveLength(1);
    expect(written[0]).toContain("typed input");
    await Bun.sleep(25);
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain("stale stream");
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
        onSubmit: (text) => void submitted.push(text),
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

  test("an open picker can refresh without losing its filter or selection", () => {
    const h = harness();
    const chosen: string[] = [];
    const picker = {
      title: "select a model · refreshing",
      filterable: true,
      items: [{ label: "openai/gpt-5.1" }, { label: "openai/gpt-5.2" }],
      onChoose: (value: string) => chosen.push(value),
    };
    h.app.openPicker(picker);
    feed(h.app, "openai");
    press(h.app, "down");

    expect(
      h.app.updatePicker(picker, {
        title: "select a model · 3 available",
        items: [
          { label: "openai/gpt-5.1" },
          { label: "openai/gpt-5.2" },
          { label: "openai/gpt-5.3" },
        ],
      }),
    ).toBe(true);

    const rendered = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("select a model · 3 available · openai");
    press(h.app, "return");
    expect(chosen).toEqual(["openai/gpt-5.2"]);
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
    expect(final).toEqual([]);
    expect(screen.filter((line) => line.startsWith("  mu  "))).toHaveLength(1);
  });

  test("completed Markdown layout is deferred until a frame is requested", () => {
    const { app } = harness();
    const text = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join("\n");

    const committed = app.handleEvent({ type: "message_end", message: assistant(text) });

    expect(committed).toEqual([]);
    const rendered = app.renderFrame().transcript.map(stripAnsi).join("\n");
    expect(rendered).toContain("line 0");
    expect(rendered).toContain("line 1999");
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
    expect(live.join("\n")).toContain("rows above hidden");
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

  test("a streaming tool call names its target but withholds the diff until arguments complete", () => {
    const { app } = harness();
    const streamed = (content: string, done: boolean): AgentEvent => ({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "write-1",
            name: "write",
            arguments: { path: "demo.py", content },
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
      delta: done
        ? { kind: "toolcall_end", contentIndex: 0, toolCallId: "write-1" }
        : { kind: "toolcall_delta", contentIndex: 0, argsFragment: "world" },
    });

    app.handleEvent(streamed("print('hello')\nprint('wor", false));
    const partial = app.renderBottom().map(stripAnsi).join("\n");
    // The user learns which file is coming without watching a half-written one.
    expect(partial).toContain("write demo.py");
    expect(partial).not.toContain("+ print('hello')");

    app.handleEvent(streamed("print('hello')\nprint('world')", true));
    const complete = app.renderBottom().map(stripAnsi).join("\n");
    expect(complete).toContain("+ print('hello')");
    expect(complete).toContain("+ print('world')");

    app.handleEvent({
      type: "tool_execution_start",
      toolCallId: "write-1",
      toolName: "write",
      args: { path: "demo.py", content: "print('hello')\nprint('world')" },
    });
    const running = app.renderBottom().map(stripAnsi).join("\n");
    expect(running.match(/write demo\.py/g)?.length).toBe(1);
    expect(running).toContain("+ print('world')");
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

  test("tab completes the highlighted command into the composer instead of running it", () => {
    const commands: string[] = [];
    const h = harness({ onCommand: (text) => commands.push(text) });
    h.app.setCommands([{ label: "model" }, { label: "compact" }]);
    feed(h.app, "/m");
    h.app.handleInput({ type: "key", key: { name: "tab", ctrl: false, alt: false, shift: false } });

    expect(commands).toEqual([]);
    const rendered = h.app.renderBottom().map(stripAnsi).join("\n");
    expect(rendered).toContain("/model ");
    // The popup is gone — its filter is a prefix match the trailing space empties.
    expect(rendered).not.toContain("compact");

    // Arguments typed after the completion reach the command intact.
    feed(h.app, "anthropic");
    h.app.handleInput({
      type: "key",
      key: { name: "return", ctrl: false, alt: false, shift: false },
    });
    expect(commands).toEqual(["/model anthropic"]);
  });

  test("tab on an empty command list leaves the popup alone", () => {
    const h = harness();
    h.app.setCommands([{ label: "model" }]);
    feed(h.app, "/zz");
    h.app.handleInput({ type: "key", key: { name: "tab", ctrl: false, alt: false, shift: false } });
    expect(h.app.renderBottom().map(stripAnsi).join("\n")).toContain("/zz");
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

describe("permission mode cycling", () => {
  test("shift+tab signals a cycle regardless of decoding path", () => {
    let calls = 0;
    const h = harness({ onCyclePermissionMode: () => calls++ });

    h.app.handleInput({
      type: "key",
      key: { name: "tab", ctrl: false, alt: false, shift: true },
    });
    expect(calls).toBe(1);

    // CSI Z (back-tab) — the universal, protocol-independent encoding.
    feed(h.app, `${ESC}[Z`);
    expect(calls).toBe(2);
  });

  test("plain tab does not trigger the cycle", () => {
    let calls = 0;
    const h = harness({ onCyclePermissionMode: () => calls++ });
    feed(h.app, "\t");
    expect(calls).toBe(0);
  });

  test("shift+tab works from any mode, like ctrl+t", () => {
    let calls = 0;
    const h = harness({ onCyclePermissionMode: () => calls++ });
    h.app.openCommandMenu();
    feed(h.app, `${ESC}[Z`);
    expect(calls).toBe(1);
  });
});

describe("startup banner", () => {
  test("identifies mu and lists the key affordances", () => {
    const h = harness({}, { depth: "truecolor", version: "1.2.3" });
    h.app.setModel("openai/gpt-5.1");
    const styledBanner = h.app.banner().join("\n");
    const banner = stripAnsi(styledBanner);

    expect(banner).toContain("mu");
    expect(banner).toContain("mu v1.2.3  a general-purpose, extensible agent");
    expect(styledBanner).toContain(styleText("v1.2.3", { dim: true }, "truecolor"));
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
        onSubmit: (text) => void submitted.push(text),
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
describe("side conversations", () => {
  test("retain independent transcripts while ctrl+b switches views", () => {
    const { app } = harness();
    app.handleEvent({ type: "message_end", message: assistant("main answer") }, "main");
    app.openSideConversation("fake/fake-1", 100_000, ["off", "high"]);
    app.handleEvent({ type: "message_end", message: assistant("side answer") }, "side");

    expect(app.activeConversation).toBe("side");
    expect(stripAnsi(app.renderTranscript().join("\n"))).toContain("side answer");
    expect(stripAnsi(app.renderTranscript().join("\n"))).not.toContain("main answer");

    feed(app, "\u0002");
    expect(app.activeConversation).toBe("main");
    expect(stripAnsi(app.renderTranscript().join("\n"))).toContain("main answer");
    expect(stripAnsi(app.renderTranscript("side").join("\n"))).toContain("side answer");
  });

  test("main and side keep independent composer histories", () => {
    const { app } = harness();
    feed(app, "main question\r");
    app.openSideConversation("fake/fake-1", 100_000, ["off"]);
    feed(app, "side question\r");

    feed(app, "\u0002");
    app.handleInput({
      type: "key",
      key: { name: "up", ctrl: false, alt: false, shift: false },
    });
    expect(app.editor.text).toBe("main question");

    app.editor.setText("");
    feed(app, "\u0002");
    app.handleInput({
      type: "key",
      key: { name: "up", ctrl: false, alt: false, shift: false },
    });
    expect(app.editor.text).toBe("side question");
  });

  test("escape closes an idle side conversation and approvals retain their source", () => {
    let closed = 0;
    const replies: string[] = [];
    const { app } = harness({
      onCloseSide: () => closed++,
      onPermissionReply: (_id, _outcome, _remember, source) => replies.push(source),
    });
    app.openSideConversation("fake/fake-1", 100_000, ["off"]);
    app.handleEvent(
      {
        type: "permission_asked",
        request: {
          id: "side-permission",
          toolCallId: "call",
          toolName: "bash",
          permission: "bash",
          pattern: "pwd",
          description: "run pwd",
        },
      },
      "side",
    );
    app.handleInput({
      type: "key",
      key: { name: "return", ctrl: false, alt: false, shift: false },
    });
    expect(replies).toEqual(["side"]);
    app.handleEvent(
      { type: "permission_resolved", requestId: "side-permission", outcome: "allow" },
      "side",
    );

    app.handleInput({
      type: "key",
      key: { name: "escape", ctrl: false, alt: false, shift: false },
    });
    expect(closed).toBe(1);
  });
});
