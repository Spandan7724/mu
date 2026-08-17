import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSupervisor, dispatchEnvironment } from "./agent-supervisor.ts";
import { AgentViewClient } from "./agent-view-client.ts";
import { createManagedSessionRecord } from "./agent-view-state.ts";
import {
  AgentViewRosterStore,
  acquireSessionOwnership,
  agentViewPaths,
  isProcessAlive,
  readSessionOwnership,
  updateSessionOwnershipWorker,
} from "./agent-view-store.ts";

const roots: string[] = [];
const fixture = join(import.meta.dir, "../testing/agent-worker-fixture.ts");
const closeFixture = join(import.meta.dir, "../testing/agent-supervisor-close-fixture.ts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeout = 2_000) => {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for supervisor state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("agent supervisor", () => {
  test("forwards canonical and namespaced profile environment only", () => {
    expect(
      dispatchEnvironment({
        HOME: "/private",
        PATH: "/bin",
        MU_PROFILE_CUSTOM_TOKEN: "profile-value",
        UNRELATED: "drop-me",
      }),
    ).toEqual({ PATH: "/bin", MU_PROFILE_CUSTOM_TOKEN: "profile-value" });
  });

  test("hosts independent workers after a viewer disconnect and supports attach/remove semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const supervisor = new AgentSupervisor({
      paths,
      forceStopMs: 500,
      command: (args) => [process.execPath, fixture, ...args],
    });
    await supervisor.start();
    const first = new AgentViewClient({ paths, scope: "project", cwd: root });
    try {
      await first.connect(false);
      await first.dispatch({ prompt: "slow one", cwd: root, profile: "coding" });
      await first.dispatch({ prompt: "fast two", cwd: root, profile: "coding" });
      expect(first.records).toHaveLength(2);
      first.close();

      const second = new AgentViewClient({ paths, scope: "project", cwd: root });
      await second.connect(false);
      expect(second.records).toHaveLength(2);
      await waitFor(
        () =>
          second.records.length === 2 &&
          second.records.every((record) => record.state === "completed"),
      );
      const target = second.records[0];
      expect(target).toBeDefined();
      const attachment = await second.attach(target?.sessionId ?? "");
      expect(attachment.messages.length).toBeGreaterThan(0);
      expect(attachment.commands?.[0]?.label).toBe("cost");
      await second.detach(target?.sessionId ?? "");
      await second.stop(target?.sessionId ?? "");
      await waitFor(
        () =>
          second.records.find((record) => record.sessionId === target?.sessionId)?.state ===
          "stopped",
      );
      await second.remove(target?.sessionId ?? "");
      await waitFor(() => second.records.length === 1);
      second.close();
    } finally {
      await supervisor.close();
    }
  });

  test("one session can wait for permission while another completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const supervisor = new AgentSupervisor({
      paths,
      command: (args) => [process.execPath, fixture, ...args],
    });
    await supervisor.start();
    const client = new AgentViewClient({ paths, scope: "project", cwd: root });
    try {
      await client.connect(false);
      await client.dispatch({ prompt: "needs permission", cwd: root, profile: "coding" });
      await client.dispatch({ prompt: "independent", cwd: root, profile: "coding" });
      await waitFor(
        () =>
          client.records.some((record) => record.state === "needs_input") &&
          client.records.some((record) => record.state === "completed"),
      );
      const waiting = client.records.find((record) => record.state === "needs_input");
      expect(waiting?.pendingRequest?.description).toBe("Run bun test");
      await client.sessionOp(waiting?.sessionId ?? "", {
        type: "permission_reply",
        requestId: waiting?.pendingRequest?.id ?? "",
        outcome: "allow",
        remember: true,
      });
      await waitFor(() => client.records.every((record) => record.state === "completed"));
    } finally {
      client.close();
      await supervisor.close();
    }
  });

  test("a second supervisor cannot reconcile or rewrite a live supervisor's roster", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const first = new AgentSupervisor({
      paths,
      forceStopMs: 500,
      command: (args) => [process.execPath, fixture, ...args],
    });
    await first.start();
    const client = new AgentViewClient({ paths, scope: "project", cwd: root });
    try {
      await client.connect(false);
      await client.dispatch({ prompt: "slow one", cwd: root, profile: "coding" });
      const second = new AgentSupervisor({ paths });
      await expect(second.start()).rejects.toThrow("already running");
      expect(client.records[0]?.state).not.toBe("failed");
    } finally {
      client.close();
      await first.close();
    }
  });

  test("a failed worker spawn becomes a failed row and releases session ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const supervisor = new AgentSupervisor({
      paths,
      spawn: (() => {
        throw new Error("spawn boom");
      }) as typeof Bun.spawn,
    });
    await supervisor.start();
    const client = new AgentViewClient({ paths, scope: "project", cwd: root });
    try {
      await client.connect(false);
      // This case verifies durable failure state and ownership cleanup. Request
      // rejection propagation is covered separately below.
      void client
        .dispatch({ prompt: "cannot start", cwd: root, profile: "coding" })
        .catch(() => {});
      await waitFor(() => client.records[0]?.state === "failed");
      expect(client.records).toHaveLength(1);
      expect(client.records[0]?.state).toBe("failed");
      expect(client.records[0]?.lastError).toContain("spawn boom");
      expect(await readSessionOwnership(paths, client.records[0]?.sessionId ?? "")).toBeUndefined();
    } finally {
      client.close();
      await supervisor.close();
    }
  });

  test("close does not depend on a client socket close event", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const supervisor = new AgentSupervisor({ paths });
    await supervisor.start();
    let destroyed = false;
    const internals = supervisor as unknown as {
      clients: Set<{
        id: string;
        socket: { destroy(): void };
        scope: string | undefined;
        attachment: string | undefined;
      }>;
    };
    internals.clients.add({
      id: "client-without-close-event",
      socket: {
        destroy: () => {
          destroyed = true;
        },
      },
      scope: undefined,
      attachment: undefined,
    });

    await supervisor.close();

    expect(destroyed).toBe(true);
  });

  test("close is bounded when the server omits its close callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const supervisor = new AgentSupervisor({ paths: agentViewPaths(root) });
    await supervisor.start();
    const internals = supervisor as unknown as {
      server: { close(callback?: () => void): unknown };
    };
    const closeServer = internals.server.close.bind(internals.server);
    internals.server.close = () => closeServer();
    const startedAt = Date.now();

    await supervisor.close();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("close waits for exit cleanup after a worker leaves the runtime roster", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const supervisor = new AgentSupervisor({ paths: agentViewPaths(root) });
    await supervisor.start();
    let finishExitCleanup = () => {};
    const exitCleanup = new Promise<void>((resolve) => {
      finishExitCleanup = resolve;
    });
    const internals = supervisor as unknown as {
      exitHandlers: Set<Promise<void>>;
    };
    internals.exitHandlers.add(exitCleanup);
    void exitCleanup.then(() => internals.exitHandlers.delete(exitCleanup));
    let closed = false;
    const close = supervisor.close().then(() => {
      closed = true;
    });
    await Bun.sleep(10);
    expect(closed).toBe(false);

    finishExitCleanup();
    await close;
    expect(closed).toBe(true);
  });

  test("close tolerates worker stdin closing before its exit is observed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const supervisor = new AgentSupervisor({
      paths,
      forceStopMs: 30,
      command: (args) => [process.execPath, fixture, ...args],
    });
    await supervisor.start();
    const client = new AgentViewClient({ paths, scope: "project", cwd: root });
    try {
      await client.connect(false);
      await client.dispatch({ prompt: "ordinary", cwd: root, profile: "coding" });
      const internals = supervisor as unknown as {
        runtimes: Map<string, { process: Bun.Subprocess<"pipe", "pipe", "pipe"> }>;
      };
      const runtime = [...internals.runtimes.values()][0];
      expect(runtime).toBeDefined();
      if (runtime) {
        const child = runtime.process;
        runtime.process = new Proxy(child, {
          get(target, property) {
            if (property === "stdin") {
              return {
                write: () => {
                  throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
                },
                flush: () => {},
              };
            }
            return Reflect.get(target, property, target);
          },
        });
      }
      client.close();

      await expect(supervisor.close()).resolves.toBeUndefined();
    } finally {
      client.close();
      await supervisor.close();
    }
  });

  test("close clears its force-stop deadline after a graceful worker exit", async () => {
    const child = Bun.spawn([process.execPath, closeFixture], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    let timedOut = false;
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(10_000).then(async () => {
        timedOut = true;
        child.kill("SIGKILL");
        return child.exited;
      }),
    ]);
    const stderr = await new Response(child.stderr).text();

    expect({ timedOut, exitCode, stderr }).toEqual({ timedOut: false, exitCode: 0, stderr: "" });
  }, 20_000);

  test("evicts an idle completed worker without changing completion or losing restartability", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const supervisor = new AgentSupervisor({
      paths,
      completedIdleMs: 20,
      command: (args) => [process.execPath, fixture, ...args],
    });
    await supervisor.start();
    const client = new AgentViewClient({ paths, scope: "project", cwd: root });
    try {
      await client.connect(false);
      await client.dispatch({ prompt: "finish then idle", cwd: root, profile: "coding" });
      await waitFor(() => client.records[0]?.state === "completed");
      const sessionId = client.records[0]?.sessionId ?? "";
      await waitFor(async () => (await readSessionOwnership(paths, sessionId)) === undefined);
      expect(client.records[0]?.state).toBe("completed");
      await client.sessionOp(sessionId, { type: "input", text: "continue after eviction" });
      await waitFor(() => client.records[0]?.summary.includes("continue after eviction") === true);
      expect(client.records[0]?.summary).toContain("finished continue after eviction");
    } finally {
      client.close();
      await supervisor.close();
    }
  });

  test("waits for an evicting worker to exit before accepting work on its replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const supervisor = new AgentSupervisor({
      paths,
      completedIdleMs: 10,
      command: (args) => [process.execPath, fixture, ...args],
    });
    await supervisor.start();
    const client = new AgentViewClient({ paths, scope: "project", cwd: root });
    try {
      await client.connect(false);
      await client.dispatch({
        prompt: "finish before eviction",
        cwd: root,
        profile: "slow-shutdown",
      });
      await waitFor(() => client.records[0]?.state === "completed");
      const sessionId = client.records[0]?.sessionId ?? "";
      await Bun.sleep(35);
      await client.sessionOp(sessionId, { type: "input", text: "accepted after eviction" });
      await waitFor(
        () =>
          client.records[0]?.state === "completed" &&
          client.records[0]?.summary.includes("finished accepted after eviction") === true,
      );
      expect(client.records[0]?.state).toBe("completed");
    } finally {
      client.close();
      await supervisor.close();
    }
  });

  test("propagates a worker rejection to the originating client request", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const supervisor = new AgentSupervisor({
      paths,
      command: (args) => [process.execPath, fixture, ...args],
    });
    await supervisor.start();
    const client = new AgentViewClient({ paths, scope: "project", cwd: root });
    try {
      await client.connect(false);
      await client.dispatch({ prompt: "ordinary", cwd: root, profile: "coding" });
      await waitFor(() => client.records[0]?.state === "completed");
      const sessionId = client.records[0]?.sessionId ?? "";
      await expect(
        client.sessionOp(sessionId, {
          type: "permission_reply",
          requestId: "not-open",
          outcome: "allow",
        }),
      ).rejects.toThrow("unknown permission request");
      expect(client.records[0]?.lastError).toBeUndefined();
    } finally {
      client.close();
      await supervisor.close();
    }
  });

  test("terminates a stale live worker before fencing and starting its replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const store = new AgentViewRosterStore(paths);
    await store.initialize();
    const sessionId = "session-stale-worker";
    const record = {
      ...createManagedSessionRecord({
        sessionId,
        scope: "project",
        prompt: "recover me",
        cwd: root,
        profile: "coding",
      }),
      state: "completed" as const,
    };
    await store.save([record]);
    const staleSupervisorPid = 2_000_000_000;
    expect(isProcessAlive(staleSupervisorPid)).toBe(false);
    let ownership = await acquireSessionOwnership(paths, sessionId, {
      supervisorPid: staleSupervisorPid,
    });
    const orphan = Bun.spawn(
      [
        process.execPath,
        fixture,
        "__agents-worker",
        "--session-id",
        sessionId,
        "--ownership-token",
        ownership.token,
        "--profile",
        "hang",
      ],
      {
        cwd: root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      },
    );
    ownership = await updateSessionOwnershipWorker(paths, ownership, orphan.pid);
    expect(isProcessAlive(orphan.pid)).toBe(true);

    const supervisor = new AgentSupervisor({
      paths,
      forceStopMs: 100,
      command: (args) => [process.execPath, fixture, ...args],
    });
    await supervisor.start();
    const client = new AgentViewClient({ paths, scope: "project", cwd: root });
    try {
      await client.connect(false);
      const attachment = await client.attach(sessionId);
      expect(attachment.sessionId).toBe(sessionId);
      await Promise.race([
        orphan.exited,
        Bun.sleep(2_000).then(() => {
          throw new Error("stale worker was not terminated");
        }),
      ]);
      const recovered = await readSessionOwnership(paths, sessionId);
      expect(recovered?.token).not.toBe(ownership.token);
      expect(recovered?.workerPid).not.toBe(orphan.pid);
    } finally {
      client.close();
      await supervisor.close();
      if (orphan.exitCode === null) orphan.kill("SIGKILL");
      await orphan.exited;
    }
  });

  test("malformed output, worker crashes, and startup timeouts become failed rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const supervisor = new AgentSupervisor({
      paths,
      workerStartupMs: 500,
      forceStopMs: 30,
      command: (args) => [process.execPath, fixture, ...args],
    });
    await supervisor.start();
    const client = new AgentViewClient({ paths, scope: "project", cwd: root });
    try {
      await client.connect(false);
      await client.dispatch({ prompt: "malformed output", cwd: root, profile: "coding" });
      await client.dispatch({ prompt: "crash now", cwd: root, profile: "coding" });
      await expect(
        client.dispatch({ prompt: "stale generation", cwd: root, profile: "stale-output" }),
      ).rejects.toThrow("stale ownership generation");
      await expect(
        client.dispatch({ prompt: "never ready", cwd: root, profile: "hang" }),
      ).rejects.toThrow("did not become ready");
      await waitFor(
        () => client.records.length === 4 && client.records.every((row) => row.state === "failed"),
        4_000,
      );
      const errors = client.records.map((row) => row.lastError ?? "");
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("exited with code 7"),
          expect.stringContaining("stale ownership generation"),
          expect.stringContaining("did not become ready"),
        ]),
      );
    } finally {
      client.close();
      await supervisor.close();
    }
  }, 15_000);
});
