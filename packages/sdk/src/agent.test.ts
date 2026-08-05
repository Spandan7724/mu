import { describe, expect, test } from "bun:test";
import {
  type AgentEvent,
  customMessage,
  type PermissionRequest,
  type ProfileRuntime,
  type ProfileRuntimeHost,
  SESSION_VERSION,
  SessionTree,
  userMessage,
} from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { STRUCTURED_OUTPUT_TOOL } from "./structured-output.ts";
import { tool } from "./tool.ts";

function agentWith(provider: FakeProvider, options = {}) {
  return new Agent({ provider, model: fakeModel, ...options });
}

describe("Agent", () => {
  test("run returns the assistant text and totals usage", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hello there" }] }]);
    const result = await agentWith(provider).run("hi");
    expect(result.text).toBe("hello there");
    expect(result.reason).toBe("done");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.costUsd).toBeGreaterThan(0);
  });

  test("resolves credentials for the provider active on each request", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const providers: string[] = [];
    const agent = agentWith(provider, {
      getCredentials: async (providerId: string) => {
        providers.push(providerId);
        return { type: "apiKey" as const, apiKey: "fresh" };
      },
    });
    await agent.run("go");

    expect(await provider.streamOptions[0]?.getCredentials?.()).toEqual({
      type: "apiKey",
      apiKey: "fresh",
    });
    expect(providers).toEqual(["fake"]);
  });

  test("passes the stable session id to every provider request", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const agent = agentWith(provider, { sessionId: "session-for-provider" });

    await agent.run("go");

    expect(provider.streamOptions[0]?.sessionId).toBe("session-for-provider");
  });

  test("a custom tool is registered in a few lines and receives validated args", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "add", arguments: { a: 2, b: 3 } }] },
      { content: [{ type: "text", text: "the sum is 5" }] },
    ]);
    const add = tool({
      name: "add",
      description: "Add two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: ({ a, b }) => `${a + b}`,
    });
    const result = await agentWith(provider, { tools: [add] }).run("add 2 and 3");
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult?.role === "toolResult" && toolResult.content[0]).toEqual({
      type: "text",
      text: "5",
    });
  });

  test("invalid tool args are rejected before execute runs", async () => {
    let ran = false;
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "add", arguments: { a: "x" } }] },
      { content: [{ type: "text", text: "sorry" }] },
    ]);
    const add = tool({
      name: "add",
      description: "Add two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: () => {
        ran = true;
        return "never";
      },
    });
    const result = await agentWith(provider, { tools: [add] }).run("add");
    expect(ran).toBe(false);
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
    expect(
      toolResult?.role === "toolResult" &&
        toolResult.content[0]?.type === "text" &&
        toolResult.content[0].text,
    ).toContain("Invalid arguments");
  });

  test("streaming updates reach the tool's update callback", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "chatty", arguments: {} }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const chatty = tool({
      name: "chatty",
      description: "Streams progress",
      inputSchema: z.object({}),
      execute: (_args, { update }) => {
        update("step 1");
        return "done";
      },
    });
    const agent = agentWith(provider, { tools: [chatty] });
    const stream = agent.stream("go");
    const seen: string[] = [];
    for await (const event of stream) {
      if (event.type === "tool_execution_update") {
        const block = event.partial[0];
        if (block?.type === "text") seen.push(block.text);
      }
    }
    await stream.result();
    expect(seen).toEqual(["step 1"]);
  });
});

