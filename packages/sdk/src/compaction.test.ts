import { describe, expect, test } from "bun:test";
import { type AgentEvent, MemorySessionStore, SessionTree } from "@mu/core";
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

  test("compactNow runs immediately, forwards focus, and persists checkpoint metadata", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first answer" }] },
      { content: [{ type: "text", text: "manual summary" }] },
    ]);
    const agent = new Agent({ provider, model: smallModel, autoCompact: false });
    await agent.run(longPrompt());
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    const result = await agent.compactNow("preserve authentication decisions");
    await Bun.sleep(0);

    expect(result.status).toBe("completed");
    expect(provider.callCount).toBe(2);
    expect(JSON.stringify(provider.requests[1])).toContain("preserve authentication decisions");
    const entry = agent.session.activePath().find((candidate) => candidate.type === "compaction");
    expect(entry?.type === "compaction" && entry.trigger).toBe("manual");
    expect(entry?.type === "compaction" && entry.strategy).toBe("summary-tail");
    expect(entry?.type === "compaction" && entry.contextTokensBefore).toBeGreaterThan(0);
    expect(entry?.type === "compaction" && entry.contextTokensAfter).toBeGreaterThan(0);
    expect(
      events.some((event) => event.type === "compaction_update" && event.stage === "summarizing"),
    ).toBe(true);
    expect(
      events.some((event) => event.type === "compaction_update" && event.stage === "installing"),
    ).toBe(true);
  });

  test("compactNow preserves the original session on failure", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first answer" }] },
      { content: [{ type: "text", text: "" }], errorMessage: "summarizer unavailable" },
    ]);
    const agent = new Agent({ provider, model: smallModel, autoCompact: false });
    await agent.run(longPrompt());
    const before = agent.session.toJsonl();

    const result = await agent.compactNow();

    expect(result.status).toBe("failed");
    expect(agent.session.toJsonl()).toStartWith(before);
    expect(agent.session.activePath().at(-1)?.type).toBe("compaction-attempt");
    expect(agent.session.messagesAt()).toHaveLength(2);
    expect(result.message).toContain("Original conversation preserved");

    const persisted = await agent.sessionStore.load(agent.sessionId);
    const resumed = new Agent({
      provider: new FakeProvider([]),
      model: smallModel,
      session: agent.sessionStore,
    });
    resumed.resume(persisted as SessionTree);
    expect(resumed.usage).toEqual(agent.usage);
  });

  test("compactNow does not install a candidate boundary when persistence fails", async () => {
    class FailManualSaveStore extends MemorySessionStore {
      private failNext = false;

      failNextSave(): void {
        this.failNext = true;
      }

      override async save(sessionId: string, tree: SessionTree): Promise<void> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("disk unavailable");
        }
        await super.save(sessionId, tree);
      }
    }

    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first answer" }] },
      { content: [{ type: "text", text: "valid summary" }] },
    ]);
    const store = new FailManualSaveStore();
    const agent = new Agent({ provider, model: smallModel, autoCompact: false, session: store });
    await agent.run(longPrompt());
    const before = agent.session.toJsonl();
    store.failNextSave();

    const result = await agent.compactNow();

    expect(result.status).toBe("failed");
    expect(result.message).toContain("disk unavailable");
    expect(agent.session.toJsonl()).toStartWith(before);
    expect(agent.session.activePath().some((entry) => entry.type === "compaction")).toBe(false);
    expect(agent.session.activePath().at(-1)?.type).toBe("compaction-attempt");
  });

  test("manual compaction queues behind an active turn", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first answer" }], delayMs: 10 },
      { content: [{ type: "text", text: "queued summary" }] },
    ]);
    const agent = new Agent({ provider, model: smallModel, autoCompact: false });
    const running = agent.run(longPrompt());

    const queued = await agent.compactNow("preserve queue state");
    expect(queued.status).toBe("queued");
    await running;
    await agent.waitForIdle();

    expect(provider.callCount).toBe(2);
    expect(JSON.stringify(provider.requests[1])).toContain("preserve queue state");
    expect(agent.session.activePath().some((entry) => entry.type === "compaction")).toBe(true);
  });

  test("switching to a smaller model compacts with model-change metadata before sampling", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "first answer" }] },
      { content: [{ type: "text", text: "downshift summary" }] },
      { content: [{ type: "text", text: "second answer" }] },
    ]);
    const agent = new Agent({ provider, model: fakeModel, autoCompact: false });
    await agent.run(longPrompt());
    agent.setModel({ ...smallModel, id: "fake-small" });

    await agent.run("continue");

    expect(provider.callCount).toBe(3);
    expect(JSON.stringify(provider.requests[2])).not.toContain("context filler");
    const entry = agent.session.activePath().find((candidate) => candidate.type === "compaction");
    expect(entry?.type === "compaction" && entry.trigger).toBe("model-change");
    expect(entry?.type === "compaction" && entry.compactorModel).toBe("fake/fake-1");
    expect(entry?.type === "compaction" && entry.model).toBe("fake/fake-small");
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

  test("separate overflow episodes in one tool-using run each recover once", async () => {
    const tooLong = {
      content: [{ type: "text" as const, text: "" }],
      errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
    };
    const provider = new FakeProvider([
      tooLong,
      { content: [{ type: "text", text: "summary one" }] },
      { content: [{ type: "toolCall", id: "c1", name: "noop", arguments: {} }] },
      tooLong,
      { content: [{ type: "text", text: "summary two" }] },
      { content: [{ type: "text", text: "recovered twice" }] },
    ]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      autoCompact: false,
      tools: [
        {
          name: "noop",
          description: "no-op",
          inputSchema: { type: "object" },
          execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        },
      ],
    });
    const events: AgentEvent[] = [];
    const stream = agent.stream(longPrompt());
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(result.reason).toBe("done");
    expect(result.text).toBe("recovered twice");
    expect(provider.callCount).toBe(6);
    expect(
      events.filter((event) => event.type === "compaction_start" && event.layer === 3),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "compaction_end" && event.layer === 3),
    ).toHaveLength(2);
    expect(
      events.filter(
        (event) =>
          (event.type === "compaction_start" || event.type === "compaction_end") &&
          event.layer === 2,
      ),
    ).toHaveLength(0);
  });

  test("layer 3 ends only after the real compaction attempt", async () => {
    const provider = new FakeProvider([
      {
        content: [{ type: "text", text: "" }],
        errorMessage: "context window exceeded",
      },
      { content: [{ type: "text", text: "reactive summary" }] },
      { content: [{ type: "text", text: "answer" }] },
    ]);
    const events: AgentEvent[] = [];
    const agent = new Agent({ provider, model: fakeModel, autoCompact: false });
    const stream = agent.stream(longPrompt());
    for await (const event of stream) events.push(event);
    await stream.result();

    const start = events.findIndex(
      (event) => event.type === "compaction_start" && event.layer === 3,
    );
    const usage = events.findIndex((event) => event.type === "usage_updated");
    const end = events.findIndex((event) => event.type === "compaction_end" && event.layer === 3);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(usage).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(usage);
    const endEvent = events[end];
    expect(endEvent?.type === "compaction_end" && endEvent.tokensFreed).toBeGreaterThan(0);
  });
});
