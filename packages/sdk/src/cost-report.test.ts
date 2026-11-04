import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Usage } from "@mu/ai";
import { customMessage, MemorySessionStore, userMessage } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { registryWithCoreCommands } from "./commands.ts";
import { attachedUsageLines, type CostReport, contextBreakdown } from "./cost-report.ts";
import { tool } from "./tool.ts";

const usage = (input: number, output: number, cost = 0): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: cost,
});

const childTurn = (model: string, spent: Usage): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "child" }],
  model,
  usage: spent,
  stopReason: "end",
  timestamp: 1,
});

const sorted = (report: CostReport) =>
  [...report.lines].sort((a, b) => `${a.source}${a.model}`.localeCompare(`${b.source}${b.model}`));

describe("attachedUsageLines", () => {
  test("splits a child's usage by its own turns and leaves the rest with the child's model", () => {
    const lines = attachedUsageLines(
      usage(100, 20, 0.5),
      {
        type: "subagent",
        model: "a/one",
        messages: [
          childTurn("a/one", usage(40, 10, 0.25)),
          childTurn("b/two", usage(30, 5, 0.125)),
        ],
      },
      "parent/model",
    );
    expect(lines).toEqual([
      { source: "subagents", model: "a/one", usage: usage(70, 15, 0.375), turns: 1 },
      { source: "subagents", model: "b/two", usage: usage(30, 5, 0.125), turns: 1 },
    ]);
  });

  test("usage without a child transcript belongs to the calling model as tool spend", () => {
    expect(attachedUsageLines(usage(5, 1), undefined, "parent/model")).toEqual([
      { source: "tools", model: "parent/model", usage: usage(5, 1), turns: 0 },
    ]);
  });
});

describe("contextBreakdown", () => {
  const base = {
    systemPrompt: [{ text: "s".repeat(700) }],
    tools: [{ name: "read", description: "d".repeat(300), inputSchema: {} }],
    messages: [
      customMessage("project-notes", "n".repeat(350)),
      customMessage("skills", "k".repeat(70)),
      userMessage("u".repeat(140)),
      {
        role: "toolResult" as const,
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text" as const, text: "r".repeat(1_400) }],
        isError: false,
        timestamp: 1,
      },
    ],
    compactions: 0,
    window: 10_000,
    autoCompactAt: 0.85,
    label: (type: string) => (type === "project-notes" ? "notes" : undefined),
  };

  test("a reported total is exact and the scaled parts add up to it", () => {
    const report = contextBreakdown({ ...base, tokens: 2_001, reported: true });
    expect(report.tokens).toBe(2_001);
    expect(report.reported).toBe(true);
    expect(report.parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(2_001);
    for (const part of report.parts) {
      if (part.children)
        expect(part.children.reduce((sum, child) => sum + child.tokens, 0)).toBe(part.tokens);
    }
    expect(report.parts.map((part) => part.label)).toEqual([
      "system prompt",
      "tool definitions",
      "notes",
      "skills",
      "messages",
      "tool results",
    ]);
  });

  test("an unreported total is still the one the parts add up to, flagged as an estimate", () => {
    const report = contextBreakdown({ ...base, tokens: 1_500, reported: false });
    expect(report.reported).toBe(false);
    expect(report.tokens).toBe(1_500);
    expect(report.parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(1_500);
  });

  test("with no total at all the estimate stands in for it", () => {
    const report = contextBreakdown({ ...base, tokens: 0, reported: false });
    expect(report.tokens).toBe(report.parts.reduce((sum, part) => sum + part.tokens, 0));
  });
});

describe("Agent cost report", () => {
  test("live spend by source and model matches what a resume rebuilds", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "delegate", arguments: {} }] },
      { content: [{ type: "text", text: "done" }], usage: { inputTokens: 30, outputTokens: 7 } },
    ]);
    const delegate = tool({
      name: "delegate",
      description: "Run a child",
      inputSchema: z.object({}),
      execute: () => ({
        content: [{ type: "text", text: "child answer" }],
        details: {
          type: "subagent",
          model: "other/child",
          messages: [childTurn("other/child", usage(50, 9, 0.02))],
        },
        usage: usage(50, 9, 0.02),
      }),
    });
    const store = new MemorySessionStore();
    const agent = new Agent({ provider, model: fakeModel, session: store, tools: [delegate] });
    await agent.run("go");

    const live = agent.costReport();
    expect(live.totals.inputTokens).toBe(10 + 30 + 50);
    expect(live.lines.find((line) => line.source === "main")?.turns).toBe(2);
    expect(live.lines.find((line) => line.source === "subagents")?.model).toBe("other/child");
    const tree = await store.load(agent.sessionId);
    if (!tree) throw new Error("session was not saved");
    const resumed = new Agent({ provider: new FakeProvider([]), model: fakeModel, session: store });
    resumed.resume(tree);
    expect(sorted(resumed.costReport())).toEqual(sorted(live));
    expect(resumed.costReport().totals).toEqual(live.totals);
  });

  test("external spend counts at once, is saved outside the context, and survives a resume", async () => {
    const store = new MemorySessionStore();
    const agent = new Agent({ provider: new FakeProvider([]), model: fakeModel, session: store });
    await agent.run("hi");
    const before = agent.usage.inputTokens;
    const pending = agent.recordExternalUsage({
      source: "side",
      model: "fake/fake-1",
      usage: usage(25, 4, 0.01),
      turns: 1,
    });
    expect(agent.usage.inputTokens).toBe(before + 25);
    await pending;

    const tree = await store.load(agent.sessionId);
    if (!tree) throw new Error("session was not saved");
    expect(JSON.stringify(tree.messagesAt())).not.toContain('"side"');
    const resumed = new Agent({ provider: new FakeProvider([]), model: fakeModel, session: store });
    resumed.resume(tree);
    expect(resumed.usage.inputTokens).toBe(before + 25);
    expect(resumed.costReport().lines.find((line) => line.source === "side")?.turns).toBe(1);
  });

  test("external spend before the first run waits for that run's save instead of an empty file", async () => {
    const store = new MemorySessionStore();
    const agent = new Agent({ provider: new FakeProvider([]), model: fakeModel, session: store });
    await agent.recordExternalUsage({
      source: "side",
      model: "fake/fake-1",
      usage: usage(25, 4),
      turns: 1,
    });
    expect(await store.load(agent.sessionId)).toBeUndefined();
    await agent.run("hi");
    const tree = await store.load(agent.sessionId);
    if (!tree) throw new Error("session was not saved");
    const resumed = new Agent({ provider: new FakeProvider([]), model: fakeModel, session: store });
    resumed.resume(tree);
    expect(resumed.usage.inputTokens).toBe(25 + 10);
  });

  test("/cost returns the report as data", async () => {
    const agent = new Agent({ provider: new FakeProvider([]), model: fakeModel });
    await agent.run("hi");
    const registry = registryWithCoreCommands({ costReport: () => agent.costReport() });
    const result = await registry.execute("/cost", {
      inject: () => {},
      print: () => {},
      getModel: () => agent.modelRef,
      setModel: () => {},
      isRunning: () => false,
    });
    const data = result.data as CostReport;
    expect(data.kind).toBe("cost");
    expect(data.totals).toEqual(agent.usage);
    expect(data.context.reported).toBe(true);
    expect(data.context.window).toBe(fakeModel.contextWindow);
  });
});
