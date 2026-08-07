import { describe, expect, test } from "bun:test";
import {
  type AgentEvent,
  CommandRegistry,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRule,
} from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { FULL_FIDELITY, type Origin } from "@mu/protocol";
import { Agent } from "mu";
import { canSelectMode, narrowForRemote, rulesForOrigin } from "./permissions.ts";
import { PowerAssertion } from "./power.ts";
import { EventRing } from "./ring.ts";
import { SessionHost, type SubscriptionSink } from "./session-host.ts";

const LOCAL: Origin = { kind: "local" };
const PHONE: Origin = { kind: "remote", deviceId: "d1", deviceName: "pixel" };

const MODES: PermissionMode[] = [
  { id: "strict", label: "strict", description: "", tone: "restrictive", rules: [] },
  { id: "default", label: "default", description: "", rules: [] },
  { id: "permissive", label: "permissive", description: "", tone: "permissive", rules: [] },
  {
    id: "yolo",
    label: "yolo",
    description: "",
    tone: "unrestricted",
    rules: [{ permission: "*", pattern: "*", action: "allow" }],
  },
];

const gatedTool = {
  name: "gated",
  description: "needs approval",
  inputSchema: { type: "object" },
  execute: async () => ({ content: [{ type: "text" as const, text: "ran" }] }),
};

function collector() {
  const events: { seq: number; event: AgentEvent }[] = [];
  const gaps: { from: number; to: number }[] = [];
  const sink: SubscriptionSink = {
    event: (frame) => events.push(frame),
    gap: (from, to) => gaps.push({ from, to }),
  };
  return { events, gaps, sink, types: () => events.map((frame) => frame.event.type) };
}

function makeHost(
  provider: FakeProvider,
  options: {
    permissions?: PermissionRule[];
    tools?: unknown[];
    commands?: CommandRegistry;
    power?: PowerAssertion;
    ringEntries?: number;
    remoteOverlay?: PermissionRule[];
  } = {},
) {
  let host: SessionHost | undefined;
  const agent = new Agent({
    provider,
    model: fakeModel,
    permissionModes: MODES,
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.tools ? { tools: options.tools as never } : {}),
    onPermission: (request: PermissionRequest) =>
      host ? host.onPermission(request) : Promise.resolve<"allow" | "deny">("deny"),
  });
  host = new SessionHost({
    agent,
    workspace: { name: "app", root: "/home/x/app" },
    ...(options.permissions ? { basePermissions: options.permissions } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
    ...(options.power ? { power: options.power } : {}),
    ...(options.ringEntries !== undefined ? { ringEntries: options.ringEntries } : {}),
    ...(options.remoteOverlay ? { remoteOverlay: options.remoteOverlay } : {}),
  });
  return { agent, host };
}

