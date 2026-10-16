import { describe, expect, test } from "bun:test";
import {
  type CheckpointEntry,
  CheckpointHistory,
  type CheckpointProvider,
  MemorySessionStore,
  type ProfileRuntime,
  type SessionTree,
} from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { registryWithCoreCommands } from "./commands.ts";
import { tool } from "./tool.ts";

// An in-memory stand-in for the shadow repository: the pairing logic under
// test is the kernel's, not git's (git is covered in the profile's own tests).
class MemoryCheckpoints implements CheckpointProvider {
  state = "initial";
  private snapshots = new Map<string, string>();
  private counter = 0;
  restored: string[] = [];
  failSnapshot = false;
  failRestore = false;
  failDiff = false;

  async snapshot(): Promise<string | undefined> {
    if (this.failSnapshot) throw new Error("snapshot failed");
    const ref = `ref-${this.counter++}`;
    this.snapshots.set(ref, this.state);
    return ref;
  }

  async restore(ref: string): Promise<void> {
    if (this.failRestore) throw new Error("restore failed");
    this.restored.push(ref);
    const value = this.snapshots.get(ref);
    if (value !== undefined) this.state = value;
  }

  async restoreResources(ref: string): Promise<void> {
    await this.restore(ref);
  }

  async diff(fromRef: string, toRef?: string) {
    if (this.failDiff) throw new Error("diff failed");
    const target = toRef ? this.snapshots.get(toRef) : this.state;
    return this.snapshots.get(fromRef) === target
      ? []
      : [{ path: "state.txt", added: 1, removed: 1, hunks: [] }];
  }
}

class FailingSessionStore extends MemorySessionStore {
  fail = false;

  override async save(sessionId: string, tree: SessionTree): Promise<void> {
    if (this.fail) throw new Error("save failed");
    await super.save(sessionId, tree);
  }
}

function writer(checkpoints: MemoryCheckpoints) {
  return tool({
    name: "write",
    description: "writes state",
    inputSchema: z.object({ value: z.string() }),
    changesState: true,
    execute: ({ value }) => {
      checkpoints.state = value;
      return `wrote ${value}`;
    },
  });
}

describe("CheckpointHistory", () => {
  const first: CheckpointEntry = {
    id: "e1",
    beforeEntryId: null,
    beforeRef: "s0",
    afterRef: "s1",
    label: "first",
  };
  const second: CheckpointEntry = {
    id: "e2",
    beforeEntryId: "e1",
    beforeRef: "s1",
    afterRef: "s2",
    label: "second",
  };

  test("undo selects the last action without changing history", () => {
    const history = new CheckpointHistory();
    history.record(first);
    history.record(second);

    expect(history.peekUndo()).toEqual(second);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
  });

  test("commit moves one action between undo and redo", () => {
    const history = new CheckpointHistory();
    history.record(first);
    history.record(second);
    history.commitUndo(second);

    expect(history.canRedo).toBe(true);
    expect(history.peekUndo()).toEqual(first);
    expect(history.peekRedo()).toEqual(second);
    history.commitRedo(second);
    expect(history.canRedo).toBe(false);
    expect(history.peekUndo()).toEqual(second);
  });

  test("a new action clears the redo stack", () => {
    const history = new CheckpointHistory();
    history.record(first);
    history.record(second);
    history.commitUndo(second);
    history.record({ ...second, id: "e3" });
    expect(history.canRedo).toBe(false);
  });

  test("empty history has no transitions", () => {
    const history = new CheckpointHistory();
    expect(history.peekUndo()).toBeUndefined();
    expect(history.peekRedo()).toBeUndefined();
    expect(history.canUndo).toBe(false);
  });
});

