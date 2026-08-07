import { describe, expect, test } from "bun:test";
import {
  MemorySessionStore,
  type PermissionRequest,
  type ProfileRuntime,
  SessionTree,
  type TaskInfo,
  userMessage,
} from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { optionsFromProfile } from "./profile.ts";
import { tool } from "./tool.ts";

function agentWith(provider: FakeProvider, options = {}) {
  return new Agent({ provider, model: fakeModel, ...options });
}

const echo = tool({
  name: "echo",
  description: "Echo text back",
  inputSchema: z.object({ text: z.string() }),
  execute: ({ text }) => text,
});

describe("UserMessage.source", () => {
  test("round-trips through session JSONL", () => {
    const tree = new SessionTree();
    tree.push({
      type: "session",
      version: 1,
      id: "s1",
      createdAt: new Date(0).toISOString(),
      profile: "coding",
      environment: {},
    });
    tree.appendMessage(userMessage("from the phone", "device:abc"));

    const reloaded = SessionTree.fromJsonl(tree.toJsonl());
    const message = reloaded.messagesAt()[0];

    expect(message?.role).toBe("user");
    expect(message && "source" in message ? message.source : undefined).toBe("device:abc");
  });

  test("run records the source on the prompt message", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const agent = agentWith(provider);

    await agent.run("do it", { source: "device:abc" });

    const first = agent.session.messagesAt()[0];
    expect(first && "source" in first ? first.source : undefined).toBe("device:abc");
  });

  test("steering and follow-up carry their source into the transcript", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "hi" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const agent = agentWith(provider, { tools: [echo] });
    agent.send("also this", "device:abc");

    await agent.run("start");

    const steered = agent.session
      .messagesAt()
      .find((message) => message.role === "user" && "source" in message && message.source);
    expect(steered && "source" in steered ? steered.source : undefined).toBe("device:abc");
  });

  test("a message with no source stays free of the field", () => {
    expect(userMessage("plain")).not.toHaveProperty("source");
  });
});

describe("session header", () => {
  const profile = {
    name: "coding",
    toolset: [],
    promptFor: () => [{ text: "system" }],
    permissionDefaults: [],
    permissionModes: [
      { id: "default", label: "default", description: "", rules: [] },
      { id: "strict", label: "strict", description: "", tone: "restrictive" as const, rules: [] },
    ],
    environment: () => ({ root: "/home/x/my-app", branch: "remote" }),
  };

  test("persists the profile environment at construction", async () => {
    const options = await optionsFromProfile(profile, "fake/fake");
    const agent = new Agent({ ...options, provider: new FakeProvider([]), model: fakeModel });

    expect(agent.session.header?.environment).toEqual({
      root: "/home/x/my-app",
      branch: "remote",
    });
    expect(agent.session.header?.profile).toBe("coding");
  });

  test("persists it again for a session started later in the same process", async () => {
    const options = await optionsFromProfile(profile, "fake/fake");
    const agent = new Agent({ ...options, provider: new FakeProvider([]), model: fakeModel });

    agent.newSession();

    expect(agent.session.header?.environment).toEqual({
      root: "/home/x/my-app",
      branch: "remote",
    });
    expect(agent.session.header?.profile).toBe("coding");
  });

  test("a stored session reports its real root and branch on reload", async () => {
    const store = new MemorySessionStore();
    const options = await optionsFromProfile(profile, "fake/fake");
    const agent = new Agent({
      ...options,
      provider: new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]),
      model: fakeModel,
      session: store,
    });
    await agent.run("hi");

    const reloaded = await store.load(agent.sessionId);

    expect(reloaded?.header?.environment).toEqual({
      root: "/home/x/my-app",
      branch: "remote",
    });
  });
});

