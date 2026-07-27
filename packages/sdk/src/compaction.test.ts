import { describe, expect, test } from "bun:test";
import { type AgentEvent, SessionTree } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";

// A model with a tiny window so the threshold is reachable in a test.
const smallModel = { ...fakeModel, contextWindow: 400 };

function longPrompt(): string {
  return "context filler. ".repeat(120); // ~500 tokens by the estimator
}

describe("auto compaction", () => {
  test("fires when the context crosses the threshold", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "summary of earlier work" }] }, // compaction call
      { content: [{ type: "text", text: "answer" }] },
    ]);
    const events: AgentEvent[] = [];
    const agent = new Agent({ provider, model: smallModel });

    const stream = agent.stream(longPrompt());
    for await (const event of stream) events.push(event);
    await stream.result();

    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("compaction_start");
    expect(kinds).toContain("compaction_end");
  });

  test("does not fire on a small context", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "answer" }] }]);
    const events: AgentEvent[] = [];
    const agent = new Agent({ provider, model: fakeModel });

    const stream = agent.stream("short");
    for await (const event of stream) events.push(event);
    await stream.result();

    expect(events.map((e) => e.type)).not.toContain("compaction_start");
  });

  test("can be disabled", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "answer" }] }]);
    const events: AgentEvent[] = [];
    const agent = new Agent({ provider, model: smallModel, autoCompact: false });

    const stream = agent.stream(longPrompt());
    for await (const event of stream) events.push(event);
    await stream.result();

    expect(events.map((e) => e.type)).not.toContain("compaction_start");
  });

  test("the post-compaction request carries summary + tail, not the full history", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "SUMMARY: the user wanted X." }] },
      { content: [{ type: "text", text: "answer" }] },
    ]);
    const agent = new Agent({ provider, model: smallModel });
    await agent.run(longPrompt());

    // requests[0] is the compaction call; requests[1] is the real turn.
    const realTurn = provider.requests[1];
    const texts = (realTurn?.messages ?? []).flatMap((m) =>
      m.role === "user" ? m.content.filter((c) => c.type === "text").map((c) => c.text) : [],
    );
    expect(texts.join("\n")).toContain("SUMMARY: the user wanted X.");
  });

  test("a failed summarization does not take the run down", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "" }], errorMessage: "summarizer unavailable" },
      { content: [{ type: "text", text: "answer anyway" }] },
    ]);
    const agent = new Agent({ provider, model: smallModel });
    const result = await agent.run(longPrompt());

    expect(result.reason).toBe("done");
    expect(result.text).toBe("answer anyway");
  });

  test("carryover from the profile reaches the summary message", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "summary" }] },
      { content: [{ type: "text", text: "answer" }] },
    ]);
    const agent = new Agent({
      provider,
      model: smallModel,
      carryoverExtractor: () => ({ modifiedFiles: ["src/client.ts"] }),
    });
    await agent.run(longPrompt());

    const realTurn = provider.requests[1];
    const joined = (realTurn?.messages ?? [])
      .flatMap((m) =>
        m.role === "user" ? m.content.filter((c) => c.type === "text").map((c) => c.text) : [],
      )
      .join("\n");
    expect(joined).toContain("src/client.ts");
  });

  test("a tool-using run installs one summary into every later request", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "one stable summary" }] },
      {
        content: [{ type: "toolCall", id: "c1", name: "noop", arguments: {} }],
      },
      { content: [{ type: "text", text: "finished" }] },
    ]);
    const events: AgentEvent[] = [];
    const agent = new Agent({
      provider,
      model: smallModel,
      tools: [
        {
          name: "noop",
          description: "no-op",
          inputSchema: { type: "object" },
          execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        },
      ],
    });

    const stream = agent.stream(longPrompt());
    for await (const event of stream) events.push(event);
    await stream.result();

    const layer2Starts = events.filter(
      (event) => event.type === "compaction_start" && event.layer === 2,
    );
    expect(layer2Starts).toHaveLength(1);
    expect(provider.callCount).toBe(3);
    const lastRequest = JSON.stringify(provider.requests[2]?.messages);
    expect(lastRequest).toContain("one stable summary");
    expect(lastRequest).not.toContain("context filler");
  });
});

