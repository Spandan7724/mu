import { describe, expect, test } from "bun:test";
import { App, stripAnsi } from "@mu/tui";
import { createManagedSessionRecord, reduceManagedSession } from "./agent-view-state.ts";
import { AgentsApp } from "./agents-app.ts";

const key = (name: string, text?: string) => ({
  type: "key" as const,
  key: { name, ...(text !== undefined ? { text } : {}), ctrl: false, alt: false, shift: false },
});

function callbacks() {
  const calls: string[] = [];
  return {
    calls,
    value: {
      dispatch: (prompt: string) => calls.push(`dispatch:${prompt}`),
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
