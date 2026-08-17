import { describe, expect, test } from "bun:test";
import { App, CTRL_C_EXIT_WINDOW_MS, stripAnsi } from "@mu/tui";
import { createManagedSessionRecord, reduceManagedSession } from "./agent-view-state.ts";
import { AgentsApp, rendererRegistryForManagedProfile } from "./agents-app.ts";

const key = (name: string, text?: string) => ({
  type: "key" as const,
  key: { name, ...(text !== undefined ? { text } : {}), ctrl: false, alt: false, shift: false },
});

function callbacks() {
  const calls: string[] = [];
  return {
    calls,
    value: {
      dispatch: (prompt: string, model: string | undefined) =>
        calls.push(`dispatch:${prompt}${model ? `:${model}` : ""}`),
      attach: (id: string) => calls.push(`attach:${id}`),
      reply: (id: string, text: string) => calls.push(`reply:${id}:${text}`),
      permission: (id: string, requestId: string, outcome: string) =>
        calls.push(`permission:${id}:${requestId}:${outcome}`),
      stop: (id: string) => calls.push(`stop:${id}`),
      remove: (id: string) => calls.push(`remove:${id}`),
      exit: () => calls.push("exit"),
    },
  };
}

describe("AgentsApp", () => {
  test("loads and disposes custom profile renderers for managed attachments", async () => {
    const calls: string[] = [];
    const record = createManagedSessionRecord({
      sessionId: "custom-renderer",
      scope: "scope",
      prompt: "test custom rendering",
      cwd: "/work",
      profile: "custom-profile",
    });
    const presentation = await rendererRegistryForManagedProfile(record, async (name, options) => {
      calls.push(`${name}:${String(options?.presentationOnly)}:${String(options?.root)}`);
      return {
        name: "custom-profile",
        toolset: [],
        promptFor: () => [],
        permissionDefaults: [],
        renderers: {
          custom_tool: {
            render: ({ args }) => [`rendered:${String((args as { value: number }).value)}`],
          },
        },
        runtime: { attach: () => {}, shutdown: () => void calls.push("shutdown") },
      };
    });

    expect(
      presentation.registry.render(
        { toolName: "custom_tool", args: { value: 42 } },
        { width: 80, depth: "none" },
      ),
    ).toEqual(["rendered:42"]);
    await presentation.dispose();
    expect(calls).toEqual(["custom-profile:true:/work", "shutdown"]);
  });

  test("renders every public state and an honest same-workspace warning", () => {
    const cb = callbacks();
    const app = new AgentsApp(100, 30, "none", cb.value);
    const states = [
      "starting",
      "working",
      "needs_input",
      "completed",
      "failed",
      "stopped",
    ] as const;
    app.setRecords(
      states.map((state, index) => ({
        ...createManagedSessionRecord({
          sessionId: `s${index}`,
          scope: "scope",
          prompt: `${state} task`,
          cwd: "/work",
          profile: "coding",
          now: index,
        }),
        state,
      })),
    );
    const output = stripAnsi(app.render().join("\n"));
    for (const state of states) expect(output).toContain(state.replace("_", " "));
    expect(output).toContain("live sessions can edit concurrently");
  });

  test("a completed row keeps its completion age when attachment updates the record", () => {
    const cb = callbacks();
    const created = createManagedSessionRecord({
      sessionId: "completed",
      scope: "scope",
      prompt: "finished task",
      cwd: "/work",
      profile: "coding",
      now: 1_000,
    });
    const completed = reduceManagedSession(
      created,
      { type: "agent_event", event: { type: "agent_end", messages: [], reason: "done" } },
      5_000,
    );
    const attached = reduceManagedSession(completed, { type: "attached", attached: true }, 12_000);
    const app = new AgentsApp(100, 30, "none", cb.value, () => 15_000);

    app.setRecords([attached]);

    const output = stripAnsi(app.render().join("\n"));
    expect(attached).toMatchObject({ completedAt: 5_000, updatedAt: 12_000 });
    expect(output).toContain("completed · 10s ago");
    expect(output).not.toContain("completed · 3s");
  });

  test("interleaved streaming updates do not reorder active sessions or move selection", () => {
    const cb = callbacks();
    const app = new AgentsApp(100, 30, "none", cb.value, () => 50_000);
    const active = (sessionId: string, createdAt: number, updatedAt: number) => ({
      ...createManagedSessionRecord({
        sessionId,
        scope: "scope",
        prompt: sessionId,
        cwd: "/work",
        profile: "coding",
        now: createdAt,
      }),
      state: "working" as const,
      updatedAt,
    });

    app.setRecords([
      active("oldest", 1_000, 10_000),
      active("middle", 2_000, 11_000),
      active("newest", 3_000, 12_000),
    ]);
    app.handleInput(key("down"));
    expect(app.selectedRecord?.sessionId).toBe("middle");

    app.setRecords([
      active("oldest", 1_000, 30_000),
      active("middle", 2_000, 20_000),
      active("newest", 3_000, 15_000),
    ]);

    expect(app.selectedRecord?.sessionId).toBe("middle");
    const output = stripAnsi(app.render().join("\n"));
    expect(output.indexOf("newest working")).toBeLessThan(output.indexOf("middle working"));
    expect(output.indexOf("middle working")).toBeLessThan(output.indexOf("oldest working"));
  });

  test("a tall roster scrolls its window to keep keyboard selection visible", () => {
    const cb = callbacks();
    const app = new AgentsApp(100, 18, "none", cb.value, () => 50_000);
    app.setRecords(
      Array.from({ length: 20 }, (_, index) => ({
        ...createManagedSessionRecord({
          sessionId: `session-${index}`,
          scope: "scope",
          prompt: `task-${index}`,
          cwd: "/work",
          profile: "coding",
          now: index + 1,
        }),
        state: "completed" as const,
        completedAt: index + 1,
      })),
    );

    let output = stripAnsi(app.render().join("\n"));
    expect(output).toContain("task-19 completed");
    expect(output).toContain("sessions below");
    for (let index = 0; index < 19; index++) app.handleInput(key("down"));

    output = stripAnsi(app.render().join("\n"));
    expect(app.selectedRecord?.sessionId).toBe("session-0");
    expect(output).toContain("task-0 completed");
    expect(output).toContain("sessions above");
    expect(output.split("\n").length).toBeLessThanOrEqual(18);

    for (let index = 0; index < 19; index++) app.handleInput(key("up"));
    output = stripAnsi(app.render().join("\n"));
    expect(app.selectedRecord?.sessionId).toBe("session-19");
    expect(output).toContain("task-19 completed");
  });

  test("dispatch, attach, peek permission, follow-up, stop, and safe remove are distinct", () => {
    const cb = callbacks();
    const app = new AgentsApp(100, 30, "none", cb.value);
    const waiting = reduceManagedSession(
      createManagedSessionRecord({
        sessionId: "s1",
        scope: "scope",
        prompt: "test task",
        cwd: "/work",
        profile: "coding",
      }),
      {
        type: "agent_event",
        event: {
          type: "permission_asked",
          request: {
            id: "p1",
            toolCallId: "t1",
            toolName: "bash",
            permission: "bash",
            pattern: "bun test",
            description: "Run tests",
          },
        },
      },
    );
    app.setRecords([waiting]);
    app.handleInput(key("space", " "));
    app.handleInput(key("y", "y"));
    app.handleInput(key("space", " "));
    app.handleInput(key("f", "f"));
    app.handleInput(key("o", "o"));
    app.handleInput(key("k", "k"));
    app.handleInput(key("return"));
    app.handleInput(key("x", "x"));
    app.handleInput(key("delete"));
    app.handleInput(key("delete"));
    expect(cb.calls).toEqual(["permission:s1:p1:allow", "reply:s1:ok", "stop:s1", "remove:s1"]);
  });

  test("text at the bottom dispatches a new ordinary session", () => {
    const cb = callbacks();
    const app = new AgentsApp(80, 24, "none", cb.value);
    for (const char of "new task") app.handleInput(key(char, char));
    app.handleInput(key("return"));
    expect(cb.calls).toEqual(["dispatch:new task"]);
  });

  test("dashboard /model selects the model for future dispatches without creating a session", () => {
    const cb = callbacks();
    const app = new AgentsApp(100, 30, "none", cb.value);
    app.setDispatchModels(
      [
        { label: "openai-codex/gpt-5.6-sol", description: "ChatGPT account" },
        { label: "anthropic/claude-opus-5", description: "API key" },
      ],
      "openai-codex/gpt-5.6-sol",
    );
    app.editor.setText("/model");

    app.handleInput(key("return"));

    expect(cb.calls).toEqual([]);
    expect(stripAnsi(app.render().join("\n"))).toContain("select model for new sessions");
    app.handleInput(key("down"));
    app.handleInput(key("return"));

    expect(cb.calls).toEqual([]);
    const output = stripAnsi(app.render().join("\n"));
    expect(output).toContain("new sessions · anthropic/claude-opus-5");
    expect(output).toContain("new sessions will use anthropic/claude-opus-5");
    app.editor.setText("new task");
    app.handleInput(key("return"));
    expect(cb.calls).toEqual(["dispatch:new task:anthropic/claude-opus-5"]);
  });

  test("ctrl+c clears input and requires a second empty press to exit", () => {
    const cb = callbacks();
    let now = 10_000;
    const app = new AgentsApp(100, 30, "none", cb.value, () => now);
    app.handleInput(key("q", "q"));

    app.handleInput({
      type: "key",
      key: { name: "c", ctrl: true, alt: false, shift: false },
    });
    expect(app.editor.isEmpty).toBe(true);
    expect(cb.calls).toEqual([]);

    app.handleInput({
      type: "key",
      key: { name: "c", ctrl: true, alt: false, shift: false },
    });
    expect(stripAnsi(app.render().join("\n"))).toContain("press ctrl+c again to exit");
    expect(cb.calls).toEqual([]);

    now += 1_000;
    app.handleInput({
      type: "key",
      key: { name: "c", ctrl: true, alt: false, shift: false },
    });
    expect(cb.calls).toEqual(["exit"]);
  });

  test("an expired or interrupted ctrl+c confirmation re-arms instead of exiting", () => {
    const cb = callbacks();
    let now = 10_000;
    const app = new AgentsApp(100, 30, "none", cb.value, () => now);
    const ctrlC = () =>
      app.handleInput({
        type: "key",
        key: { name: "c", ctrl: true, alt: false, shift: false },
      });

    ctrlC();
    now += CTRL_C_EXIT_WINDOW_MS + 1;
    ctrlC();
    expect(cb.calls).toEqual([]);

    app.handleInput(key("a", "a"));
    ctrlC();
    ctrlC();
    expect(cb.calls).toEqual([]);
  });

  test("narrow layouts and multiline Unicode paste remain usable", () => {
    const cb = callbacks();
    const app = new AgentsApp(24, 10, "ansi256", cb.value);
    app.setRecords([
      createManagedSessionRecord({
        sessionId: "unicode",
        scope: "scope",
        prompt: "修复 parser 🙂 with a deliberately long description",
        cwd: "/work",
        profile: "coding",
      }),
    ]);
    expect(() => app.render()).not.toThrow();
    app.setSize(12, 8);
    expect(() => app.render()).not.toThrow();
    app.handleInput({ type: "paste", text: "first line\n第二行 🙂" });
    app.handleInput(key("return"));
    expect(cb.calls).toContain("dispatch:first line\n第二行 🙂");
  });
});

describe("conversation detach scoping", () => {
  const options = (onDetach?: () => void) => ({
    width: 80,
    depth: "none" as const,
    model: "test/model",
    callbacks: {
      onSubmit: () => {},
      onAbort: () => {},
      onExit: () => {},
      ...(onDetach ? { onDetach } : {}),
    },
  });

  test("plain conversation left arrow remains editor navigation", () => {
    const app = new App(options());
    app.editor.setText("ab");
    app.handleInput(key("left"));
    app.handleInput(key("x", "x"));
    expect(app.editor.text).toBe("axb");
  });

  test("only an attached empty conversation detaches on left arrow", () => {
    let detached = 0;
    const app = new App(options(() => detached++));
    app.handleInput(key("left"));
    expect(detached).toBe(1);
  });
});