describe("structured output", () => {
  const schema = z.object({ city: z.string(), population: z.number() });

  test("returns typed, validated data", async () => {
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: STRUCTURED_OUTPUT_TOOL,
            arguments: { city: "Paris", population: 2100000 },
          },
        ],
      },
    ]);
    const result = await agentWith(provider).run("describe Paris", { output: schema });
    expect(result.output).toEqual({ city: "Paris", population: 2100000 });
    expect(result.output.population).toBeGreaterThan(0);
  });

  test("schema violations are reported back to the model instead of resolving", async () => {
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: STRUCTURED_OUTPUT_TOOL,
            arguments: { city: "Paris", population: "lots" },
          },
        ],
      },
      {
        content: [
          {
            type: "toolCall",
            id: "c2",
            name: STRUCTURED_OUTPUT_TOOL,
            arguments: { city: "Paris", population: 2100000 },
          },
        ],
      },
    ]);
    const result = await agentWith(provider).run("describe Paris", { output: schema });
    expect(result.output).toEqual({ city: "Paris", population: 2100000 });
    const errors = result.messages.filter((m) => m.role === "toolResult" && m.isError);
    expect(errors.length).toBe(1);
  });

  test("throws rather than returning undefined when the model never reports", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "I'd rather chat" }] }]);
    await expect(agentWith(provider).run("describe Paris", { output: schema })).rejects.toThrow(
      "never produced a valid one",
    );
  });
});

describe("budgets", () => {
  test("maxTurns halts with a typed reason", async () => {
    const provider = new FakeProvider(
      Array.from({ length: 6 }, (_, i) => ({
        content: [{ type: "toolCall" as const, id: `c${i}`, name: "noop", arguments: {} }],
      })),
    );
    const noop = tool({
      name: "noop",
      description: "does nothing",
      inputSchema: z.object({}),
      execute: () => "ok",
    });
    const result = await agentWith(provider, {
      tools: [noop],
      budget: { maxTurns: 3 },
    }).run("loop");
    expect(result.reason).toBe("maxTurns");
  });

  test("maxCostUsd halts with a typed reason", async () => {
    const provider = new FakeProvider(
      Array.from({ length: 6 }, (_, i) => ({
        content: [{ type: "toolCall" as const, id: `c${i}`, name: "noop", arguments: {} }],
      })),
    );
    const noop = tool({
      name: "noop",
      description: "does nothing",
      inputSchema: z.object({}),
      execute: () => "ok",
    });
    // Each fake turn costs 0.0001.
    const result = await agentWith(provider, {
      tools: [noop],
      budget: { maxCostUsd: 0.00025 },
    }).run("loop");
    expect(result.reason).toBe("maxCostUsd");
    expect(result.usage.costUsd).toBeGreaterThanOrEqual(0.00025);
  });

  test("maxTokens halts with a typed reason", async () => {
    const provider = new FakeProvider(
      Array.from({ length: 6 }, (_, i) => ({
        content: [{ type: "toolCall" as const, id: `c${i}`, name: "noop", arguments: {} }],
      })),
    );
    const noop = tool({
      name: "noop",
      description: "does nothing",
      inputSchema: z.object({}),
      execute: () => "ok",
    });
    // 15 tokens per fake turn.
    const result = await agentWith(provider, {
      tools: [noop],
      budget: { maxTokens: 30 },
    }).run("loop");
    expect(result.reason).toBe("maxTokens");
  });
});

