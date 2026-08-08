import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSupervisor } from "./agent-supervisor.ts";
import { AgentViewClient } from "./agent-view-client.ts";
import { agentViewPaths, readSessionOwnership } from "./agent-view-store.ts";

const roots: string[] = [];
const fixture = join(import.meta.dir, "../testing/agent-worker-fixture.ts");

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
  test("hosts independent workers after a viewer disconnect and supports attach/remove semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const supervisor = new AgentSupervisor({
      paths,
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
      await waitFor(() => second.records.every((record) => record.state === "completed"));
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
      await expect(
        client.dispatch({ prompt: "cannot start", cwd: root, profile: "coding" }),
      ).rejects.toThrow("spawn boom");
      expect(client.records).toHaveLength(1);
      expect(client.records[0]?.state).toBe("failed");
      expect(await readSessionOwnership(paths, client.records[0]?.sessionId ?? "")).toBeUndefined();
    } finally {
      client.close();
      await supervisor.close();
    }
  });

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

  test("malformed output, worker crashes, and startup timeouts become failed rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-supervisor-test-"));
    roots.push(root);
    const paths = agentViewPaths(root);
    const supervisor = new AgentSupervisor({
      paths,
      workerStartupMs: 2_000,
      forceStopMs: 30,
      command: (args) => [process.execPath, fixture, ...args],
    });
    await supervisor.start();
    const client = new AgentViewClient({ paths, scope: "project", cwd: root });
    try {
      await client.connect(false);
      await client.dispatch({ prompt: "malformed output", cwd: root, profile: "coding" });
      await client.dispatch({ prompt: "crash now", cwd: root, profile: "coding" });
      await client.dispatch({ prompt: "never ready", cwd: root, profile: "hang" });
      await waitFor(
        () => client.records.length === 3 && client.records.every((row) => row.state === "failed"),
        4_000,
      );
      const errors = client.records.map((row) => row.lastError ?? "");
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("exited with code 7"),
          expect.stringContaining("did not become ready"),
        ]),
      );
    } finally {
      client.close();
      await supervisor.close();
    }
  });
});
