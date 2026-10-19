import { describe, expect, test } from "bun:test";
import type { LlmContext, ModelInfo, Provider, StreamOpts } from "@mu/ai";
import {
  type AgentMessage,
  type AnyTool,
  type CustomMessage,
  ExtensionHost,
  MemorySessionStore,
  type PermissionRule,
} from "@mu/core";
import { FakeProvider, fakeModel, type ScriptedTurn } from "@mu/core/testing/fake-provider.ts";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { type BackgroundSubagentResultDetails, subagentsExtension } from "./subagents.ts";
import { tool } from "./tool.ts";

type Turn = ScriptedTurn | ((ctx: LlmContext) => ScriptedTurn);

// Routes parent and child requests to separate scripts so concurrent agents
// cannot consume each other's turns. A function turn sees the request it answers.
class Scripted {
  readonly requests: LlmContext[] = [];
  private index = 0;

  constructor(private readonly turns: Turn[]) {}

  get callCount(): number {
    return this.index;
  }

  next(model: ModelInfo, ctx: LlmContext, opts?: StreamOpts) {
    this.requests.push(structuredClone(ctx));
    const turn = this.turns[this.index++] ?? { content: [{ type: "text", text: "" }] };
    return new FakeProvider([typeof turn === "function" ? turn(ctx) : turn]).stream(
      model,
      ctx,
      opts,
    );
  }
}

function routed(parent: Scripted, child: Scripted): Provider {
  return {
    id: "fake",
    stream: (model, ctx, opts) =>
      (isChild(ctx) ? child : parent).next(model, ctx, opts as StreamOpts | undefined),
  };
}

function isChild(ctx: LlmContext): boolean {
  return (ctx.systemPrompt ?? []).some((section) => section.text.includes("task subagent"));
}

function contextText(ctx: LlmContext): string {
  return JSON.stringify(ctx.messages);
}

function subagentId(ctx: LlmContext): string {
  const match = /sa-[0-9a-f]{6}/.exec(contextText(ctx));
  if (!match) throw new Error("no subagent id in context");
  return match[0];
}

function call(id: string, name: string, args: Record<string, unknown>): ScriptedTurn {
  return { content: [{ type: "toolCall", id, name, arguments: args }] };
}

function text(value: string, extra: Partial<ScriptedTurn> = {}): ScriptedTurn {
  return { content: [{ type: "text", text: value }], ...extra };
}

function background(id = "bg-1"): ScriptedTurn {
  return call(id, "task", {
    description: "background work",
    prompt: "Do the work",
    run_in_background: true,
  });
}

function records(messages: AgentMessage[]): CustomMessage[] {
  return messages.filter(
    (message): message is CustomMessage =>
      message.role === "custom" && message.customType === "background_subagent",
  );
}

// A child tool that holds the child mid-turn until released or aborted.
function gateTool() {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = tool({
    name: "gate",
    description: "wait",
    inputSchema: z.object({}),
    execute: async (_args, { signal }) => {
      entered();
      await Promise.race([
        opened,
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
      ]);
      return signal.aborted ? "aborted" : "opened";
    },
  });
  return { gate, release, reached };
}