describe("permissions", () => {
  function dangerProvider() {
    return new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "danger", arguments: { x: 1 } }] },
      { content: [{ type: "text", text: "finished" }] },
    ]);
  }
  function dangerTool(onRun: () => void) {
    return tool({
      name: "danger",
      description: "does something risky",
      inputSchema: z.object({ x: z.number() }),
      execute: () => {
        onRun();
        return "ran";
      },
    });
  }

  test("user-registered tools run without permission config", async () => {
    let ran = false;
    await agentWith(dangerProvider(), {
      tools: [
        dangerTool(() => {
          ran = true;
        }),
      ],
    }).run("go");
    expect(ran).toBe(true);
  });

  test("an ask rule with no callback denies rather than hanging", async () => {
    let ran = false;
    const result = await agentWith(dangerProvider(), {
      tools: [
        dangerTool(() => {
          ran = true;
        }),
      ],
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
    }).run("go");
    expect(ran).toBe(false);
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
  });

  test("onPermission callback resolves an ask", async () => {
    let ran = false;
    const asked: string[] = [];
    await agentWith(dangerProvider(), {
      tools: [
        dangerTool(() => {
          ran = true;
        }),
      ],
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
      onPermission: async (request: PermissionRequest) => {
        asked.push(request.toolName);
        return "allow";
      },
    }).run("go");
    expect(ran).toBe(true);
    expect(asked).toEqual(["danger"]);
  });

  test("tool-owned permission details reach the approval request", async () => {
    let request: PermissionRequest | undefined;
    const danger = tool({
      name: "danger",
      description: "does something risky",
      inputSchema: z.object({ x: z.number() }),
      permissionDetails: ({ x }) => ({
        description: `Change value to ${x}`,
        preview: { kind: "text", lines: [`value: ${x}`] },
      }),
      execute: () => "ran",
    });
    await agentWith(dangerProvider(), {
      tools: [danger],
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
      onPermission: async (asked: PermissionRequest) => {
        request = asked;
        return "allow";
      },
    }).run("go");

    expect(request?.description).toBe("Change value to 1");
    expect(request?.preview).toEqual({ kind: "text", lines: ["value: 1"] });
  });

  test("onPermission denial blocks the call", async () => {
    let ran = false;
    await agentWith(dangerProvider(), {
      tools: [
        dangerTool(() => {
          ran = true;
        }),
      ],
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
      onPermission: async () => "deny",
    }).run("go");
    expect(ran).toBe(false);
  });

  test("allow rules skip the callback entirely", async () => {
    let ran = false;
    let asked = false;
    await agentWith(dangerProvider(), {
      tools: [
        dangerTool(() => {
          ran = true;
        }),
      ],
      permissions: [{ permission: "*", pattern: "*", action: "allow" }],
      onPermission: async () => {
        asked = true;
        return "deny";
      },
    }).run("go");
    expect(ran).toBe(true);
    expect(asked).toBe(false);
  });

  test("tool-owned permission patterns are matched and exposed to approvals", async () => {
    let ran = false;
    let request: PermissionRequest | undefined;
    const danger = tool({
      name: "danger",
      description: "does something risky",
      inputSchema: z.object({ x: z.number() }),
      permissionPattern: ({ x }) => `value ${x}`,
      execute: () => {
        ran = true;
        return "ran";
      },
    });

    await agentWith(dangerProvider(), {
      tools: [danger],
      permissions: [{ permission: "danger", pattern: "value 1", action: "allow" }],
      onPermission: async () => "deny" as const,
    }).run("go");
    expect(ran).toBe(true);

    await agentWith(dangerProvider(), {
      tools: [danger],
      permissions: [{ permission: "danger", pattern: "value 2", action: "allow" }],
      onPermission: async (asked: PermissionRequest) => {
        request = asked;
        return "deny";
      },
    }).run("go");
    expect(request?.pattern).toBe("value 1");
  });

  test("tool-owned permission scopes retain concrete tool rule matching", async () => {
    let ran = 0;
    const inspect = tool({
      name: "danger",
      description: "inspect",
      inputSchema: z.object({ x: z.number() }),
      permissionScope: () => "danger:inspect",
      permissionPattern: ({ x }) => `inspect ${x}`,
      execute: () => {
        ran++;
        return "done";
      },
    });

    await agentWith(dangerProvider(), {
      tools: [inspect],
      permissions: [
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "danger:inspect", pattern: "*", action: "allow" },
      ],
    }).run("go");
    expect(ran).toBe(1);

    let request: PermissionRequest | undefined;
    await agentWith(dangerProvider(), {
      tools: [inspect],
      permissions: [
        { permission: "danger:inspect", pattern: "*", action: "allow" },
        { permission: "danger", pattern: "*", action: "ask" },
      ],
      onPermission: async (asked: PermissionRequest) => {
        request = asked;
        return "deny";
      },
    }).run("go");
    expect(request?.toolName).toBe("danger");
    expect(request?.permission).toBe("danger:inspect");
  });

  test("deny rules block without asking", async () => {
    let asked = false;
    await agentWith(dangerProvider(), {
      tools: [dangerTool(() => {})],
      permissions: [{ permission: "danger", pattern: "*", action: "deny" }],
      onPermission: async () => {
        asked = true;
        return "allow";
      },
    }).run("go");
    expect(asked).toBe(false);
  });

  test("permission events are emitted on the stream", async () => {
    const agent = agentWith(dangerProvider(), {
      tools: [dangerTool(() => {})],
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
      onPermission: async () => "allow" as const,
    });
    const stream = agent.stream("go");
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    await stream.result();
    expect(types).toContain("permission_asked");
    expect(types).toContain("permission_resolved");
  });

  test("permission rules can change between runs", async () => {
    let ran = false;
    const agent = agentWith(dangerProvider(), {
      tools: [
        dangerTool(() => {
          ran = true;
        }),
      ],
      permissions: [{ permission: "*", pattern: "*", action: "deny" }],
    });
    agent.setPermissions([{ permission: "*", pattern: "*", action: "allow" }]);

    await agent.run("go");
    expect(ran).toBe(true);
    expect(agent.permissions).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
  });

  test("permission rules can change while a run is active", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executed: number[] = [];
    const danger = tool({
      name: "danger",
      description: "does something risky",
      inputSchema: z.object({ step: z.number() }),
      execute: async ({ step }) => {
        executed.push(step);
        if (step === 1) {
          markFirstStarted();
          await holdFirst;
        }
        return "ran";
      },
    });
    const provider = new FakeProvider([
      {
        content: [{ type: "toolCall", id: "c1", name: "danger", arguments: { step: 1 } }],
      },
      {
        content: [{ type: "toolCall", id: "c2", name: "danger", arguments: { step: 2 } }],
      },
      { content: [{ type: "text", text: "finished" }] },
    ]);
    const agent = agentWith(provider, {
      tools: [danger],
      permissions: [{ permission: "*", pattern: "*", action: "allow" }],
    });

    const running = agent.run("go");
    await firstStarted;
    agent.setPermissions([{ permission: "*", pattern: "*", action: "deny" }]);
    releaseFirst();
    const result = await running;

    expect(executed).toEqual([1]);
    expect(agent.permissions).toEqual([{ permission: "*", pattern: "*", action: "deny" }]);
    const secondResult = result.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "c2",
    );
    expect(secondResult?.role === "toolResult" && secondResult.isError).toBe(true);
  });

  test("an allowed request can add a rule for later calls in the same run", async () => {
    let asked = 0;
    let agent: Agent;
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "danger", arguments: { x: 1 } }] },
      { content: [{ type: "toolCall", id: "c2", name: "danger", arguments: { x: 1 } }] },
      { content: [{ type: "text", text: "finished" }] },
    ]);
    agent = agentWith(provider, {
      tools: [dangerTool(() => {})],
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
      onPermission: async (request: PermissionRequest) => {
        asked++;
        agent.addPermissionRule({
          permission: request.permission,
          pattern: request.pattern,
          action: "allow",
        });
        return "allow";
      },
    });

    await agent.run("go");
    expect(asked).toBe(1);
  });
});

