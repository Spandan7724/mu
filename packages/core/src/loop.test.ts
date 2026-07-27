import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "./events.ts";
import { type AgentContext, type LoopConfig, runLoop } from "./loop.ts";
import { type AgentMessage, userMessage } from "./messages.ts";
import { FakeProvider, fakeModel } from "./testing/fake-provider.ts";
import { type AnyTool, type ToolResult, textResult } from "./tools.ts";

function collector() {
  const events: AgentEvent[] = [];
  return { events, emit: (event: AgentEvent) => void events.push(event) };
}

function echoTool(overrides: Partial<AnyTool> = {}): AnyTool {
  return {
    name: "echo",
    description: "Echo text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    execute: async (_id, args) => textResult(`echo:${(args as { text?: string }).text ?? ""}`),
    ...overrides,
  };
}

function baseConfig(provider: FakeProvider, extra: Partial<LoopConfig> = {}): LoopConfig {
  return { provider, model: fakeModel, ...extra };
}

function ctx(tools?: AnyTool[]): AgentContext {
  return { messages: [], ...(tools ? { tools } : {}) };
}

describe("agent loop", () => {
  test("runs a multi-turn tool-use conversation", async () => {
    const provider = new FakeProvider([
      {
        content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "one" } }],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const { events, emit } = collector();
    const result = await runLoop(
      [userMessage("hi")],
      ctx([echoTool()]),
      baseConfig(provider),
      emit,
    );

    expect(result.reason).toBe("done");
    expect(provider.callCount).toBe(2);
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.content[0]).toEqual({ type: "text", text: "echo:one" });
      expect(toolResult.isError).toBe(false);
    }
    expect(events[0]?.type).toBe("agent_start");
    expect(events[events.length - 1]?.type).toBe("agent_end");
    expect(events.filter((e) => e.type === "turn_start").length).toBe(2);
  });

  test("steering messages are injected before the next LLM call", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "a" } }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    let delivered = false;
    const { emit } = collector();
    await runLoop(
      [userMessage("start")],
      ctx([echoTool()]),
      baseConfig(provider, {
        getSteeringMessages: () => {
          if (delivered) return [];
          delivered = true;
          return [userMessage("actually, stop")];
        },
      }),
      emit,
    );

    // Steering was polled after turn 1, so it must appear in turn 2's request.
    const secondRequest = provider.requests[1];
    const texts = secondRequest?.messages.flatMap((m) =>
      m.role === "user" ? m.content.filter((c) => c.type === "text").map((c) => c.text) : [],
    );
    expect(texts).toContain("actually, stop");
  });

  test("follow-up queue continues the loop after it would stop", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "second" }] },
    ]);
    let sent = false;
    const { emit } = collector();
    const result = await runLoop(
      [userMessage("go")],
      ctx(),
      baseConfig(provider, {
        getFollowUpMessages: () => {
          if (sent) return [];
          sent = true;
          return [userMessage("one more thing")];
        },
      }),
      emit,
    );

    expect(provider.callCount).toBe(2);
    expect(result.reason).toBe("done");
  });

  test("maxTurns halts with a typed reason", async () => {
    const provider = new FakeProvider(
      Array.from({ length: 5 }, (_, i) => ({
        content: [
          { type: "toolCall" as const, id: `c${i}`, name: "echo", arguments: { text: `${i}` } },
        ],
      })),
    );
    const { emit } = collector();
    const result = await runLoop(
      [userMessage("loop")],
      ctx([echoTool()]),
      baseConfig(provider, { maxTurns: 2 }),
      emit,
    );
    expect(result.reason).toBe("maxTurns");
    expect(provider.callCount).toBe(2);
  });

  test("length stopReason fails every tool call in that message", async () => {
    let executed = 0;
    const provider = new FakeProvider([
      {
        content: [
          { type: "toolCall", id: "c1", name: "echo", arguments: { text: "trunc" } },
          { type: "toolCall", id: "c2", name: "echo", arguments: {} },
        ],
        stopReason: "length",
      },
      { content: [{ type: "text", text: "recovered" }] },
    ]);
    const tool = echoTool({
      execute: async () => {
        executed++;
        return textResult("should not run");
      },
    });
    const { emit } = collector();
    const result = await runLoop([userMessage("go")], ctx([tool]), baseConfig(provider), emit);

    expect(executed).toBe(0);
    const results = result.messages.filter((m) => m.role === "toolResult");
    expect(results.length).toBe(2);
    for (const message of results) {
      if (message.role !== "toolResult") continue;
      expect(message.isError).toBe(true);
      expect(message.content[0]?.type === "text" && message.content[0].text).toContain(
        "output token limit",
      );
    }
  });

  test("doom-loop detection injects a nudge after 3 identical calls", async () => {
    const provider = new FakeProvider(
      Array.from({ length: 4 }, () => ({
        content: [
          { type: "toolCall" as const, id: "same", name: "echo", arguments: { text: "same" } },
        ],
      })),
    );
    const { emit } = collector();
    const result = await runLoop(
      [userMessage("go")],
      ctx([echoTool()]),
      baseConfig(provider, { maxTurns: 4 }),
      emit,
    );
    const nudge = result.messages.find(
      (m): m is Extract<AgentMessage, { role: "custom" }> =>
        m.role === "custom" && m.customType === "system-reminder",
    );
    expect(nudge).toBeDefined();
    expect(nudge?.content[0]?.type === "text" && nudge.content[0].text).toContain("identical");
  });
});