describe("multi-client semantics", () => {
  test("two clients drive one session and both see every event", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "answer" }] }]);
    const { host } = makeHost(provider);
    const a = collector();
    const b = collector();
    host.subscribe(FULL_FIDELITY, a.sink);
    host.subscribe(FULL_FIDELITY, b.sink);

    expect(await host.apply({ k: "input", text: "go" }, LOCAL)).toEqual({
      ok: true,
      data: { started: true },
    });
    await host.idle();

    expect(a.types()).toEqual(b.types());
    expect(a.types()).toContain("agent_end");
    // Sequence numbers are per session, monotonic and gap-free.
    expect(a.events.map((frame) => frame.seq)).toEqual(a.events.map((_, index) => index + 1));
  });

  test("concurrent steering is delivered in the order the ops arrived", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "gated", arguments: {} }], delayMs: 20 },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const { agent, host } = makeHost(provider, { tools: [gatedTool] });

    await host.apply({ k: "input", text: "go" }, LOCAL);
    await host.apply({ k: "steer", text: "from the terminal" }, LOCAL);
    await host.apply({ k: "steer", text: "from the phone" }, PHONE);
    await host.idle();

    // Whichever op reached the host first is ahead in the transcript, and each
    // keeps the provenance of the client that sent it.
    const users = agent.session
      .messagesAt()
      .filter((message) => message.role === "user")
      .map((message) => ({
        text: message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
        source: "source" in message ? message.source : undefined,
      }));
    expect(users).toEqual([
      { text: "go", source: undefined },
      { text: "from the terminal", source: undefined },
      { text: "from the phone", source: "remote:pixel" },
    ]);
  });

  test("first responder wins and the other client is told it is resolved", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "gated", arguments: {} }], delayMs: 5 },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const { agent, host } = makeHost(provider, {
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
      tools: [gatedTool],
    });
    const terminal = collector();
    const phone = collector();
    host.subscribe(FULL_FIDELITY, terminal.sink);
    host.subscribe(FULL_FIDELITY, phone.sink);

    await host.apply({ k: "input", text: "go" }, LOCAL);
    while (agent.pendingPermissions.length === 0) await Bun.sleep(1);
    const requestId = agent.pendingPermissions[0]?.id as string;

    // The terminal answers. The phone's later reply finds nothing to resolve.
    const first = await host.apply({ k: "permission_reply", requestId, outcome: "allow" }, LOCAL);
    const second = await host.apply({ k: "permission_reply", requestId, outcome: "deny" }, PHONE);

    expect(first).toEqual({ ok: true, data: { resolved: true } });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error.code).toBe("unknown_request");

    await host.idle();

    // The resolution reaches the client that did not answer it.
    const resolvedOnPhone = phone.events.filter(
      (frame) => frame.event.type === "permission_resolved",
    );
    expect(resolvedOnPhone).toHaveLength(1);
    expect(resolvedOnPhone[0]?.event).toEqual({
      type: "permission_resolved",
      requestId,
      outcome: "allow",
    });
    expect(terminal.types()).toEqual(phone.types());
  });

  test("an ask that arrived before a client attached is still in the snapshot", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "gated", arguments: {} }], delayMs: 5 },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const { agent, host } = makeHost(provider, {
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
      tools: [gatedTool],
    });

    await host.apply({ k: "input", text: "go" }, LOCAL);
    while (agent.pendingPermissions.length === 0) await Bun.sleep(1);

    // Nobody was listening when it was asked; the phone connects now.
    const late = host.state();
    expect(late.pendingPermissions).toHaveLength(1);

    await host.apply(
      {
        k: "permission_reply",
        requestId: late.pendingPermissions[0]?.id as string,
        outcome: "deny",
      },
      PHONE,
    );
    await host.idle();
  });
});

describe("reconnection", () => {
  test("re-attaching with sinceSeq replays exactly what was missed", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "answer" }] }]);
    const { host } = makeHost(provider);
    const first = collector();
    const subscription = host.subscribe(FULL_FIDELITY, first.sink);

    await host.apply({ k: "input", text: "go" }, LOCAL);
    await host.idle();
    subscription.close();

    const missedFrom = 2;
    const second = collector();
    host.subscribe(FULL_FIDELITY, second.sink, missedFrom);

    expect(second.gaps).toEqual([]);
    expect(second.events).toEqual(first.events.slice(missedFrom));
  });

  test("an out-of-range sinceSeq produces a gap rather than silence", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "answer" }] }]);
    const { host } = makeHost(provider, { ringEntries: 2 });

    await host.apply({ k: "input", text: "go" }, LOCAL);
    await host.idle();

    const late = collector();
    host.subscribe(FULL_FIDELITY, late.sink, 0);

    expect(late.events).toEqual([]);
    expect(late.gaps).toHaveLength(1);
    expect(late.gaps[0]?.from).toBe(1);
    // A fresh snapshot is what the client falls back to, and it is complete.
    expect(host.state().messages.length).toBeGreaterThan(0);
  });

  test("the ring keeps sequence numbers monotonic across an overrun", () => {
    const ring = new EventRing(3);
    for (let index = 0; index < 10; index++) ring.push({ type: "turn_start" });

    expect(ring.seq).toBe(10);
    expect(ring.oldestSeq).toBe(8);
    expect(ring.since(9)?.map((frame) => frame.seq)).toEqual([10]);
    expect(ring.since(10)).toEqual([]);
    expect(ring.since(6)).toBeUndefined();
  });
});