describe("one checkpoint per user turn", () => {
  test("a mutating user turn is captured once", async () => {
    const checkpoints = new MemoryCheckpoints();
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { value: "v2" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      tools: [writer(checkpoints)],
      checkpointProvider: checkpoints,
    });
    await agent.run("change it");

    expect(agent.checkpointHistory.all().length).toBe(1);
    expect(agent.session.activePath().some((entry) => entry.type === "checkpoint")).toBe(true);
    expect(checkpoints.state).toBe("v2");
  });

  test("aborting during the before-turn capture cancels it and records no checkpoint", async () => {
    const labels: string[] = [];
    let started!: () => void;
    const capturing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const checkpoints: CheckpointProvider = {
      snapshot: (label, signal) => {
        labels.push(label ?? "");
        started();
        return new Promise((resolve) =>
          signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
        );
      },
      restore: async () => {},
      diff: async () => [],
    };
    const provider = new FakeProvider([{ content: [{ type: "text", text: "never" }] }]);
    const agent = new Agent({ provider, model: fakeModel, checkpointProvider: checkpoints });
    const run = agent.run("hello");
    await capturing;
    agent.abort();
    const result = await run;

    expect(result.reason).toBe("aborted");
    expect(labels).toEqual(["before user turn"]);
    expect(agent.checkpointHistory.all()).toEqual([]);
  });

  test("the provider request does not wait for the before-turn capture", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checkpoints: CheckpointProvider = {
      snapshot: async (label) => {
        if (label === "before user turn") await released;
        return label ?? "ref";
      },
      restore: async () => {},
      diff: async () => [],
    };
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]);
    const agent = new Agent({ provider, model: fakeModel, checkpointProvider: checkpoints });
    const run = agent.run("hello");
    while (provider.requests.length === 0) await Bun.sleep(1);
    release();
    await run;

    expect(agent.checkpointHistory.all().map((entry) => entry.beforeRef)).toEqual([
      "before user turn",
    ]);
  });

  test("a tool call waits for the before-turn capture", async () => {
    let captured = false;
    const checkpoints: CheckpointProvider = {
      snapshot: async (label) => {
        if (label === "before user turn") {
          await Bun.sleep(30);
          captured = true;
        }
        return label ?? "ref";
      },
      restore: async () => {},
      diff: async () => [],
    };
    const sawCapture: boolean[] = [];
    const probe = tool({
      name: "probe",
      description: "records whether the capture finished",
      inputSchema: z.object({}),
      changesState: true,
      execute: () => {
        sawCapture.push(captured);
        return "ok";
      },
    });
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "probe", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      tools: [probe],
      checkpointProvider: checkpoints,
    });
    await agent.run("go");

    expect(sawCapture).toEqual([true]);
  });

  describe("the after-turn capture is skipped only when nothing can have changed", () => {
    function counting() {
      const labels: string[] = [];
      const checkpoints: CheckpointProvider = {
        snapshot: async (label) => {
          labels.push(label ?? "");
          return `ref-${labels.length}`;
        },
        restore: async () => {},
        diff: async () => [],
      };
      return { labels, checkpoints };
    }
    const lookup = (changesState?: boolean) =>
      tool({
        name: "lookup",
        description: "reads something",
        inputSchema: z.object({}),
        ...(changesState === undefined ? {} : { changesState }),
        execute: () => "found",
      });
    const callingLookup = () =>
      new FakeProvider([
        { content: [{ type: "toolCall", id: "c1", name: "lookup", arguments: {} }] },
        { content: [{ type: "text", text: "done" }] },
      ]);

    test("a turn of read-only tools reuses the before-turn reference", async () => {
      const { labels, checkpoints } = counting();
      const agent = new Agent({
        provider: callingLookup(),
        model: fakeModel,
        tools: [lookup(false)],
        checkpointProvider: checkpoints,
      });
      await agent.run("look");
      expect(labels).toEqual(["before user turn"]);
      const [entry] = agent.checkpointHistory.all();
      expect(entry?.afterRef).toBe(entry?.beforeRef);
    });

    test("a chat-only turn takes one capture", async () => {
      const { labels, checkpoints } = counting();
      const agent = new Agent({
        provider: new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]),
        model: fakeModel,
        checkpointProvider: checkpoints,
      });
      await agent.run("hello");
      expect(labels).toEqual(["before user turn"]);
    });

    test("a tool that does not declare itself read-only is assumed to change state", async () => {
      const { labels, checkpoints } = counting();
      const agent = new Agent({
        provider: callingLookup(),
        model: fakeModel,
        tools: [lookup()],
        checkpointProvider: checkpoints,
      });
      await agent.run("look");
      expect(labels).toEqual(["before user turn", "after user turn"]);
    });

    test("a running background task forces the capture", async () => {
      const { labels, checkpoints } = counting();
      let host: Parameters<ProfileRuntime["attach"]>[0] | undefined;
      const agent = new Agent({
        provider: callingLookup(),
        model: fakeModel,
        tools: [lookup(false)],
        checkpointProvider: checkpoints,
        runtime: {
          attach: (attached) => {
            host = attached;
          },
        },
      });
      host?.emit({ type: "task_started", taskId: "t1", command: "npm run dev", background: true });
      await agent.run("look");
      expect(labels).toEqual(["before user turn", "after user turn"]);

      host?.emit({ type: "task_exited", taskId: "t1", exitCode: 0, status: "exited" });
      labels.length = 0;
      await agent.run("look again");
      expect(labels).toEqual(["before user turn"]);
    });

    test("a denied state-changing call changes nothing", async () => {
      const { labels, checkpoints } = counting();
      const agent = new Agent({
        provider: callingLookup(),
        model: fakeModel,
        tools: [lookup(true)],
        checkpointProvider: checkpoints,
        permissions: [{ permission: "lookup", pattern: "*", action: "deny" }],
      });
      await agent.run("look");
      expect(labels).toEqual(["before user turn"]);
    });
  });

  describe("a turn whose changes are all declared records only those resources", () => {
    function recording(
      resourceRef: (base: string | undefined) => string | undefined = (base) => `${base}+`,
    ) {
      const calls: string[] = [];
      const checkpoints: CheckpointProvider = {
        snapshot: async (label) => {
          calls.push(`snapshot ${label ?? ""}`);
          return `ref-${calls.length}`;
        },
        snapshotResources: async (base, resources, label) => {
          calls.push(`resources ${base} [${resources.join(",")}] ${label ?? ""}`);
          return resourceRef(base);
        },
        restore: async () => {},
        diff: async () => [],
      };
      return { calls, checkpoints };
    }
    const named = (name: string, declare?: (args: { target: string }) => string[]) =>
      tool({
        name,
        description: "changes one named thing",
        inputSchema: z.object({ target: z.string() }),
        changesState: true,
        ...(declare ? { changedResources: declare } : {}),
        execute: ({ target }) => `changed ${target}`,
      });
    const calling = (...calls: [string, string][]) =>
      new FakeProvider([
        {
          content: calls.map(([name, target], index) => ({
            type: "toolCall" as const,
            id: `c${index}`,
            name,
            arguments: { target },
          })),
        },
        { content: [{ type: "text", text: "done" }] },
      ]);

    test("the after-turn capture covers the union of declared resources", async () => {
      const { calls, checkpoints } = recording();
      const agent = new Agent({
        provider: calling(["change", "a"], ["change", "b"], ["change", "a"]),
        model: fakeModel,
        tools: [named("change", ({ target }) => [target])],
        checkpointProvider: checkpoints,
      });
      await agent.run("change things");
      expect(calls).toEqual(["snapshot before user turn", "resources ref-1 [a,b] after user turn"]);
      const [entry] = agent.checkpointHistory.all();
      expect(entry).toMatchObject({ beforeRef: "ref-1", afterRef: "ref-1+" });
    });

    test("one undeclared change in the turn forces the full capture", async () => {
      const { calls, checkpoints } = recording();
      const agent = new Agent({
        provider: calling(["change", "a"], ["other", "b"]),
        model: fakeModel,
        tools: [named("change", ({ target }) => [target]), named("other")],
        checkpointProvider: checkpoints,
      });
      await agent.run("change things");
      expect(calls).toEqual(["snapshot before user turn", "snapshot after user turn"]);
    });

    test("a classifier that throws counts as an undeclared change", async () => {
      const { calls, checkpoints } = recording();
      const agent = new Agent({
        provider: calling(["change", "a"]),
        model: fakeModel,
        tools: [
          named("change", () => {
            throw new Error("cannot tell");
          }),
        ],
        checkpointProvider: checkpoints,
      });
      await agent.run("change things");
      expect(calls).toEqual(["snapshot before user turn", "snapshot after user turn"]);
    });

    test("a provider that cannot capture the resources falls back to the full capture", async () => {
      const { calls, checkpoints } = recording(() => undefined);
      const agent = new Agent({
        provider: calling(["change", "a"]),
        model: fakeModel,
        tools: [named("change", ({ target }) => [target])],
        checkpointProvider: checkpoints,
      });
      await agent.run("change things");
      expect(calls).toEqual([
        "snapshot before user turn",
        "resources ref-1 [a] after user turn",
        "snapshot after user turn",
      ]);
      expect(agent.checkpointHistory.all()[0]?.afterRef).toBe("ref-3");
    });

    test("a running background task forces the full capture", async () => {
      const { calls, checkpoints } = recording();
      let host: Parameters<ProfileRuntime["attach"]>[0] | undefined;
      const agent = new Agent({
        provider: calling(["change", "a"]),
        model: fakeModel,
        tools: [named("change", ({ target }) => [target])],
        checkpointProvider: checkpoints,
        runtime: {
          attach: (attached) => {
            host = attached;
          },
        },
      });
      host?.emit({ type: "task_started", taskId: "t1", command: "watch", background: true });
      await agent.run("change things");
      expect(calls).toEqual(["snapshot before user turn", "snapshot after user turn"]);
    });

    test("a denied declared call is not recorded", async () => {
      const { calls, checkpoints } = recording();
      const agent = new Agent({
        provider: calling(["change", "a"]),
        model: fakeModel,
        tools: [named("change", ({ target }) => [target])],
        checkpointProvider: checkpoints,
        permissions: [{ permission: "change", pattern: "*", action: "deny" }],
      });
      await agent.run("change things");
      expect(calls).toEqual(["snapshot before user turn"]);
    });

    test("tool() validates arguments before asking which resources change", () => {
      const declared = named("change", ({ target }) => [`item:${target}`]);
      expect(declared.changedResources?.({ target: "a" })).toEqual(["item:a"]);
      expect(() =>
        declared.changedResources?.({ target: 1 } as unknown as { target: string }),
      ).toThrow();
    });
  });

  describe("declared coverage records each resource just before it first changes", () => {
    function declared(failBefore = false) {
      const state = new Map<string, string>([["a", "a0"]]);
      const refs = new Map<string, Map<string, string>>();
      const calls: string[] = [];
      let counter = 0;
      const checkpoints: CheckpointProvider = {
        coverage: "declared",
        snapshot: async () => {
          calls.push("snapshot");
          return undefined;
        },
        snapshotResources: async (base, resources, label) => {
          calls.push(
            `${label} [${resources.join(",")}] ${resources.map((r) => state.get(r)).join(",")}`,
          );
          if (failBefore && label === "before change") throw new Error("cannot read");
          const tree = new Map(base ? refs.get(base) : undefined);
          for (const resource of resources) {
            const value = state.get(resource);
            if (value === undefined) tree.delete(resource);
            else tree.set(resource, value);
          }
          const ref = `r${counter++}`;
          refs.set(ref, tree);
          return ref;
        },
        restore: async () => {},
        restoreResources: async (ref, resources) => {
          for (const resource of resources) {
            const value = refs.get(ref)?.get(resource);
            if (value === undefined) state.delete(resource);
            else state.set(resource, value);
          }
        },
        diff: async (from, to) => {
          const a = refs.get(from) ?? new Map();
          const b = (to ? refs.get(to) : state) ?? new Map();
          return [...new Set([...a.keys(), ...b.keys()])]
            .filter((key) => a.get(key) !== b.get(key))
            .sort()
            .map((path) => ({ path, added: 1, removed: 1, hunks: [] }));
        },
      };
      const setter = tool({
        name: "set",
        description: "sets a value",
        inputSchema: z.object({ key: z.string(), value: z.string() }),
        changesState: true,
        changedResources: ({ key }) => [key],
        execute: ({ key, value }) => {
          state.set(key, value);
          return "set";
        },
      });
      const shell = tool({
        name: "shell",
        description: "changes something unnamed",
        inputSchema: z.object({}),
        execute: () => {
          state.set("unnamed", "x");
          return "ran";
        },
      });
      return { state, calls, checkpoints, tools: [setter, shell] };
    }
    const turn = (...calls: [string, Record<string, unknown>][]) => [
      ...calls.map(([name, args], index) => ({
        content: [{ type: "toolCall" as const, id: `c${index}`, name, arguments: args }],
      })),
      { content: [{ type: "text" as const, text: "done" }] },
    ];

    test("prior state is taken once per resource, before the call runs", async () => {
      const { state, calls, checkpoints, tools } = declared();
      const agent = new Agent({
        provider: new FakeProvider(
          turn(
            ["set", { key: "a", value: "a1" }],
            ["set", { key: "a", value: "a2" }],
            ["set", { key: "b", value: "b1" }],
            ["shell", {}],
          ),
        ),
        model: fakeModel,
        tools,
        checkpointProvider: checkpoints,
      });
      await agent.run("change");
      expect(calls).toEqual([
        "before user turn [] ",
        "before change [a] a0",
        "before change [b] ",
        "after user turn [a,b] a2,b1",
      ]);
      expect((await agent.undo()).data?.files.map((file) => file.path)).toEqual(["a", "b"]);
      expect([...state.entries()].sort()).toEqual([
        ["a", "a0"],
        ["unnamed", "x"],
      ]);
    });

    test("a resource whose prior state could not be taken is left out of the turn", async () => {
      const { state, calls, checkpoints, tools } = declared(true);
      const agent = new Agent({
        provider: new FakeProvider(turn(["set", { key: "a", value: "a1" }])),
        model: fakeModel,
        tools,
        checkpointProvider: checkpoints,
      });
      await agent.run("change");
      expect(calls).toEqual(["before user turn [] ", "before change [a] a0"]);
      expect(agent.checkpointHistory.all()).toHaveLength(1);
      expect((await agent.undo()).data?.files).toEqual([]);
      expect(state.get("a")).toBe("a1");
    });

    test("a denied call takes no prior state", async () => {
      const { calls, checkpoints, tools } = declared();
      const agent = new Agent({
        provider: new FakeProvider(turn(["set", { key: "a", value: "a1" }])),
        model: fakeModel,
        tools,
        checkpointProvider: checkpoints,
        permissions: [{ permission: "set", pattern: "*", action: "deny" }],
      });
      await agent.run("change");
      expect(calls).toEqual(["before user turn [] "]);
    });

    test("the notice is reported only with a provider", () => {
      const { checkpoints } = declared();
      expect(
        new Agent({ checkpointProvider: checkpoints, checkpointNotice: "partial" })
          .checkpointNotice,
      ).toBe("partial");
      expect(new Agent({ checkpointNotice: "partial" }).checkpointNotice).toBeUndefined();
    });
  });

  test("agent_end arrives once the turn is recorded and the agent is idle", async () => {
    const checkpoints = new MemoryCheckpoints();
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { value: "v2" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      tools: [writer(checkpoints)],
      checkpointProvider: checkpoints,
    });
    const seen: { running: boolean; checkpoints: number }[] = [];
    let undo: Promise<{ ok: boolean }> | undefined;
    agent.subscribe((event) => {
      if (event.type !== "agent_end") return;
      seen.push({ running: agent.isRunning, checkpoints: agent.checkpointHistory.all().length });
      undo = agent.undo();
    });
    await agent.run("change it");

    expect(seen).toEqual([{ running: false, checkpoints: 1 }]);
    expect((await undo)?.ok).toBe(true);
    expect(checkpoints.state).toBe("initial");
  });

  test("a read-only turn is still undoable as conversation", async () => {
    const checkpoints = new MemoryCheckpoints();
    const reader = tool({
      name: "read",
      description: "reads",
      inputSchema: z.object({}),
      execute: () => "contents",
    });
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      tools: [reader],
      checkpointProvider: checkpoints,
    });
    await agent.run("look at it");

    expect(agent.checkpointHistory.all()).toHaveLength(1);
    const undone = await agent.undo();
    expect(undone.ok).toBe(true);
    expect(undone.data?.files).toEqual([]);
    expect(undone.data?.prompt).toBe("look at it");
  });

  test("multiple internal tool steps produce one user-turn checkpoint", async () => {
    const checkpoints = new MemoryCheckpoints();
    const setter = tool({
      name: "set_remote_state",
      description: "sets state",
      inputSchema: z.object({ value: z.string(), dryRun: z.boolean() }),
      changesState: ({ dryRun }) => !dryRun,
      execute: ({ value, dryRun }) => {
        if (!dryRun) checkpoints.state = value;
        return "done";
      },
    });
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "set_remote_state",
            arguments: { value: "ignored", dryRun: true },
          },
        ],
      },
      {
        content: [
          {
            type: "toolCall",
            id: "c2",
            name: "set_remote_state",
            arguments: { value: "changed", dryRun: false },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      tools: [setter],
      checkpointProvider: checkpoints,
    });

    await agent.run("change it");

    expect(checkpoints.state).toBe("changed");
    expect(agent.checkpointHistory.all()).toHaveLength(1);
  });

  test("a checkpoint failure does not block the tool call", async () => {
    const failing: CheckpointProvider = {
      snapshot: async () => {
        throw new Error("disk full");
      },
      restore: async () => {},
      diff: async () => [],
    };
    const checkpoints = new MemoryCheckpoints();
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { value: "v2" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      tools: [writer(checkpoints)],
      checkpointProvider: failing,
    });
    const result = await agent.run("change it");

    expect(result.reason).toBe("done");
    expect(checkpoints.state).toBe("v2");
  });

  test("a denied mutating call leaves an undoable conversation turn", async () => {
    const checkpoints = new MemoryCheckpoints();
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { value: "v2" } }] },
      { content: [{ type: "text", text: "denied" }] },
    ]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      tools: [writer(checkpoints)],
      checkpointProvider: checkpoints,
      permissions: [{ permission: "write", pattern: "*", action: "deny" }],
    });

    await agent.run("change it");

    expect(checkpoints.state).toBe("initial");
    expect(agent.checkpointHistory.all()).toHaveLength(1);
  });
});