describe("steering, follow-ups and abort", () => {
  test("send injects a message before the next LLM call", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "noop", arguments: {} }], delayMs: 20 },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const noop = tool({
      name: "noop",
      description: "noop",
      inputSchema: z.object({}),
      execute: () => "ok",
    });
    const agent = agentWith(provider, { tools: [noop] });
    const running = agent.run("start");
    await Bun.sleep(5);
    agent.send("changed my mind");
    await running;

    const second = provider.requests[1];
    const texts = second?.messages.flatMap((m) =>
      m.role === "user" ? m.content.filter((c) => c.type === "text").map((c) => c.text) : [],
    );
    expect(texts).toContain("changed my mind");
  });

  test("followUp wakes a run that would otherwise stop", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first" }], delayMs: 10 },
      { content: [{ type: "text", text: "second" }] },
    ]);
    const agent = agentWith(provider);
    const running = agent.run("go");
    await Bun.sleep(3);
    agent.followUp("actually, continue");
    const result = await running;
    expect(provider.callCount).toBe(2);
    expect(result.text).toBe("second");
  });

  test("multiple follow-ups are delivered one at a time in queue order", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "initial" }], delayMs: 20 },
      { content: [{ type: "text", text: "first follow-up answer" }] },
      { content: [{ type: "text", text: "second follow-up answer" }] },
    ]);
    const agent = agentWith(provider);
    const running = agent.run("go");
    await Bun.sleep(3);
    agent.followUp("first queued message");
    agent.followUp("second queued message");

    const result = await running;

    expect(provider.callCount).toBe(3);
    const secondRequest = JSON.stringify(provider.requests[1]?.messages);
    expect(secondRequest).toContain("first queued message");
    expect(secondRequest).not.toContain("second queued message");
    const thirdRequest = JSON.stringify(provider.requests[2]?.messages);
    expect(thirdRequest).toContain("first queued message");
    expect(thirdRequest).toContain("second queued message");
    expect(result.text).toBe("second follow-up answer");
  });

  test("a queued message can be removed before the loop delivers it", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first" }], delayMs: 20 },
      { content: [{ type: "text", text: "second" }] },
    ]);
    const agent = agentWith(provider);
    const running = agent.run("go");
    await Bun.sleep(3);
    agent.followUp("keep this");
    agent.followUp("edit this");

    expect(agent.removeQueuedMessage("follow-up", "edit this")).toBe(true);
    expect(agent.removeQueuedMessage("follow-up", "not queued")).toBe(false);
    await running;

    expect(provider.callCount).toBe(2);
    const delivered = provider.requests[1]?.messages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        message.content.filter((block) => block.type === "text").map((block) => block.text),
      );
    expect(delivered).toContain("keep this");
    expect(delivered).not.toContain("edit this");
  });

  test("abort ends the run with reason aborted", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "slow" }], delayMs: 60 }]);
    const agent = agentWith(provider);
    const running = agent.run("go");
    setTimeout(() => agent.abort(), 10);
    const result = await running;
    expect(result.reason).toBe("aborted");
  });

  test("a profile follow-up starts a new run while the agent is idle", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "waiting" }] },
      { content: [{ type: "text", text: "background work handled" }] },
    ]);
    let host: ProfileRuntimeHost | undefined;
    const runtime: ProfileRuntime = {
      attach: (attached) => {
        host = attached;
      },
    };
    const agent = agentWith(provider, { runtime });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    await agent.run("start work");
    expect(agent.isRunning).toBe(false);

    host?.emit({
      type: "task_exited",
      taskId: "task_1",
      exitCode: 0,
      status: "exited",
    });
    host?.followUp("Background task task_1 finished successfully.");
    await agent.waitForIdle();

    expect(provider.callCount).toBe(2);
    expect(events.some((event) => event.type === "task_exited")).toBe(true);
    expect(
      provider.requests[1]?.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (content) =>
              content.type === "text" && content.text.includes("task_1 finished successfully"),
          ),
      ),
    ).toBe(true);
    await agent.shutdown();
  });

  test("resize, stop, and awaited shutdown are owned by the agent", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const exited = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime: ProfileRuntime = {
      attach: () => calls.push("attach"),
      resize: (cols, rows) => calls.push(`resize:${cols}x${rows}`),
      stop: () => calls.push("stop"),
      shutdown: async () => {
        calls.push("shutdown:start");
        await exited;
        calls.push("shutdown:end");
      },
    };
    const agent = agentWith(new FakeProvider([{ content: [{ type: "text", text: "unused" }] }]), {
      runtime,
    });

    agent.resize(120, 40);
    const shuttingDown = agent.shutdown();
    await Bun.sleep(0);
    expect(calls).toEqual(["attach", "resize:120x40", "stop", "shutdown:start"]);
    release();
    await shuttingDown;
    expect(calls.at(-1)).toBe("shutdown:end");
  });
});