async function setup(
  parentTurns: Turn[],
  childTurns: Turn[],
  options: {
    tools?: AnyTool[];
    store?: MemorySessionStore;
    permissions?: PermissionRule[];
    budget?: { maxTokens?: number };
  } = {},
) {
  const parentScript = new Scripted(parentTurns);
  const childScript = new Scripted(childTurns);
  const host = new ExtensionHost();
  const parent = new Agent({
    provider: routed(parentScript, childScript),
    model: fakeModel,
    extensions: host,
    tools: options.tools ?? [],
    ...(options.store ? { session: options.store } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
  });
  await host.register(subagentsExtension({ parent: () => parent }));
  return { parent, parentScript, childScript };
}

describe("background subagents", () => {
  test("the parent keeps working and the result arrives as a follow-up turn", async () => {
    const { parent, parentScript } = await setup(
      [background(), text("Working meanwhile."), text("Integrated the result.")],
      [text("Child finished the work.", { delayMs: 40, usage: { inputTokens: 100 } })],
    );

    const result = await parent.run("delegate in the background");

    expect(result.text).toBe("Working meanwhile.");
    expect(parent.backgroundWork).toHaveLength(1);
    await parent.waitForSettled();

    expect(parent.backgroundWork).toEqual([]);
    expect(parentScript.callCount).toBe(3);
    const wake = contextText(parentScript.requests[2] as LlmContext);
    expect(wake).toContain("<background_subagent>");
    expect(wake).toContain("Child finished the work.");
    const [record] = records(parent.session.messagesAt());
    expect(record?.usage?.inputTokens).toBe(100);
    expect((record?.details as BackgroundSubagentResultDetails).status).toBe("done");
    expect(parent.usage.inputTokens).toBe(130);

    const restored = new Agent({ provider: new FakeProvider([]), model: fakeModel });
    restored.resume(parent.session);
    expect(restored.usage.inputTokens).toBe(130);
  });

  test("send steers the running child and a result read through status is not repeated", async () => {
    const { gate, release, reached } = gateTool();
    const { parent, parentScript, childScript } = await setup(
      [
        background(),
        (ctx) =>
          call("send-1", "subagent_send", { subagentId: subagentId(ctx), message: "Also do Y" }),
        (ctx) =>
          call("status-1", "subagent_status", { subagentId: subagentId(ctx), waitSeconds: 5 }),
        text("Reported."),
      ],
      [call("gate-1", "gate", {}), text("Did X and Y.")],
      { tools: [gate] },
    );
    parent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.result.toolName === "subagent_send") {
        release();
      }
    });

    const running = parent.run("delegate");
    await reached;
    await running;
    await parent.waitForSettled();

    expect(contextText(childScript.requests[1] as LlmContext)).toContain("Also do Y");
    const status = parent.session
      .messagesAt()
      .find((message) => message.role === "toolResult" && message.toolName === "subagent_status");
    expect(JSON.stringify(status)).toContain("Did X and Y.");
    expect(parentScript.callCount).toBe(4);
    const [record] = records(parent.session.messagesAt());
    expect(JSON.stringify(record?.content)).toContain("Its result was already returned to you.");
    expect(JSON.stringify(record?.content)).not.toContain("Did X and Y.");
  });

  test("stop ends the child and records it without waking another turn", async () => {
    const { gate, reached } = gateTool();
    const { parent, parentScript } = await setup(
      [
        background(),
        (ctx) => call("stop-1", "subagent_stop", { subagentId: subagentId(ctx) }),
        text("Stopped it."),
      ],
      [call("gate-1", "gate", {})],
      { tools: [gate] },
    );

    const running = parent.run("delegate then stop");
    await reached;
    const result = await running;
    await parent.waitForSettled();

    expect(result.text).toBe("Stopped it.");
    expect(parentScript.callCount).toBe(3);
    const stop = parent.session
      .messagesAt()
      .find((message) => message.role === "toolResult" && message.toolName === "subagent_stop");
    expect(JSON.stringify(stop)).toContain("Stopped sa-");
    const [record] = records(parent.session.messagesAt());
    expect((record?.details as BackgroundSubagentResultDetails).status).toBe("stopped");
  });

  test("a user stop is recorded as such without waking another turn", async () => {
    const { gate, reached } = gateTool();
    const { parent, parentScript } = await setup(
      [background(), text("Started.")],
      [call("gate-1", "gate", {})],
      { tools: [gate] },
    );

    await parent.run("delegate");
    await reached;
    const [label] = parent.backgroundWork;
    expect(parent.stopBackgroundWork(label as string)).toBe(true);
    await parent.waitForSettled();

    expect(parentScript.callCount).toBe(2);
    const [record] = records(parent.session.messagesAt());
    expect(JSON.stringify(record?.content)).toContain(
      "The user you are working with stopped background subagent",
    );
    expect(parent.stopBackgroundWork("sa-missing")).toBe(false);
  });

  test("undo, redo and fork wait for background work", async () => {
    const { gate, release, reached } = gateTool();
    const { parent } = await setup([background(), text("Started.")], [call("gate-1", "gate", {})], {
      tools: [gate],
    });

    await parent.run("delegate");
    await reached;

    expect((await parent.undo()).message).toContain("background work is running");
    expect((await parent.redo()).message).toContain("background work is running");
    expect((await parent.fork(parent.session.head as string)).message).toContain(
      "background work is running",
    );
    release();
    await parent.waitForSettled();
  });

  test("a new session stops background work and records it in the session that started it", async () => {
    const store = new MemorySessionStore();
    const { gate, reached } = gateTool();
    const { parent } = await setup([background(), text("Started.")], [call("gate-1", "gate", {})], {
      tools: [gate],
      store,
    });

    await parent.run("delegate");
    await reached;
    const original = parent.sessionId;
    parent.newSession();
    await parent.waitForSettled();

    const saved = await store.load(original);
    const [record] = records(saved?.messagesAt() ?? []);
    expect((record?.details as BackgroundSubagentResultDetails).status).toBe("stopped");
    expect(records(parent.session.messagesAt())).toEqual([]);
  });

  test("shutdown stops background work and persists its record", async () => {
    const store = new MemorySessionStore();
    const { gate, reached } = gateTool();
    const { parent } = await setup([background(), text("Started.")], [call("gate-1", "gate", {})], {
      tools: [gate],
      store,
    });

    await parent.run("delegate");
    await reached;
    await parent.shutdown();

    const saved = await store.load(parent.sessionId);
    const [record] = records(saved?.messagesAt() ?? []);
    expect((record?.details as BackgroundSubagentResultDetails).status).toBe("stopped");
  });
});