describe("undo and redo pair workspace with conversation", () => {
  async function sessionWithTwoEdits(session: MemorySessionStore = new MemorySessionStore()) {
    const checkpoints = new MemoryCheckpoints();
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { value: "v1" } }] },
      { content: [{ type: "text", text: "first done" }] },
      { content: [{ type: "toolCall", id: "c2", name: "write", arguments: { value: "v2" } }] },
      { content: [{ type: "text", text: "second done" }] },
    ]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      tools: [writer(checkpoints)],
      checkpointProvider: checkpoints,
      session,
    });
    await agent.run("first change");
    await agent.run("second change");
    return { agent, checkpoints, session };
  }

  test("undo restores the workspace and rewinds the transcript together", async () => {
    const { agent, checkpoints } = await sessionWithTwoEdits();
    const messagesBefore = agent.session.messagesAt().length;
    expect(checkpoints.state).toBe("v2");

    const result = await agent.undo();

    expect(result.ok).toBe(true);
    expect(checkpoints.state).toBe("v1");
    expect(agent.session.messagesAt().length).toBeLessThan(messagesBefore);
    expect(result.data?.prompt).toBe("second change");
    expect(result.data?.files).toHaveLength(1);
  });

  test("consecutive undo and redo traverse every workspace state", async () => {
    const { agent, checkpoints } = await sessionWithTwoEdits();
    await agent.undo();
    expect(checkpoints.state).toBe("v1");
    await agent.undo();
    expect(checkpoints.state).toBe("initial");

    expect((await agent.redo()).ok).toBe(true);
    expect(checkpoints.state).toBe("v1");
    expect((await agent.redo()).ok).toBe(true);
    expect(checkpoints.state).toBe("v2");
  });

  test("undo points list prompts newest-first and a selected depth reverts atomically", async () => {
    const { agent, checkpoints, session } = await sessionWithTwoEdits();

    expect(agent.undoPoints().map(({ steps, prompt }) => ({ steps, prompt }))).toEqual([
      { steps: 1, prompt: "second change" },
      { steps: 2, prompt: "first change" },
    ]);

    checkpoints.state = "user edits after both turns";
    const result = await agent.undo(2);

    expect(result.ok).toBe(true);
    expect(result.data?.turnCount).toBe(2);
    expect(result.data?.prompt).toBe("first change");
    expect(checkpoints.state).toBe("initial");
    expect(agent.checkpointHistory.canUndo).toBe(false);
    expect(agent.checkpointHistory.canRedo).toBe(true);

    const resumed = new Agent({
      provider: new FakeProvider([]),
      model: fakeModel,
      tools: [writer(checkpoints)],
      checkpointProvider: checkpoints,
      session,
      sessionId: agent.sessionId,
    });
    resumed.resume((await session.load(agent.sessionId)) as SessionTree);

    expect((await resumed.redo()).ok).toBe(true);
    expect(checkpoints.state).toBe("v1");
    expect((await resumed.redo()).ok).toBe(true);
    expect(checkpoints.state).toBe("user edits after both turns");
  });

  test("checkpoint history and an undone cursor survive resume", async () => {
    const { agent, checkpoints, session } = await sessionWithTwoEdits();
    await agent.undo();
    expect(checkpoints.state).toBe("v1");

    const resumed = new Agent({
      provider: new FakeProvider([]),
      model: fakeModel,
      tools: [writer(checkpoints)],
      checkpointProvider: checkpoints,
      session,
      sessionId: agent.sessionId,
    });
    const tree = await session.load(agent.sessionId);
    expect(tree).toBeDefined();
    resumed.resume(tree as NonNullable<typeof tree>);

    expect(resumed.checkpointHistory.canUndo).toBe(true);
    expect(resumed.checkpointHistory.canRedo).toBe(true);
    expect((await resumed.redo()).ok).toBe(true);
    expect(checkpoints.state).toBe("v2");
  });

  test("redo restores the exact state captured immediately before undo", async () => {
    const { agent, checkpoints } = await sessionWithTwoEdits();
    checkpoints.state = "user edits after the turn";

    expect((await agent.undo()).ok).toBe(true);
    expect(checkpoints.state).toBe("v1");
    expect((await agent.redo()).ok).toBe(true);
    expect(checkpoints.state).toBe("user edits after the turn");
  });

  test("a new turn after undo clears redo and persists the new cursor", async () => {
    const session = new MemorySessionStore();
    const { agent, checkpoints } = await sessionWithTwoEdits(session);
    await agent.undo();

    const resumed = new Agent({
      provider: new FakeProvider([
        { content: [{ type: "toolCall", id: "c3", name: "write", arguments: { value: "v3" } }] },
        { content: [{ type: "text", text: "third done" }] },
      ]),
      model: fakeModel,
      tools: [writer(checkpoints)],
      checkpointProvider: checkpoints,
      session,
      sessionId: agent.sessionId,
    });
    resumed.resume((await session.load(agent.sessionId)) as SessionTree);
    await resumed.run("third change");
    expect(resumed.checkpointHistory.canRedo).toBe(false);

    const restarted = new Agent({
      provider: new FakeProvider([]),
      model: fakeModel,
      tools: [writer(checkpoints)],
      checkpointProvider: checkpoints,
      session,
      sessionId: agent.sessionId,
    });
    restarted.resume((await session.load(agent.sessionId)) as SessionTree);
    expect(restarted.checkpointHistory.canRedo).toBe(false);
    expect(restarted.checkpointHistory.canUndo).toBe(true);
    expect((await restarted.undo()).ok).toBe(true);
    expect(checkpoints.state).toBe("v1");
  });

  test("restore failure leaves undo history and conversation untouched", async () => {
    const { agent, checkpoints } = await sessionWithTwoEdits();
    const head = agent.session.head;
    checkpoints.failRestore = true;

    const failed = await agent.undo();

    expect(failed.ok).toBe(false);
    expect(agent.session.head).toBe(head);
    expect(agent.checkpointHistory.canUndo).toBe(true);
    expect(agent.checkpointHistory.canRedo).toBe(false);
    expect(checkpoints.state).toBe("v2");

    checkpoints.failRestore = false;
    expect((await agent.undo()).ok).toBe(true);
    expect(checkpoints.state).toBe("v1");
  });

  test("diff failure leaves undo history, workspace, and conversation untouched", async () => {
    const { agent, checkpoints } = await sessionWithTwoEdits();
    const head = agent.session.head;
    checkpoints.failDiff = true;

    const failed = await agent.undo();

    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("diff failed");
    expect(agent.session.head).toBe(head);
    expect(agent.checkpointHistory.canUndo).toBe(true);
    expect(agent.checkpointHistory.canRedo).toBe(false);
    expect(checkpoints.state).toBe("v2");
  });

  test("snapshot failure before undo does not consume the transition", async () => {
    const { agent, checkpoints } = await sessionWithTwoEdits();
    checkpoints.failSnapshot = true;

    expect((await agent.undo()).ok).toBe(false);
    expect(agent.checkpointHistory.canUndo).toBe(true);
    expect(agent.checkpointHistory.canRedo).toBe(false);
    expect(checkpoints.state).toBe("v2");

    checkpoints.failSnapshot = false;
    expect((await agent.undo()).ok).toBe(true);
    expect(checkpoints.state).toBe("v1");
  });

  test("session save failure rolls the workspace back and leaves history unchanged", async () => {
    const session = new FailingSessionStore();
    const { agent, checkpoints } = await sessionWithTwoEdits(session);
    const head = agent.session.head;
    session.fail = true;

    const failed = await agent.undo();

    expect(failed.ok).toBe(false);
    expect(checkpoints.state).toBe("v2");
    expect(agent.session.head).toBe(head);
    expect(agent.checkpointHistory.canUndo).toBe(true);
    expect(agent.checkpointHistory.canRedo).toBe(false);
  });

  test("a chat-only turn can be undone", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      checkpointProvider: new MemoryCheckpoints(),
    });
    await agent.run("nothing to change");
    const result = await agent.undo();
    expect(result.ok).toBe(true);
    expect(result.data?.files).toEqual([]);
    expect(result.data?.prompt).toBe("nothing to change");
  });

  test("undo with no user turns says so rather than failing", async () => {
    const agent = new Agent({
      provider: new FakeProvider([]),
      model: fakeModel,
      checkpointProvider: new MemoryCheckpoints(),
    });
    const result = await agent.undo();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Nothing to undo");
  });

  test("a profile whose checkpoints are off here reports its reason", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]);
    const reason = "Checkpoints are off here.";
    const agent = new Agent({ provider, model: fakeModel, checkpointUnavailable: reason });
    expect(agent.checkpointUnavailable).toBe(reason);
    expect((await agent.undo()).message).toBe(reason);
    expect((await agent.redo()).message).toBe(reason);
  });

  test("a profile without checkpointing reports undo as unsupported", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]);
    const agent = new Agent({ provider, model: fakeModel });
    const result = await agent.undo();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not support undo");
  });
});