describe("control hooks", () => {
  test("beforeToolCall can block a call", async () => {
    let executed = false;
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const tool = echoTool({
      execute: async () => {
        executed = true;
        return textResult("ran");
      },
    });
    const { emit } = collector();
    const result = await runLoop(
      [userMessage("go")],
      ctx([tool]),
      baseConfig(provider, {
        beforeToolCall: () => ({ block: true, reason: "not allowed" }),
      }),
      emit,
    );
    expect(executed).toBe(false);
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content[0]?.type === "text" && toolResult.content[0].text).toBe(
        "not allowed",
      );
    }
  });

  test("beforeToolCall can rewrite args", async () => {
    let seen: unknown;
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "orig" } }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const tool = echoTool({
      execute: async (_id, args) => {
        seen = args;
        return textResult("ran");
      },
    });
    const { emit } = collector();
    await runLoop(
      [userMessage("go")],
      ctx([tool]),
      baseConfig(provider, {
        beforeToolCall: () => ({ rewrittenArgs: { text: "rewritten" } }),
      }),
      emit,
    );
    expect(seen).toEqual({ text: "rewritten" });
  });

  test("afterToolCall rewrites the result", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const { emit } = collector();
    const result = await runLoop(
      [userMessage("go")],
      ctx([echoTool()]),
      baseConfig(provider, {
        afterToolCall: (): ToolResult => textResult("augmented"),
      }),
      emit,
    );
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.content[0]).toEqual({ type: "text", text: "augmented" });
    }
  });

  test("shouldStopAfterTurn forces the loop to stop", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }] },
      { content: [{ type: "text", text: "never reached" }] },
    ]);
    const { emit } = collector();
    const result = await runLoop(
      [userMessage("go")],
      ctx([echoTool()]),
      baseConfig(provider, { shouldStopAfterTurn: () => true }),
      emit,
    );
    expect(provider.callCount).toBe(1);
    expect(result.reason).toBe("done");
  });

  test("prepareNextTurn swaps the model mid-run", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const swapped = { ...fakeModel, id: "fake-2" };
    const { emit } = collector();
    const result = await runLoop(
      [userMessage("go")],
      ctx([echoTool()]),
      baseConfig(provider, { prepareNextTurn: () => ({ model: swapped }) }),
      emit,
    );
    const assistants = result.messages.filter((m) => m.role === "assistant");
    expect(assistants[0]?.role === "assistant" && assistants[0].model).toBe("fake/fake-1");
    expect(assistants[1]?.role === "assistant" && assistants[1].model).toBe("fake/fake-2");
  });

  test("transformContext rewrites the message list before the LLM call", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const { emit } = collector();
    await runLoop(
      [userMessage("secret")],
      ctx(),
      baseConfig(provider, {
        transformContext: () => [userMessage("redacted")],
      }),
      emit,
    );
    const sent = provider.requests[0]?.messages[0];
    expect(sent?.role === "user" && sent.content[0]?.type === "text" && sent.content[0].text).toBe(
      "redacted",
    );
  });

  test("prepareContext replaces live state while transformContext stays request-local", async () => {
    const provider = new FakeProvider([
      {
        content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { value: "x" } }],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const { emit } = collector();
    let preparations = 0;
    await runLoop(
      [userMessage("secret")],
      ctx([echoTool()]),
      baseConfig(provider, {
        prepareContext: (messages) => {
          preparations++;
          return preparations === 1 ? [userMessage("persisted")] : messages;
        },
        transformContext: (messages) => [...messages, userMessage(`request-only-${preparations}`)],
      }),
      emit,
    );

    const second = provider.requests[1]?.messages ?? [];
    const text = JSON.stringify(second);
    expect(text).toContain("persisted");
    expect(text).toContain("request-only-2");
    expect(text).not.toContain("request-only-1");
    expect(text).not.toContain("secret");
  });
});