describe("child permissions and budgets", () => {
  test("a task child follows a permission change made while it runs", async () => {
    let ran = 0;
    let parent: Agent | undefined;
    const guarded = tool({
      name: "guarded",
      description: "guarded",
      inputSchema: z.object({}),
      execute: () => {
        ran++;
        return "ran";
      },
    });
    const flip = tool({
      name: "flip",
      description: "simulates the user switching permission mode",
      inputSchema: z.object({}),
      execute: () => {
        parent?.setPermissions([{ permission: "*", pattern: "*", action: "allow" }]);
        return "flipped";
      },
    });
    const setupResult = await setup(
      [
        call("task-1", "task", { description: "guarded work", prompt: "Use guarded" }),
        text("Done."),
      ],
      [
        call("g-1", "guarded", {}),
        call("f-1", "flip", {}),
        call("g-2", "guarded", {}),
        text("Child done."),
      ],
      {
        tools: [guarded, flip],
        permissions: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "guarded", pattern: "*", action: "deny" },
        ],
      },
    );
    parent = setupResult.parent;

    await parent.run("delegate");

    expect(ran).toBe(1);
    const child = parent.session
      .messagesAt()
      .find((message) => message.role === "toolResult" && message.toolName === "task");
    expect(JSON.stringify(child)).toContain("Permission denied for guarded");
  });

  test("concurrent children share the parent's remaining budget", async () => {
    const work = tool({
      name: "work",
      description: "work",
      inputSchema: z.object({}),
      execute: () => "ok",
    });
    const forever: Turn[] = Array.from({ length: 20 }, (_, index) => ({
      ...call(`w-${index}`, "work", {}),
      usage: { inputTokens: 15, outputTokens: 5 },
      delayMs: 5,
    }));
    const { parent, childScript } = await setup(
      [
        {
          content: [
            {
              type: "toolCall",
              id: "a",
              name: "task",
              arguments: { description: "a", prompt: "a" },
            },
            {
              type: "toolCall",
              id: "b",
              name: "task",
              arguments: { description: "b", prompt: "b" },
            },
          ],
          usage: { inputTokens: 15, outputTokens: 5 },
        },
      ],
      forever,
      { tools: [work], budget: { maxTokens: 100 } },
    );

    await parent.run("delegate twice");

    // 20 tokens for the parent leave 80: four child turns between both
    // children, plus at most one in flight each when the limit is reached.
    expect(childScript.callCount).toBeLessThanOrEqual(6);
  });
});