describe("fork", () => {
  test("branches the session tree from a chosen entry", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "second" }] },
    ]);
    const agent = new Agent({ provider, model: fakeModel });
    await agent.run("one");

    const entries = agent.session.activePath();
    const forkPoint = entries[0];
    expect(forkPoint).toBeDefined();

    const forked = await agent.fork((forkPoint as { id: string }).id);
    expect(forked.ok).toBe(true);
    const persisted = await agent.sessionStore.load(agent.sessionId);
    expect(persisted?.head).toBe(agent.session.head);
    expect(persisted?.messagesAt()).toHaveLength(1);
    await agent.run("different direction");

    const texts = agent.session
      .messagesAt()
      .map((m) =>
        (m.role === "user" || m.role === "custom") && m.content[0]?.type === "text"
          ? m.content[0].text
          : "",
      );
    expect(texts).toContain("different direction");
    // The abandoned branch still exists on disk — forking destroys nothing.
    expect(agent.session.all().length).toBeGreaterThan(agent.session.activePath().length);
  });

  test("rejects an unknown entry without moving the session", async () => {
    const agent = new Agent({
      provider: new FakeProvider([{ content: [{ type: "text", text: "first" }] }]),
      model: fakeModel,
    });
    await agent.run("one");
    const head = agent.session.head;

    const result = await agent.fork("foreign-entry");

    expect(result.ok).toBe(false);
    expect(agent.session.head).toBe(head);
  });

  test("lists user-visible branch points without incomplete tool calls", async () => {
    const agent = new Agent({
      provider: new FakeProvider([
        { content: [{ type: "toolCall", id: "c1", name: "missing", arguments: {} }] },
        { content: [{ type: "text", text: "finished" }] },
      ]),
      model: fakeModel,
    });
    await agent.run("change direction");

    const points = agent.forkPoints();

    expect(points.some((point) => point.description.includes("change direction"))).toBe(true);
    expect(points.some((point) => point.description.includes("finished"))).toBe(true);
    expect(points).toHaveLength(2);
  });
});