describe("/compact on demand", () => {
  test("requestCompaction compacts before the next call", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "on-demand summary" }] },
      { content: [{ type: "text", text: "second" }] },
    ]);
    const agent = new Agent({ provider, model: fakeModel, autoCompact: false });
    await agent.run("hello there, this is a reasonably long first message");

    agent.requestCompaction();
    const events: AgentEvent[] = [];
    const stream = agent.stream("continue");
    for await (const event of stream) events.push(event);
    await stream.result();

    expect(events.map((e) => e.type)).toContain("compaction_start");
  });
});

describe("context accounting", () => {
  test("usage_updated carries a context percentage for the footer", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]);
    const events: AgentEvent[] = [];
    const agent = new Agent({ provider, model: fakeModel });

    const stream = agent.stream("hello");
    for await (const event of stream) events.push(event);
    await stream.result();

    const usage = events.find((e) => e.type === "usage_updated");
    expect(usage?.type === "usage_updated" && usage.contextPercent).toBeGreaterThanOrEqual(0);
    expect(usage?.type === "usage_updated" && usage.contextPercent).toBeLessThanOrEqual(1);
  });

  test("cached input, compactor usage, events, and the public getter agree", async () => {
    const provider = new FakeProvider([
      {
        content: [{ type: "text", text: "summary" }],
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.2 },
      },
      {
        content: [{ type: "text", text: "answer" }],
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 300,
          cacheWriteTokens: 20,
          costUsd: 0.1,
        },
      },
    ]);
    const events: AgentEvent[] = [];
    const agent = new Agent({ provider, model: smallModel });
    const stream = agent.stream(longPrompt());
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(result.usage).toEqual({
      inputTokens: 110,
      outputTokens: 24,
      cacheReadTokens: 300,
      cacheWriteTokens: 20,
      costUsd: 0.30000000000000004,
    });
    const updates = events.filter((event) => event.type === "usage_updated");
    const last = updates.at(-1);
    expect(updates).toHaveLength(2);
    expect(last?.type === "usage_updated" && last.contextTokens).toBeGreaterThanOrEqual(330);
    expect(last?.type === "usage_updated" && last.contextPercent).toBe(agent.contextPercent);
  });

  test("a compaction request that crosses the budget stops before the main request", async () => {
    const provider = new FakeProvider([
      {
        content: [{ type: "text", text: "summary" }],
        usage: { costUsd: 0.2 },
      },
      { content: [{ type: "text", text: "must not run" }] },
    ]);
    const agent = new Agent({
      provider,
      model: smallModel,
      budget: { maxCostUsd: 0.1 },
    });
    const result = await agent.run(longPrompt());

    expect(result.reason).toBe("maxCostUsd");
    expect(provider.callCount).toBe(1);
    expect(result.usage.costUsd).toBe(0.2);
  });
});

describe("resume after compaction", () => {
  test("a compaction entry is written to the session tree", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "the summary" }] },
      { content: [{ type: "text", text: "answer" }] },
    ]);
    const agent = new Agent({ provider, model: smallModel });
    await agent.run(longPrompt());

    const entries = agent.session.all();
    const compaction = entries.find((entry) => entry.type === "compaction");
    expect(compaction).toBeDefined();
    if (compaction?.type === "compaction") {
      expect(compaction.summary).toBe("the summary");
    }
  });

  test("reloading from JSONL rebuilds context as summary + tail", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "persisted summary" }] },
      { content: [{ type: "text", text: "answer" }] },
    ]);
    const agent = new Agent({ provider, model: smallModel });
    await agent.run(longPrompt());

    // Round-trip the session exactly as a resume would.
    const reloaded = SessionTree.fromJsonl(agent.session.toJsonl());
    const messages = reloaded.messagesAt();

    const summary = messages.find(
      (m) => m.role === "custom" && m.customType === "compaction-summary",
    );
    expect(summary).toBeDefined();
    if (summary?.role === "custom") {
      expect(summary.content[0]?.type === "text" && summary.content[0].text).toContain(
        "persisted summary",
      );
    }
  });

  test("live and reloaded contexts preserve the exact tail and structured carryover", async () => {
    const provider = new FakeProvider([
      ...Array.from({ length: 5 }, (_, index) => ({
        content: [{ type: "text" as const, text: `answer-${index}` }],
      })),
      { content: [{ type: "text", text: "persisted summary" }] },
      { content: [{ type: "text", text: "after compact" }] },
    ]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      autoCompact: false,
      carryoverExtractor: () => ({
        modifiedFiles: ["src/a.ts"],
        todos: [{ content: "finish", status: "pending" }],
      }),
    });
    for (let index = 0; index < 5; index++) {
      await agent.run(`prompt-${index}`);
    }
    agent.requestCompaction();
    await agent.run("continue");

    const live = agent.session.messagesAt();
    const reloaded = SessionTree.fromJsonl(agent.session.toJsonl()).messagesAt();
    expect(reloaded).toEqual(live);
    const serialized = JSON.stringify(reloaded);
    const summaryText =
      reloaded[0]?.role === "custom" && reloaded[0].content[0]?.type === "text"
        ? reloaded[0].content[0].text
        : "";
    expect(serialized).toContain("src/a.ts");
    expect(summaryText).toContain('"status": "pending"');
    expect(serialized).not.toContain("[object Object]");
    expect(serialized).toContain("answer-4");
    expect(serialized).toContain("continue");
    expect(serialized).toContain("after compact");
  });
});