describe("session persistence", () => {
  test("messages are written to the pluggable store and reload", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "remembered" }] }]);
    const agent = agentWith(provider, { sessionId: "fixed-id" });
    await agent.run("hi");

    expect(agent.sessionId).toBe("fixed-id");
    const messages = agent.session.messagesAt();
    expect(messages.length).toBe(2); // user prompt + assistant reply
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("assistant");
  });

  test("a second run continues the same transcript", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "one" }] },
      { content: [{ type: "text", text: "two" }] },
    ]);
    const agent = agentWith(provider);
    await agent.run("first");
    await agent.run("second");

    // The second request must carry the first exchange.
    const secondRequest = provider.requests[1];
    expect(secondRequest?.messages.length).toBeGreaterThanOrEqual(3);
    expect(agent.session.messagesAt().length).toBe(4);
  });

  test("profile context refreshes once, persists, and runs again after resume", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "one" }] },
      { content: [{ type: "text", text: "two" }] },
      { content: [{ type: "text", text: "three" }] },
    ]);
    let revision = "one";
    const refreshContext = (messages: import("@mu/core").AgentMessage[]) => {
      const type = `instructions-${revision}`;
      return messages.some((message) => message.role === "custom" && message.customType === type)
        ? []
        : [customMessage(type, revision)];
    };
    const first = agentWith(provider, { refreshContext });
    await first.run("first");
    await first.run("second");

    expect(
      provider.requests[0]?.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
    expect(first.session.messagesAt().filter((message) => message.role === "custom")).toHaveLength(
      1,
    );

    revision = "two";
    const resumed = agentWith(provider, { refreshContext });
    resumed.resume(first.session);
    await resumed.run("third");
    const custom = resumed.session.messagesAt().filter((message) => message.role === "custom");
    expect(custom).toHaveLength(2);
    const latest = custom.at(-1);
    expect(
      latest?.role === "custom" && latest.content[0]?.type === "text" && latest.content[0].text,
    ).toBe("two");
  });
});