describe("tool batching", () => {
  test("concurrency-safe calls run in parallel, results stay ordered", async () => {
    const provider = new FakeProvider([
      {
        content: [
          { type: "toolCall", id: "c1", name: "safe", arguments: { ms: 30, tag: "a" } },
          { type: "toolCall", id: "c2", name: "safe", arguments: { ms: 5, tag: "b" } },
        ],
      },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    let concurrent = 0;
    let peak = 0;
    const safe: AnyTool = {
      name: "safe",
      description: "safe",
      inputSchema: { type: "object" },
      isConcurrencySafe: () => true,
      execute: async (_id, args) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await Bun.sleep((args as { ms: number }).ms);
        concurrent--;
        return textResult((args as { tag: string }).tag);
      },
    };
    const { emit } = collector();
    const result = await runLoop([userMessage("go")], ctx([safe]), baseConfig(provider), emit);

    expect(peak).toBe(2);
    const texts = result.messages
      .filter((m) => m.role === "toolResult")
      .map((m) =>
        m.role === "toolResult" && m.content[0]?.type === "text" ? m.content[0].text : "",
      );
    expect(texts).toEqual(["a", "b"]);
  });

  test("unsafe calls serialize", async () => {
    const provider = new FakeProvider([
      {
        content: [
          { type: "toolCall", id: "c1", name: "unsafe", arguments: {} },
          { type: "toolCall", id: "c2", name: "unsafe", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    let concurrent = 0;
    let peak = 0;
    const unsafe: AnyTool = {
      name: "unsafe",
      description: "unsafe",
      inputSchema: { type: "object" },
      execute: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await Bun.sleep(5);
        concurrent--;
        return textResult("x");
      },
    };
    const { emit } = collector();
    await runLoop([userMessage("go")], ctx([unsafe]), baseConfig(provider), emit);
    expect(peak).toBe(1);
  });

  test("executionMode sequential overrides the safety predicate", async () => {
    const provider = new FakeProvider([
      {
        content: [
          { type: "toolCall", id: "c1", name: "seq", arguments: {} },
          { type: "toolCall", id: "c2", name: "seq", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    let concurrent = 0;
    let peak = 0;
    const seq: AnyTool = {
      name: "seq",
      description: "seq",
      inputSchema: { type: "object" },
      isConcurrencySafe: () => true,
      executionMode: "sequential",
      execute: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await Bun.sleep(5);
        concurrent--;
        return textResult("x");
      },
    };
    const { emit } = collector();
    await runLoop([userMessage("go")], ctx([seq]), baseConfig(provider), emit);
    expect(peak).toBe(1);
  });

  test("a throwing safety predicate is treated as unsafe", async () => {
    const provider = new FakeProvider([
      {
        content: [
          { type: "toolCall", id: "c1", name: "boom", arguments: {} },
          { type: "toolCall", id: "c2", name: "boom", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    let concurrent = 0;
    let peak = 0;
    const boom: AnyTool = {
      name: "boom",
      description: "boom",
      inputSchema: { type: "object" },
      isConcurrencySafe: () => {
        throw new Error("cannot decide");
      },
      execute: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await Bun.sleep(5);
        concurrent--;
        return textResult("x");
      },
    };
    const { emit } = collector();
    await runLoop([userMessage("go")], ctx([boom]), baseConfig(provider), emit);
    expect(peak).toBe(1);
  });

  test("unknown tool yields an error result rather than throwing", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "missing", arguments: {} }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const { emit } = collector();
    const result = await runLoop(
      [userMessage("go")],
      ctx([echoTool()]),
      baseConfig(provider),
      emit,
    );
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content[0]?.type === "text" && toolResult.content[0].text).toContain(
        "not found",
      );
    }
  });

  test("a throwing tool becomes an error result and the loop continues", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "echo", arguments: {} }] },
      { content: [{ type: "text", text: "recovered" }] },
    ]);
    const tool = echoTool({
      execute: async () => {
        throw new Error("tool exploded");
      },
    });
    const { emit } = collector();
    const result = await runLoop([userMessage("go")], ctx([tool]), baseConfig(provider), emit);
    expect(result.reason).toBe("done");
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content[0]?.type === "text" && toolResult.content[0].text).toBe(
        "tool exploded",
      );
    }
  });
});

describe("abort", () => {
  test("aborting during the provider stream ends the run as aborted", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "slow" }], delayMs: 50 }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const { emit } = collector();
    const result = await runLoop(
      [userMessage("go")],
      ctx(),
      baseConfig(provider),
      emit,
      controller.signal,
    );
    expect(result.reason).toBe("aborted");
  });

  test("the abort signal reaches tool execute", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "slow", arguments: {} }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const controller = new AbortController();
    let sawAbort = false;
    const slow: AnyTool = {
      name: "slow",
      description: "slow",
      inputSchema: { type: "object" },
      execute: async (_id, _args, signal) => {
        controller.abort();
        sawAbort = signal.aborted;
        return textResult("done");
      },
    };
    const { emit } = collector();
    await runLoop([userMessage("go")], ctx([slow]), baseConfig(provider), emit, controller.signal);
    expect(sawAbort).toBe(true);
  });
});