describe("ProfileRuntime.list", () => {
  test("enumerates background tasks without replaying events", () => {
    const tasks: TaskInfo[] = [
      {
        id: "task_1",
        command: "bun test --watch",
        status: "running",
        exitCode: null,
        startedAt: 0,
        outputBytes: 0,
        truncated: false,
        detached: false,
      },
      {
        id: "task_2",
        command: "bun run build",
        status: "exited",
        exitCode: 0,
        startedAt: 0,
        endedAt: 1,
        outputBytes: 12,
        truncated: false,
        detached: false,
      },
    ];
    const runtime: ProfileRuntime = { attach: () => {}, list: () => tasks };
    const agent = agentWith(new FakeProvider([]), { runtime });

    expect(agent.tasks).toEqual(tasks);
    expect(agent.state().tasks.map((task) => task.id)).toEqual(["task_1", "task_2"]);
  });

  test("a runtime without list reports no tasks rather than failing", () => {
    const agent = agentWith(new FakeProvider([]), { runtime: { attach: () => {} } });
    expect(agent.tasks).toEqual([]);
  });
});

describe("host-owned input queue", () => {
  test("queued text is visible through state and withdrawable", () => {
    const agent = agentWith(new FakeProvider([]));

    agent.send("steer me");
    agent.followUp("later");

    expect(agent.state().queuedInputs).toEqual([
      { kind: "steer", text: "steer me" },
      { kind: "follow-up", text: "later" },
    ]);

    expect(agent.removeQueuedMessage("steer", "steer me")).toBe(true);
    expect(agent.state().queuedInputs).toEqual([{ kind: "follow-up", text: "later" }]);

    expect(agent.removeQueuedMessage("follow-up", "nothing like this")).toBe(false);
  });

  test("delivered steering leaves the queue", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "hi" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const agent = agentWith(provider, { tools: [echo] });
    agent.send("mid-run");
    expect(agent.queuedInputs).toHaveLength(1);

    await agent.run("start");

    expect(agent.queuedInputs).toEqual([]);
  });
});

describe("Agent.state", () => {
  test("composes the footer values the surface renders", () => {
    const agent = agentWith(new FakeProvider([]), {
      sessionId: "s-state",
      permissionModes: [{ id: "strict", label: "strict", description: "", rules: [] }],
    });
    agent.setPermissionMode(agent.permissionModes[0]);

    const state = agent.state();

    expect(state.sessionId).toBe("s-state");
    expect(state.model).toBe(agent.modelRef);
    expect(state.thinkingLevel).toBe(agent.thinking);
    expect(state.thinkingLevels).toEqual(agent.thinkingLevels);
    expect(state.permissionMode?.id).toBe("strict");
    expect(state.running).toBe(false);
    expect(state.compacting).toBe(false);
    expect(state.usage).toEqual(agent.usage);
    expect(state.contextPercent).toBe(agent.contextPercent);
    expect(state.contextTokens).toBe(agent.contextTokens);
  });

  test("a snapshot taken mid-ask carries the approval state", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "hi" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    let asked: PermissionRequest | undefined;
    let release: (() => void) | undefined;
    const agent = agentWith(provider, {
      tools: [echo],
      permissions: [{ permission: "echo", pattern: "*", action: "ask" }],
      onPermission: (request: PermissionRequest) =>
        new Promise<"allow" | "deny">((resolve) => {
          asked = request;
          release = () => resolve("allow");
        }),
    });

    const run = agent.run("start");
    while (!asked) await Bun.sleep(1);

    const mid = agent.state();
    expect(mid.running).toBe(true);
    expect(mid.pendingPermissions.map((request) => request.id)).toEqual([asked.id]);
    expect(mid.pendingPermissions[0]?.toolName).toBe("echo");
    expect(mid.messages.some((message) => message.role === "user")).toBe(true);

    release?.();
    await run;

    expect(agent.state().pendingPermissions).toEqual([]);
    expect(agent.state().running).toBe(false);
  });

  test("messages match the active branch of the session tree", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hello" }] }]);
    const agent = agentWith(provider);
    await agent.run("hi");

    expect(agent.state().messages).toEqual(agent.session.messagesAt());
  });
});
