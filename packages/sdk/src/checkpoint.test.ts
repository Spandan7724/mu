import { describe, expect, test } from "bun:test";
import {
  type CheckpointEntry,
  CheckpointHistory,
  type CheckpointProvider,
  MemorySessionStore,
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

  async diff(fromRef: string) {
    return this.snapshots.get(fromRef) === this.state
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

describe("snapshot before a mutating batch", () => {
  test("a mutating tool call is snapshotted first", async () => {
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

  test("read-only tools are not snapshotted", async () => {
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

    expect(agent.checkpointHistory.all().length).toBe(0);
  });

  test("mutation metadata works for non-coding and argument-dependent tools", async () => {
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

  test("a denied mutating call does not create a checkpoint", async () => {
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
    expect(agent.checkpointHistory.all()).toEqual([]);
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

  test("undo with no checkpoints says so rather than failing", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      checkpointProvider: new MemoryCheckpoints(),
    });
    await agent.run("nothing to change");
    const result = await agent.undo();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Nothing to undo");
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

    agent.fork((forkPoint as { id: string }).id);
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
      undo: async () => ({ ok: true, message: "Undid the last step." }),
      redo: async () => ({ ok: true, message: "Redid the step." }),
    });
    expect((await registry.execute("/undo", ctx().ctx)).message).toBe("Undid the last step.");
    expect((await registry.execute("/redo", ctx().ctx)).message).toBe("Redid the step.");
  });

  test("/diff lists changed files with counts", async () => {
    const registry = registryWithCoreCommands({
      diff: async () => [{ path: "src/a.ts", added: 3, removed: 1 }],
    });
    const harness = ctx();
    await registry.execute("/diff", harness.ctx);
    expect(harness.printed[0]).toBe("src/a.ts · +3 −1");
  });

  test("/diff with no changes says so", async () => {
    const registry = registryWithCoreCommands({ diff: async () => [] });
    expect((await registry.execute("/diff", ctx().ctx)).message).toBe("No changes yet.");
  });

  test("surfaces without checkpointing report unavailability", async () => {
    const registry = registryWithCoreCommands();
    expect((await registry.execute("/undo", ctx().ctx)).message).toContain("not available");
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
