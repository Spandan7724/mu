import { describe, expect, test } from "bun:test";
import { CheckpointHistory, type CheckpointProvider } from "@mu/core";
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

  async snapshot(label?: string): Promise<string | undefined> {
    const ref = `ref-${this.counter++}`;
    this.snapshots.set(ref, this.state);
    return ref;
  }

  async restore(ref: string): Promise<void> {
    this.restored.push(ref);
    const value = this.snapshots.get(ref);
    if (value !== undefined) this.state = value;
  }

  async diff(fromRef: string, toRef?: string) {
    return this.snapshots.get(fromRef) === this.state
      ? []
      : [{ path: "state.txt", added: 1, removed: 1, hunks: [] }];
  }
}

function writer(checkpoints: MemoryCheckpoints) {
  return tool({
    name: "write",
    description: "writes state",
    inputSchema: z.object({ value: z.string() }),
    execute: ({ value }) => {
      checkpoints.state = value;
      return `wrote ${value}`;
    },
  });
}

describe("CheckpointHistory", () => {
  test("undo returns the state before the last action", () => {
    const history = new CheckpointHistory();
    history.record({ entryId: "e1", ref: "r1", label: "first" });
    history.record({ entryId: "e2", ref: "r2", label: "second" });

    const step = history.popForUndo();
    expect(step?.undone.ref).toBe("r2");
    expect(step?.restoreTo.ref).toBe("r1");
  });

  test("undo of the only action restores that action's own checkpoint", () => {
    const history = new CheckpointHistory();
    history.record({ entryId: "e1", ref: "r1" });
    expect(history.popForUndo()?.restoreTo.ref).toBe("r1");
  });

  test("redo replays what was undone", () => {
    const history = new CheckpointHistory();
    history.record({ entryId: "e1", ref: "r1" });
    history.record({ entryId: "e2", ref: "r2" });
    history.popForUndo();

    expect(history.canRedo).toBe(true);
    expect(history.popForRedo()?.ref).toBe("r2");
    expect(history.canRedo).toBe(false);
  });

  test("a new action clears the redo stack", () => {
    const history = new CheckpointHistory();
    history.record({ entryId: "e1", ref: "r1" });
    history.record({ entryId: "e2", ref: "r2" });
    history.popForUndo();
    history.record({ entryId: "e3", ref: "r3" });
    expect(history.canRedo).toBe(false);
  });

  test("nothing to undo or redo is reported, not thrown", () => {
    const history = new CheckpointHistory();
    expect(history.popForUndo()).toBeUndefined();
    expect(history.popForRedo()).toBeUndefined();
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
});

describe("undo and redo pair workspace with conversation", () => {
  async function sessionWithTwoEdits() {
    const checkpoints = new MemoryCheckpoints();
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { value: "v2" } }] },
      { content: [{ type: "text", text: "first done" }] },
    ]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      tools: [writer(checkpoints)],
      checkpointProvider: checkpoints,
    });
    await agent.run("first change");
    return { agent, checkpoints };
  }

  test("undo restores the workspace and rewinds the transcript together", async () => {
    const { agent, checkpoints } = await sessionWithTwoEdits();
    const messagesBefore = agent.session.messagesAt().length;
    expect(checkpoints.state).toBe("v2");

    const result = await agent.undo();

    expect(result.ok).toBe(true);
    expect(checkpoints.state).toBe("initial"); // workspace went back
    expect(agent.session.messagesAt().length).toBeLessThan(messagesBefore); // and so did the transcript
  });

  test("redo re-applies both sides", async () => {
    const { agent, checkpoints } = await sessionWithTwoEdits();
    await agent.undo();
    expect(checkpoints.state).toBe("initial");

    const result = await agent.redo();
    expect(result.ok).toBe(true);
    expect(checkpoints.restored.length).toBe(2);
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