describe("blobs", () => {
  test("an over-budget result is stubbed and retrievable with fetch_blob", async () => {
    const big = "z".repeat(40_000);
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "big", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const { host } = makeHost(provider, {
      tools: [
        {
          name: "big",
          description: "returns a lot",
          inputSchema: { type: "object" },
          execute: async () => ({ content: [{ type: "text" as const, text: big }] }),
        },
      ],
    });
    const phone = collector();
    host.subscribe({ updates: "full", maxInlineBytes: 1024 }, phone.sink);

    await host.apply({ k: "input", text: "go" }, LOCAL);
    await host.idle();

    const end = phone.events.find((frame) => frame.event.type === "tool_execution_end");
    const block =
      end?.event.type === "tool_execution_end"
        ? (end.event.result.content[0] as { blobRef?: string; truncated?: boolean })
        : undefined;
    expect(block?.truncated).toBe(true);

    const fetched = await host.apply({ k: "fetch_blob", ref: block?.blobRef as string }, PHONE);
    expect(fetched.ok).toBe(true);
    expect(fetched.ok && (fetched.data as { content: { text: string }[] }).content[0]?.text).toBe(
      big,
    );
  });

  test("an aged-out blob degrades to 'no longer available' rather than crashing", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const { host } = makeHost(provider);

    const result = await host.apply({ k: "fetch_blob", ref: "b_gone" }, PHONE);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toEqual({
      code: "unknown_blob",
      message: "no longer available",
    });
  });
});