function foreground(id = "fg-1", description = "foreground work"): ScriptedTurn {
  return call(id, "task", { description, prompt: "Do the work" });
}

describe("moving a running subagent to the background", () => {
  test("the call returns at once and the result arrives as a follow-up turn", async () => {
    const { gate, release, reached } = gateTool();
    const { parent, parentScript } = await setup(
      [foreground(), text("Working meanwhile."), text("Integrated the result.")],
      [call("gate-1", "gate", {}), text("Child finished the work.")],
      { tools: [gate] },
    );
    const events: string[] = [];
    let backgroundable = false;
    parent.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName === "task")
        backgroundable = event.backgroundable === true;
      if (event.type === "subagent_started") events.push(`started ${event.toolCallId}`);
      if (event.type === "subagent_progress") events.push("progress");
      if (event.type === "tool_execution_end" && event.toolCallId === "fg-1")
        events.push(`end ${(event.result.details as { type?: string }).type}`);
    });

    const running = parent.run("delegate");
    await reached;
    expect(backgroundable).toBe(true);
    expect(parent.backgroundableCalls).toEqual(["fg-1"]);
    expect(parent.backgroundToolCalls()).toEqual(["fg-1"]);
    const result = await running;
    expect(result.text).toBe("Working meanwhile.");
    expect(contextText(parentScript.requests[1] as LlmContext)).toContain(
      "The user moved this subagent to the background as sa-",
    );
    release();
    await parent.waitForSettled();

    expect(events.slice(0, 2)).toEqual(["started fg-1", "end subagent-background"]);
    expect(events).toContain("progress");
    expect(parentScript.callCount).toBe(3);
    const wake = contextText(parentScript.requests[2] as LlmContext);
    expect(wake).toContain("Child finished the work.");
    const [record] = records(parent.session.messagesAt());
    expect((record?.details as BackgroundSubagentResultDetails).status).toBe("done");
  });

  test("interrupting the parent after the move leaves the child running", async () => {
    const { gate, release, reached } = gateTool();
    const { parent } = await setup(
      [foreground(), text("Working meanwhile."), text("Integrated.")],
      [call("gate-1", "gate", {}), text("Child finished.")],
      { tools: [gate] },
    );

    const running = parent.run("delegate");
    await reached;
    parent.backgroundToolCalls();
    await running;
    parent.abort();
    release();
    await parent.waitForSettled();

    const [record] = records(parent.session.messagesAt());
    expect((record?.details as BackgroundSubagentResultDetails).status).toBe("done");
  });

  test("a moved call reports its end before the rest of its batch finishes", async () => {
    const { gate, release, reached } = gateTool();
    const { parent } = await setup(
      [
        {
          content: [
            {
              type: "toolCall",
              id: "a",
              name: "task",
              arguments: { description: "a", prompt: "A" },
            },
            {
              type: "toolCall",
              id: "b",
              name: "task",
              arguments: { description: "b", prompt: "B" },
            },
          ],
        },
        text("Both handled."),
        text("Integrated."),
      ],
      [call("gate-1", "gate", {}), call("gate-2", "gate", {}), text("done"), text("done")],
      { tools: [gate] },
    );
    const ended: string[] = [];
    parent.subscribe((event) => {
      if (event.type === "tool_execution_end") ended.push(event.toolCallId);
    });

    const running = parent.run("two at once");
    await reached;
    await Bun.sleep(10);
    expect(parent.backgroundToolCalls(["a"])).toEqual(["a"]);
    await Bun.sleep(10);
    expect(ended).toEqual(["a"]);
    release();
    await running;
    await parent.waitForSettled();
    expect(ended.slice(0, 2)).toEqual(["a", "b"]);
  });
});
