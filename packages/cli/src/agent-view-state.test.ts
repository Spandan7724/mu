import { describe, expect, test } from "bun:test";
import { createManagedSessionRecord, reduceManagedSession } from "./agent-view-state.ts";

function record() {
  return createManagedSessionRecord({
    sessionId: "s1",
    scope: "project",
    prompt: "Investigate the failing integration tests and repair the parser",
    cwd: "/work/project",
    profile: "coding",
    now: 10,
  });
}

describe("agent-view state reducer", () => {
  test("derives the visible lifecycle only from runtime and Agent events", () => {
    const ready = reduceManagedSession(record(), { type: "runtime_ready", pid: 42 }, 20);
    expect(ready).toMatchObject({ state: "working", ownerPid: 42 });

    const waiting = reduceManagedSession(
      ready,
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
            description: "Run bun test",
          },
        },
      },
      30,
    );
    expect(waiting).toMatchObject({ state: "needs_input", summary: "Run bun test" });

    const resumed = reduceManagedSession(
      waiting,
      {
        type: "agent_event",
        event: { type: "permission_resolved", requestId: "p1", outcome: "allow" },
      },
      40,
    );
    expect(resumed.state).toBe("working");
    expect(resumed.pendingRequest).toBeUndefined();

    const completed = reduceManagedSession(
      resumed,
      { type: "agent_event", event: { type: "agent_end", messages: [], reason: "done" } },
      50,
    );
    expect(completed).toMatchObject({ state: "completed", completedAt: 50 });
  });

  test("stop and worker failure remain distinct", () => {
    const stopped = reduceManagedSession(record(), { type: "stopped" }, 20);
    expect(stopped).toMatchObject({
      state: "stopped",
      summary: "runtime stopped · session preserved",
    });
    const failed = reduceManagedSession(
      record(),
      { type: "worker_failed", message: "worker crashed" },
      20,
    );
    expect(failed).toMatchObject({ state: "failed", lastError: "worker crashed" });
  });

  test("prompt-derived names and summaries are bounded deterministically", () => {
    const long = createManagedSessionRecord({
      sessionId: "s2",
      scope: "project",
      prompt: `  ${"word ".repeat(200)}  `,
      cwd: "/work/project",
      profile: "coding",
      now: 10,
    });
    expect(long.name.length).toBeLessThanOrEqual(80);
    expect(long.summary.length).toBeLessThanOrEqual(240);
    expect(long.name.endsWith("…")).toBe(true);
  });
});