describe("remote may only narrow", () => {
  test("blanket allows are dropped for a remote origin and kept for a local one", () => {
    const rules: PermissionRule[] = [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "git status", action: "allow" },
      { permission: "*", pattern: "*", action: "allow" },
    ];

    expect(rulesForOrigin(LOCAL, rules)).toEqual(rules);
    expect(rulesForOrigin(PHONE, rules)).toEqual([
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "git status", action: "allow" },
    ]);
  });

  test("narrowing never introduces an allow that was not already there", () => {
    const rules: PermissionRule[] = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "write", pattern: "*", action: "ask" },
    ];
    const narrowed = narrowForRemote(rules, [{ permission: "bash", pattern: "*", action: "ask" }]);

    for (const rule of narrowed) {
      if (rule.action !== "allow") continue;
      expect(rules).toContainEqual(rule);
    }
    expect(narrowed).not.toContainEqual({ permission: "*", pattern: "*", action: "allow" });
  });

  test("--allow-all does not apply to a remote-originated run", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "gated", arguments: {} }], delayMs: 5 },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const { agent, host } = makeHost(provider, {
      permissions: [{ permission: "*", pattern: "*", action: "allow" }],
      tools: [gatedTool],
    });

    await host.apply({ k: "input", text: "go" }, PHONE);
    // Under --allow-all this would have run unasked.
    while (agent.pendingPermissions.length === 0 && agent.isRunning) await Bun.sleep(1);
    expect(agent.pendingPermissions).toHaveLength(1);

    await host.apply(
      {
        k: "permission_reply",
        requestId: agent.pendingPermissions[0]?.id as string,
        outcome: "deny",
      },
      PHONE,
    );
    await host.idle();
    // The narrowing is scoped to the run, not left behind on the Agent.
    expect(agent.permissions).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
  });

  test("yolo is unreachable from a remote origin whatever the active mode", async () => {
    const provider = new FakeProvider([]);
    const { agent, host } = makeHost(provider);
    agent.setPermissionMode(MODES[3]);

    const result = await host.apply({ k: "set_permission_mode", modeId: "yolo" }, PHONE);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("not_permitted");
    expect(canSelectMode(PHONE, MODES[3], MODES[3] as PermissionMode)).toBe(false);
  });

  test("a remote origin may go stricter but not looser", async () => {
    const provider = new FakeProvider([]);
    const { agent, host } = makeHost(provider);
    agent.setPermissionMode(MODES[1]);

    expect((await host.apply({ k: "set_permission_mode", modeId: "strict" }, PHONE)).ok).toBe(true);
    expect(agent.permissionMode?.id).toBe("strict");

    const looser = await host.apply({ k: "set_permission_mode", modeId: "permissive" }, PHONE);
    expect(looser.ok).toBe(false);
    expect(looser.ok === false && looser.error.code).toBe("not_permitted");

    // The local surface is unaffected by any of it.
    expect((await host.apply({ k: "set_permission_mode", modeId: "permissive" }, LOCAL)).ok).toBe(
      true,
    );
  });

  test("always-allow from a phone writes the same explicit rule it would locally", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "gated", arguments: {} }], delayMs: 5 },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const remembered: { permission: string; pattern: string }[] = [];
    let host: SessionHost | undefined;
    const agent = new Agent({
      provider,
      model: fakeModel,
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
      tools: [gatedTool as never],
      onPermission: (request) =>
        host ? host.onPermission(request) : Promise.resolve<"allow" | "deny">("deny"),
    });
    host = new SessionHost({
      agent,
      workspace: { name: "app", root: "/home/x/app" },
      basePermissions: [{ permission: "*", pattern: "*", action: "ask" }],
      rememberPermission: (permission, pattern) => {
        remembered.push({ permission, pattern });
      },
    });

    await host.apply({ k: "input", text: "go" }, PHONE);
    while (agent.pendingPermissions.length === 0) await Bun.sleep(1);
    const request = agent.pendingPermissions[0] as PermissionRequest;
    await host.apply(
      { k: "permission_reply", requestId: request.id, outcome: "allow", remember: true },
      PHONE,
    );
    await host.idle();

    expect(remembered).toEqual([{ permission: request.permission, pattern: request.pattern }]);
    expect(agent.permissions).toContainEqual({
      permission: request.permission,
      pattern: request.pattern,
      action: "allow",
    });
  });
});

describe("provenance and audit", () => {
  test("a remote op is recorded as a custom session entry with its device id", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const { agent, host } = makeHost(provider);

    await host.apply({ k: "input", text: "from the phone" }, PHONE);
    await host.idle();
    await host.apply({ k: "abort" }, LOCAL);

    const audited = agent.session
      .all()
      .filter((entry) => entry.type === "custom" && entry.customType === "remote-op");
    expect(audited).toHaveLength(1);
    expect(audited[0]?.type === "custom" && audited[0].data).toMatchObject({
      op: "input",
      deviceId: "d1",
    });
  });

  test("a remote message records where it came from; a local one is unmarked", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const { agent, host } = makeHost(provider);

    await host.apply({ k: "input", text: "from the phone" }, PHONE);
    await host.idle();

    const first = agent.session.messagesAt()[0];
    expect(first && "source" in first ? first.source : undefined).toBe("remote:pixel");

    agent.newSession();
    await host.apply({ k: "input", text: "from the terminal" }, LOCAL);
    await host.idle();
    const local = agent.session.messagesAt()[0];
    expect(local).not.toHaveProperty("source");
  });
});