describe("layer 1 — microcompaction", () => {
  test("stale tool output is tombstoned before an LLM summary is attempted", async () => {
    const bulky = "x".repeat(1200);
    // Enough tool-calling turns that older results fall outside the keep-recent
    // window — a short transcript is deliberately left alone.
    const provider = new FakeProvider([
      ...Array.from({ length: 6 }, (_, i) => ({
        content: [{ type: "toolCall" as const, id: `c${i}`, name: "noop", arguments: {} }],
      })),
      { content: [{ type: "text" as const, text: "done" }] },
    ]);
    const noop = {
      name: "noop",
      description: "produces bulky output",
      inputSchema: { type: "object" },
      execute: async () => ({ content: [{ type: "text" as const, text: bulky }] }),
    };

    const events: AgentEvent[] = [];
    const agent = new Agent({
      provider,
      model: { ...fakeModel, contextWindow: 2000 },
      tools: [noop],
      autoCompact: true,
      budget: { maxTurns: 7 },
    });
    const stream = agent.stream("go");
    for await (const event of stream) events.push(event);
    await stream.result();

    const layers = events
      .filter((e) => e.type === "compaction_start")
      .map((e) => (e.type === "compaction_start" ? e.layer : 0));
    expect(layers).toContain(1);

    // The eviction left a re-runnable tombstone rather than deleting history.
    const tombstoned = agent.session
      .messagesAt()
      .some(
        (m) =>
          m.role === "toolResult" &&
          m.content[0]?.type === "text" &&
          m.content[0].text.includes("re-run the tool"),
      );
    expect(tombstoned).toBe(true);
    expect(agent.session.all().some((entry) => entry.type === "microcompaction")).toBe(true);
    const reloaded = SessionTree.fromJsonl(agent.session.toJsonl());
    expect(reloaded.messagesAt()).toEqual(agent.session.messagesAt());
  });

  test("a short transcript is left untouched", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]);
    const events: AgentEvent[] = [];
    const agent = new Agent({ provider, model: fakeModel });
    const stream = agent.stream("short");
    for await (const event of stream) events.push(event);
    await stream.result();
    expect(events.filter((e) => e.type === "compaction_start")).toEqual([]);
  });
});

describe("layer 3 — reactive recovery", () => {
  test("a session that would exceed context survives instead of dying", async () => {
    // The provider rejects the first request for being too long, then succeeds.
    const provider = new FakeProvider([
      {
        content: [{ type: "text", text: "" }],
        errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
      },
      { content: [{ type: "text", text: "compacted summary" }] },
      { content: [{ type: "text", text: "recovered and answered" }] },
    ]);

    const events: AgentEvent[] = [];
    const agent = new Agent({ provider, model: fakeModel });
    const stream = agent.stream("a very long conversation");
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    const layers = events
      .filter((e) => e.type === "compaction_start")
      .map((e) => (e.type === "compaction_start" ? e.layer : 0));
    expect(layers).toContain(3);
    // The run continued rather than ending on the provider error.
    expect(provider.callCount).toBeGreaterThan(1);
    expect(result.reason).not.toBe("error");
  });

  test("recovery is attempted once, so a persistent failure still surfaces", async () => {
    const tooLong = {
      content: [{ type: "text" as const, text: "" }],
      errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
    };
    const provider = new FakeProvider([tooLong, tooLong, tooLong, tooLong]);
    const agent = new Agent({ provider, model: fakeModel });
    const result = await agent.run("hopeless");

    // It tried to recover, then reported the real failure rather than looping.
    expect(result.reason).toBe("error");
    expect(provider.callCount).toBeLessThanOrEqual(4);
  });
});