describe("commands", () => {
  function ctx() {
    const printed: string[] = [];
    return {
      printed,
      ctx: {
        inject: () => {},
        print: (t: string) => printed.push(t),
        getModel: () => "fake/fake-1",
        setModel: () => {},
      },
    };
  }

  test("/undo and /redo report what happened", async () => {
    const registry = registryWithCoreCommands({
      undo: async () => ({
        ok: true,
        message: "Undid the last turn.",
        data: {
          kind: "checkpoint",
          action: "undo",
          files: [],
          turnCount: 1,
          messageCount: 2,
          prompt: "try again",
        },
      }),
      redo: async () => ({ ok: true, message: "Redid the step." }),
    });
    const undone = await registry.execute("/undo", ctx().ctx);
    expect(undone.message).toBe("Undid the last turn.");
    expect(undone.data).toEqual({
      kind: "checkpoint",
      action: "undo",
      files: [],
      turnCount: 1,
      messageCount: 2,
      prompt: "try again",
    });
    expect((await registry.execute("/redo", ctx().ctx)).message).toBe("Redid the step.");
  });

  test("/undo offers prompt depths and executes an explicit selection", async () => {
    let selected: number | undefined;
    const registry = registryWithCoreCommands({
      undoPoints: () => [
        { steps: 1, prompt: "latest", messageCount: 2 },
        { steps: 2, prompt: "earlier", messageCount: 4 },
      ],
      undo: async (turnCount) => {
        selected = turnCount;
        return { ok: true, message: `Undid ${turnCount} prompts.` };
      },
    });

    expect((await registry.execute("/undo", ctx().ctx)).data).toEqual({
      kind: "undo-points",
      points: [
        { steps: 1, prompt: "latest", messageCount: 2 },
        { steps: 2, prompt: "earlier", messageCount: 4 },
      ],
    });
    expect((await registry.execute("/undo 2", ctx().ctx)).message).toBe("Undid 2 prompts.");
    expect(selected).toBe(2);
  });

  test("/diff returns structured files with hunks", async () => {
    const registry = registryWithCoreCommands({
      diff: async () => [
        {
          path: "src/a.ts",
          added: 3,
          removed: 1,
          hunks: ["@@ -1 +1 @@", "-old", "+new"],
        },
      ],
    });
    const result = await registry.execute("/diff", ctx().ctx);
    expect(result.data).toEqual({
      kind: "diff",
      files: [
        {
          path: "src/a.ts",
          added: 3,
          removed: 1,
          hunks: ["@@ -1 +1 @@", "-old", "+new"],
        },
      ],
    });
  });

  test("/diff reports a failed diff instead of throwing", async () => {
    const registry = registryWithCoreCommands({
      diff: async () => {
        throw new Error("checkpoint abc is no longer in the store");
      },
    });
    expect((await registry.execute("/diff", ctx().ctx)).message).toBe(
      "Could not show the diff: checkpoint abc is no longer in the store",
    );
  });

  test("/diff with no changes says so", async () => {
    const registry = registryWithCoreCommands({ diff: async () => [] });
    expect((await registry.execute("/diff", ctx().ctx)).message).toBe("No changes yet.");
  });

  test("/undo, /redo and /diff report why checkpoints are off", async () => {
    const reason = "Checkpoints are off here.";
    const registry = registryWithCoreCommands({
      undo: async () => ({ ok: true, message: "undone" }),
      undoPoints: () => [],
      redo: async () => ({ ok: true, message: "redone" }),
      diff: async () => [],
      checkpointUnavailable: reason,
    });
    for (const command of ["/undo", "/undo 1", "/redo", "/diff"]) {
      expect((await registry.execute(command, ctx().ctx)).message).toBe(reason);
    }
  });

  test("surfaces without checkpointing report unavailability", async () => {
    const registry = registryWithCoreCommands();
    expect((await registry.execute("/undo", ctx().ctx)).message).toContain("not available");
  });

  test("/fork lists points and invokes a selected entry", async () => {
    const selected: string[] = [];
    const registry = registryWithCoreCommands({
      forkPoints: () => [{ id: "e1", description: "user · start here" }],
      fork: async (entryId) => {
        selected.push(entryId);
        return { ok: true, message: `Forked from ${entryId}.` };
      },
    });

    const listing = await registry.execute("/fork", ctx().ctx);
    expect(listing.data).toEqual({
      kind: "fork-points",
      points: [{ id: "e1", description: "user · start here" }],
    });
    expect((await registry.execute("/fork e1", ctx().ctx)).message).toBe("Forked from e1.");
    expect(selected).toEqual(["e1"]);
  });
});

describe("background task events reach the stream and wake the agent", () => {
  test("a task exit delivered as a follow-up continues an idle run", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "started the build" }] },
      { content: [{ type: "text", text: "the build finished" }] },
    ]);
    const agent = new Agent({ provider, model: fakeModel });

    // The surface owns the process manager; on exit it forwards the event and
    // queues the notification, which is what wakes the loop.
    let woken = false;
    const stream = agent.stream("start the build");
    const events: string[] = [];
    const pump = (async () => {
      for await (const event of stream) {
        events.push(event.type);
        if (event.type === "message_end" && !woken) {
          woken = true;
          agent.emitTaskEvent({ type: "task_exited", taskId: "task_1", exitCode: 0 });
          agent.followUp("Background task task_1 finished successfully.");
        }
      }
    })();
    await pump;
    await stream.result();

    expect(provider.callCount).toBe(2);
    expect(events).toContain("task_exited");
  });
});