describe("ops", () => {
  test("a second input is refused as busy", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "one" }], delayMs: 30 },
      { content: [{ type: "text", text: "two" }] },
    ]);
    const { host } = makeHost(provider);

    await host.apply({ k: "input", text: "first" }, LOCAL);
    const second = await host.apply({ k: "input", text: "second" }, LOCAL);

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error.code).toBe("busy");
    await host.idle();
    expect(provider.callCount).toBe(1);
  });

  test("queued input is withdrawable through the host", async () => {
    const provider = new FakeProvider([]);
    const { agent, host } = makeHost(provider);

    await host.apply({ k: "steer", text: "wait" }, PHONE);
    expect(agent.queuedInputs).toEqual([{ kind: "steer", text: "wait" }]);

    expect(await host.apply({ k: "withdraw_queued", kind: "steer", text: "wait" }, LOCAL)).toEqual({
      ok: true,
      data: { removed: true },
    });
    expect(agent.queuedInputs).toEqual([]);
  });

  test("commands run through the host's registry", async () => {
    const provider = new FakeProvider([]);
    const commands = new CommandRegistry();
    commands.register({
      name: "hello",
      description: "greet",
      run: () => ({ handled: true, message: "hi" }),
    });
    const { host } = makeHost(provider, { commands });

    const result = await host.apply({ k: "command", text: "/hello" }, PHONE);
    expect(result.ok && (result.data as { message: string }).message).toBe("hi");
  });

  test("task_list and task_kill reach the profile runtime", async () => {
    const provider = new FakeProvider([]);
    const killed: string[] = [];
    const agent = new Agent({
      provider,
      model: fakeModel,
      runtime: {
        attach: () => {},
        list: () => [
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
        ],
        kill: (taskId) => {
          killed.push(taskId);
          return true;
        },
      },
    });
    const host = new SessionHost({ agent, workspace: { name: "app", root: "/home/x/app" } });

    expect(await host.apply({ k: "task_list" }, PHONE)).toEqual({
      ok: true,
      data: { tasks: [{ taskId: "task_1", command: "bun test --watch", running: true }] },
    });
    expect(await host.apply({ k: "task_kill", taskId: "task_1" }, PHONE)).toEqual({
      ok: true,
      data: { killed: true },
    });
    expect(killed).toEqual(["task_1"]);
  });

  test("resuming an unknown session is refused by id", async () => {
    const provider = new FakeProvider([]);
    const { host } = makeHost(provider);
    const result = await host.apply({ k: "session_resume", sessionId: "nope" }, LOCAL);
    expect(result.ok === false && result.error.code).toBe("unknown_session");
  });
});

describe("power assertion", () => {
  test("is held for a run and released on completion", async () => {
    const spawned: string[][] = [];
    let killed = 0;
    const power = new PowerAssertion({
      platform: "linux",
      spawn: (command) => {
        spawned.push(command);
        return {
          kill: () => {
            killed += 1;
          },
        };
      },
    });
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }], delayMs: 10 }]);
    const { host } = makeHost(provider, { power });

    expect(power.held as boolean).toBe(false);
    await host.apply({ k: "input", text: "go" }, LOCAL);
    while (!power.held) await Bun.sleep(1);
    expect(spawned[0]?.[0]).toBe("systemd-inhibit");

    await host.idle();
    expect(power.held as boolean).toBe(false);
    expect(killed).toBe(1);
  });

  test("is released on abort too", async () => {
    const power = new PowerAssertion({
      platform: "darwin",
      spawn: () => ({ kill: () => {} }),
    });
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "slow" }], delayMs: 200 },
    ]);
    const { host } = makeHost(provider, { power });

    await host.apply({ k: "input", text: "go" }, LOCAL);
    while (!power.held) await Bun.sleep(1);

    await host.apply({ k: "abort" }, LOCAL);
    await host.idle();

    expect(power.held as boolean).toBe(false);
  });

  test("an unsupported platform is a no-op, never a failure", () => {
    const power = new PowerAssertion({
      platform: "freebsd",
      spawn: () => {
        throw new Error("should not be called");
      },
    });
    power.acquire();
    expect(power.held).toBe(false);
    power.release();
  });
});
