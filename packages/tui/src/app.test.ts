// Integration: a scripted fake-agent event stream drives the whole UI with
// zero network, exactly as the milestone requires.
import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@mu/core";
import { App, type AppCallbacks } from "./app.ts";
import { InputDecoder } from "./input.ts";
import { codingRenderers, genericRenderer, RendererRegistry } from "./registry.ts";
import { InlineRenderer } from "./renderer.ts";
import { stripAnsi } from "./style.ts";
import { Terminal, type TerminalIo } from "./terminal.ts";
import { stringWidth } from "./width.ts";

const ESC = "\u001b";

function harness(overrides: Partial<AppCallbacks> = {}) {
  const submitted: string[] = [];
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
    registry,
    callbacks: {
      onSubmit: (text) => submitted.push(text),
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
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.14,
        },
        contextTokens: 120,
        contextPercent: 0.12,
      },
      { type: "agent_end", messages: [], reason: "done" },
    ];

    const transcript: string[] = [];
    for (const event of script) transcript.push(...app.handleEvent(event));
    const visible = transcript.map(stripAnsi);

    expect(visible).toContain("  ▸ add retries");
    expect(visible).toContain("  │ read · src/api/client.ts · 142 lines");
    expect(visible.some((line) => line.startsWith("  mu  Done"))).toBe(true);

    const footerLine = stripAnsi(app.renderBottom().at(-1) ?? "");
    expect(footerLine).toContain("12% ctx");
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
    expect(stripAnsi(app.renderBottom().at(-1) ?? "")).toContain("esc to interrupt");
    app.handleEvent({ type: "agent_end", messages: [], reason: "done" });
    expect(stripAnsi(app.renderBottom().at(-1) ?? "")).not.toContain("esc to interrupt");
  });

  test("compaction is shown as a visible boundary", () => {
    const { app } = harness();
    const lines = app.handleEvent({ type: "compaction_end", layer: 2, tokensFreed: 5000 });
    expect(stripAnsi(lines[0] ?? "")).toContain("compacted");
  });

  test("background task count reaches the footer", () => {
    const { app } = harness();
    app.handleEvent({ type: "task_started", taskId: "t1", command: "bun dev", background: true });
    expect(stripAnsi(app.renderBottom().at(-1) ?? "")).toContain("1 bg");
    app.handleEvent({ type: "task_exited", taskId: "t1", exitCode: 0 });
    expect(stripAnsi(app.renderBottom().at(-1) ?? "")).not.toContain("1 bg");
  });
});

describe("input handling", () => {
  test("typing and submitting", () => {
    const h = harness();
    feed(h.app, "hello\r");
    expect(h.submitted).toEqual(["hello"]);
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
});

describe("approval overlay", () => {
  const ask: AgentEvent = {
    type: "permission_asked",
    request: {
      id: "p1",
      toolCallId: "c1",
      toolName: "bash",
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
});

describe("resize", () => {
  test("the bottom region re-wraps to the new width", () => {
    const h = harness();
    h.app.editor.insert("x".repeat(120));

    h.app.setWidth(40);
    for (const line of h.app.renderBottom()) expect(stringWidth(line)).toBeLessThanOrEqual(40);

    h.app.setWidth(100);
    for (const line of h.app.renderBottom()) expect(stringWidth(line)).toBeLessThanOrEqual(100);
  });
});

describe("terminal safety", () => {
  function fakeIo(): { io: TerminalIo; written: string[] } {
    const written: string[] = [];
    let raw = false;
    return {
      written,
      io: {
        write: (data) => written.push(data),
        columns: 80,
        rows: 24,
        isTty: true,
        setRawMode: (value) => {
          raw = value;
          written.push(`raw:${value}`);
        },
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

  test("frames are wrapped in synchronized-output markers", () => {
    const { io, written } = fakeIo();
    const terminal = new Terminal(io);
    terminal.frame("hello");
    expect(written[0]).toBe("\u001b[?2026hhello\u001b[?2026l");
  });
});

describe("inline renderer", () => {
  function setup() {
    const written: string[] = [];
    const terminal = new Terminal({
      write: (data) => written.push(data),
      columns: 80,
      rows: 24,
      isTty: true,
    });
    return { written, renderer: new InlineRenderer(terminal, 0) };
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

  test("committed lines are written above the managed region", () => {
    const { written, renderer } = setup();
    renderer.renderNow(["bottom"]);
    renderer.commit(["history line"]);
    expect(written.join("")).toContain("history line");
  });

  test("throttled renders coalesce into one paint", async () => {
    const written: string[] = [];
    const terminal = new Terminal({
      write: (data) => written.push(data),
      columns: 80,
      rows: 24,
      isTty: true,
    });
    const renderer = new InlineRenderer(terminal, 10);
    renderer.render(["1"]);
    renderer.render(["2"]);
    renderer.render(["3"]);
    expect(written.length).toBe(0);
    await Bun.sleep(25);
    expect(written.length).toBe(1);
    expect(written[0]).toContain("3");
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
});