describe("runtime model and thinking changes", () => {
  test("setModel switches the model used for the next turn", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "second" }] },
    ]);
    const agent = new Agent({ provider, model: fakeModel });
    expect(agent.modelRef).toBe("fake/fake-1");
    expect(agent.contextWindow).toBe(fakeModel.contextWindow);

    await agent.run("one");
    agent.setModel({ ...fakeModel, id: "fake-2", contextWindow: 200_000 });
    expect(agent.modelRef).toBe("fake/fake-2");
    expect(agent.contextWindow).toBe(200_000);

    const result = await agent.run("two");
    const assistants = result.messages.filter((m) => m.role === "assistant");
    expect(assistants.at(-1)?.role === "assistant" && assistants.at(-1)?.model).toBe("fake/fake-2");
  });

  test("setThinking is applied to the next request", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const agent = new Agent({ provider, model: fakeModel });
    agent.setThinking("high");
    expect(agent.thinking).toBe("high");
    await agent.run("go");
  });

  test("uses model-specific defaults and supported thinking levels", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const agent = new Agent({
      provider,
      model: {
        ...fakeModel,
        thinkingLevels: ["low", "medium", "xhigh", "ultra"],
        defaultThinkingLevel: "low",
      },
    });

    expect(agent.thinking).toBe("low");
    expect(agent.thinkingLevels).toEqual(["low", "medium", "xhigh", "ultra"]);
    agent.setThinking("ultra");
    agent.setThinking("minimal");
    expect(agent.thinking).toBe("low");

    await agent.run("go");
    expect(provider.streamOptions[0]?.thinkingLevel).toBe("low");
  });

  test("model switches replace an unsupported effort with the new model's default", () => {
    const provider = new FakeProvider([]);
    const agent = new Agent({
      provider,
      model: {
        ...fakeModel,
        thinkingLevels: ["low", "medium", "xhigh", "ultra"],
        defaultThinkingLevel: "low",
      },
      thinkingLevel: "ultra",
    });

    agent.setModel({
      ...fakeModel,
      id: "fake-2",
      thinkingLevels: ["low", "medium", "high"],
      defaultThinkingLevel: "medium",
    });

    expect(agent.thinking).toBe("medium");
    expect(agent.thinkingLevels).toEqual(["low", "medium", "high"]);
  });

  test("resume adopts a stored session instead of starting fresh", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "second" }] },
    ]);
    const first = new Agent({ provider, model: fakeModel, sessionId: "kept" });
    await first.run("original question");

    const second = new Agent({ provider, model: fakeModel });
    second.resume(first.session);
    expect(second.sessionId).toBe("kept");

    await second.run("follow up");
    // The resumed transcript carries the original exchange forward.
    const sent = provider.requests[1]?.messages ?? [];
    const texts = sent.flatMap((m) =>
      m.role === "user" ? m.content.filter((c) => c.type === "text").map((c) => c.text) : [],
    );
    expect(texts).toContain("original question");
  });

  test("resume rebuilds usage from the resumed branch's own history, discarding this process's own prior spend", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "old answer" }] },
      { content: [{ type: "text", text: "new answer" }] },
    ]);
    const agent = new Agent({ provider, model: fakeModel });
    await agent.run("old prompt");
    expect(agent.usage.inputTokens).toBeGreaterThan(0);

    agent.send("stale steering");
    agent.followUp("stale follow-up");
    agent.requestCompaction();
    const target = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: "target-session",
      createdAt: new Date(0).toISOString(),
      profile: "default",
      environment: {},
    });
    target.appendMessage(userMessage("target history"));
    target.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "target answer" }],
      model: "fake/fake-1",
      usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end",
      timestamp: 1,
    });
    target.append({
      type: "settings-change",
      model: "openai/gpt-5.1",
      thinkingLevel: "high",
    });
    agent.resume(target);

    expect(agent.sessionId).toBe("target-session");
    expect(agent.modelRef).toBe("openai/gpt-5.1");
    expect(agent.thinking).toBe("high");
    // Neither zero (the old bug) nor this process's own pre-resume spend —
    // exactly the resumed branch's own assistant usage.
    expect(agent.usage.inputTokens).toBe(500);
    expect(agent.usage.outputTokens).toBe(50);
    expect(agent.contextTokens).toBeGreaterThan(0);
    expect(agent.contextPercent).toBeGreaterThan(0);
    await agent.run("next prompt");

    const request = JSON.stringify(provider.requests[1]?.messages);
    expect(request).toContain("target history");
    expect(request).toContain("next prompt");
    expect(request).not.toContain("old prompt");
    expect(request).not.toContain("stale steering");
    expect(request).not.toContain("stale follow-up");
    expect(provider.callCount).toBe(2);
    expect(JSON.stringify(target.messagesAt())).not.toContain("new answer");
  });

  test("resume also folds in a past compaction's own usage, and starts at zero with no history", () => {
    const withCompaction = new Agent({ provider: new FakeProvider([]), model: fakeModel });
    const compactedTarget = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: "compacted-target",
      createdAt: new Date(0).toISOString(),
      profile: "default",
      environment: {},
    });
    const kept = compactedTarget.appendMessage(userMessage("kept"));
    compactedTarget.append({
      type: "compaction",
      summary: "earlier turns summarized",
      firstKeptEntryId: kept.id,
      usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    withCompaction.resume(compactedTarget);
    expect(withCompaction.usage.inputTokens).toBe(80);
    expect(withCompaction.usage.outputTokens).toBe(20);

    const fresh = new Agent({ provider: new FakeProvider([]), model: fakeModel });
    const freshTarget = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: "fresh-target",
      createdAt: new Date(0).toISOString(),
      profile: "default",
      environment: {},
    });
    freshTarget.appendMessage(userMessage("no reply yet"));
    fresh.resume(freshTarget);
    expect(fresh.usage.inputTokens).toBe(0);
    expect(fresh.usage.outputTokens).toBe(0);
  });

  test("resume publishes the restored context to idle subscribers", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "answer" }] }]);
    const agent = new Agent({ provider, model: fakeModel });
    const usage: { contextTokens: number; contextPercent: number }[] = [];
    agent.subscribe((event) => {
      if (event.type === "usage_updated") {
        usage.push({ contextTokens: event.contextTokens, contextPercent: event.contextPercent });
      }
    });

    const target = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: "resumed-session",
      createdAt: new Date(0).toISOString(),
      profile: "default",
      environment: {},
    });
    target.appendMessage(userMessage("a".repeat(4000)));
    agent.resume(target);
    await Promise.resolve();

    expect(usage.at(-1)?.contextTokens).toBeGreaterThan(0);
    expect(usage.at(-1)?.contextPercent).toBeGreaterThan(0);

    agent.newSession();
    await Promise.resolve();
    expect(usage.at(-1)).toEqual({ contextTokens: 0, contextPercent: 0 });
  });

  test("resume and a second run are rejected while a run is active", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "active answer" }], delayMs: 40 },
    ]);
    const agent = new Agent({ provider, model: fakeModel });
    const stream = agent.stream("active prompt");
    expect(agent.isRunning).toBe(true);

    const target = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: "must-stay-separate",
      createdAt: new Date(0).toISOString(),
      profile: "default",
      environment: {},
    });
    target.appendMessage(userMessage("target only"));
    expect(() => agent.resume(target)).toThrow("while a run is active");
    await expect(agent.run("overlap")).rejects.toThrow("active run");

    await stream.result();
    expect(agent.isRunning).toBe(false);
    expect(agent.sessionId).not.toBe("must-stay-separate");
    expect(JSON.stringify(target.messagesAt())).not.toContain("active answer");
  });

  test("resume rejects a headerless session without changing the active one", () => {
    const agent = new Agent({ provider: new FakeProvider([]), model: fakeModel });
    const sessionId = agent.sessionId;
    expect(() => agent.resume(new SessionTree())).toThrow("invalid or unsupported");
    expect(agent.sessionId).toBe(sessionId);
  });

  test("newSession starts an independent empty conversation", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "old answer" }] },
      { content: [{ type: "text", text: "new answer" }] },
    ]);
    const agent = new Agent({ provider, model: fakeModel });
    await agent.run("old prompt");
    const oldSessionId = agent.sessionId;
    expect(agent.usage.inputTokens).toBeGreaterThan(0);

    agent.setThinking("high");
    agent.newSession("fresh-session");

    expect(agent.sessionId).toBe("fresh-session");
    expect(agent.session.messagesAt()).toEqual([]);
    expect(agent.usage.inputTokens).toBe(0);
    expect(agent.contextPercent).toBe(0);
    expect(agent.thinking).toBe("high");
    expect(agent.checkpointHistory.canUndo).toBe(false);

    await agent.run("new prompt");
    const request = JSON.stringify(provider.requests[1]?.messages);
    expect(request).toContain("new prompt");
    expect(request).not.toContain("old prompt");
    expect(await agent.sessionStore.load(oldSessionId)).toBeDefined();
  });

  test("newSession is rejected while a run is active", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "answer" }], delayMs: 40 },
    ]);
    const agent = new Agent({ provider, model: fakeModel });
    const stream = agent.stream("active prompt");

    expect(() => agent.newSession()).toThrow("while a run is active");
    await stream.result();
  });

  test("per-run model and tool restrictions fail closed and restore defaults", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "restricted" }] },
      { content: [{ type: "text", text: "default" }] },
      { content: [{ type: "text", text: "no tools" }] },
    ]);
    const read = tool({
      name: "read",
      description: "read",
      inputSchema: z.object({}),
      execute: () => "read",
    });
    const write = tool({
      name: "write",
      description: "write",
      inputSchema: z.object({}),
      execute: () => "write",
    });
    const agent = new Agent({ provider, model: fakeModel, tools: [read, write] });
    const override = { ...fakeModel, id: "command-model" };

    const restricted = await agent.run("review", {
      model: override,
      allowedTools: ["read"],
    });
    const restrictedAnswer = restricted.messages.at(-1);
    expect(restrictedAnswer?.role === "assistant" && restrictedAnswer.model).toBe(
      "fake/command-model",
    );
    expect(provider.requests[0]?.tools?.map((definition) => definition.name)).toEqual(["read"]);
    expect(agent.modelRef).toBe("fake/fake-1");

    await agent.run("normal");
    expect(provider.requests[1]?.tools?.map((definition) => definition.name)).toEqual([
      "read",
      "write",
    ]);
    await agent.run("without tools", { allowedTools: [] });
    expect(provider.requests[2]?.tools).toBeUndefined();
    await expect(agent.run("bad", { allowedTools: ["missing"] })).rejects.toThrow(
      "Unknown allowed tool",
    );
    expect(provider.callCount).toBe(3);
  });
});
