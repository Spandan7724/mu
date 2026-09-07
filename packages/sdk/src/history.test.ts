import { describe, expect, test } from "bun:test";
import { type ToolResultMessage, zeroUsage } from "@mu/ai";
import { type AgentMessage, ExtensionHost, microcompact, SessionTree, userMessage } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";

function agent(history = true) {
  return new Agent({
    provider: new FakeProvider([]),
    model: fakeModel,
    history,
    autoCompact: false,
  });
}

async function execute(
  owner: Agent,
  name: string,
  args: object,
  signal = new AbortController().signal,
) {
  const tool = owner.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.execute("lookup", args, signal);
}

async function read(owner: Agent, args: object) {
  const result = await execute(owner, "history_read", args);
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("Expected text");
  return JSON.parse(block.text);
}

async function search(owner: Agent, args: object) {
  const result = await execute(owner, "history_search", args);
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("Expected text");
  return JSON.parse(block.text);
}

function observation(text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "capture",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

describe("recoverable session history", () => {
  test("reads original evidence after microcompaction, full compaction, serialization and resume", async () => {
    const owner = agent();
    const original = observation("original diagnostic ".repeat(500));
    const entry = owner.session.appendMessage(original);
    const micro = microcompact([original], { keepRecent: 0 });
    const replacement = micro.messages[0];
    if (!replacement) throw new Error("Missing compacted result");
    owner.session.append({
      type: "microcompaction",
      replacements: [{ entryId: entry.id, message: replacement }],
    });
    owner.session.append({
      type: "compaction",
      summary: "Diagnostic inspected",
      firstKeptEntryId: null,
    });
    const resumed = agent();
    resumed.resume(SessionTree.fromJsonl(owner.session.toJsonl()));
    expect(JSON.stringify(resumed.session.messagesAt())).not.toContain("original diagnostic");
    const result = await search(resumed, { query: "original diagnostic" });
    expect(result.matches[0].entryId).toBe(entry.id);
    expect((await read(resumed, { entryId: entry.id })).text).toContain("original diagnostic");
  });

  test("bounds pages and recovers exact text at offsets beyond the summarizer's input limit", async () => {
    const owner = agent();
    const text = `${"prefix ".repeat(900)}FIND[ME].* ${"suffix ".repeat(900)}`;
    const entry = owner.session.appendMessage(userMessage(text));
    const found = await search(owner, { query: "find[me].*" });
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0].text).toContain("FIND[ME].*");
    expect(found.matches[0].text.length).toBeLessThanOrEqual(600);
    expect(found.matches[0].offset).toBeGreaterThan(2_000);
    let offset = 0;
    let reconstructed = "";
    for (;;) {
      const page = await read(owner, { entryId: entry.id, offset, maxChars: 997 });
      expect(page.text.length).toBeLessThanOrEqual(997);
      reconstructed += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(reconstructed).toBe(text);
    expect(
      (await execute(owner, "history_read", { entryId: entry.id, maxChars: 8_001 })).isError,
    ).toBe(true);
    expect(
      (await execute(owner, "history_read", { entryId: entry.id, offset: text.length + 1 }))
        .isError,
    ).toBe(true);
  });

  test("search pagination uses stable references even when another message is appended", async () => {
    const owner = agent();
    const entries = Array.from({ length: 8 }, (_, i) =>
      owner.session.appendMessage(userMessage(`marker ${i}`)),
    );
    const page = await search(owner, { query: "marker", limit: 3 });
    expect(page.matches.map((hit: { entryId: string }) => hit.entryId)).toEqual(
      entries
        .slice(-3)
        .reverse()
        .map((entry) => entry.id),
    );
    owner.session.appendMessage(userMessage("marker appended after first page"));
    const next = await search(owner, { query: "marker", limit: 10, before: page.nextBefore });
    expect(next.matches.map((hit: { entryId: string }) => hit.entryId)).toEqual(
      entries
        .slice(0, 5)
        .reverse()
        .map((entry) => entry.id),
    );
    expect(next.nextBefore).toBeUndefined();
  });

  test("forks and new sessions cannot retrieve inactive branch evidence even by exact reference", async () => {
    const owner = agent();
    const shared = owner.session.appendMessage(userMessage("shared constraint"));
    const discarded = owner.session.appendMessage(userMessage("discarded decision"));
    expect((await search(owner, { query: "discarded" })).matches).toHaveLength(1);
    expect((await owner.fork(shared.id)).ok).toBe(true);
    owner.session.appendMessage(userMessage("replacement decision"));
    expect((await search(owner, { query: "discarded" })).matches).toHaveLength(0);
    expect((await execute(owner, "history_read", { entryId: discarded.id })).isError).toBe(true);
    expect(
      (
        await execute(owner, "history_search", {
          query: "shared",
          before: { entryId: discarded.id },
        })
      ).isError,
    ).toBe(true);
    expect((await read(owner, { entryId: shared.id })).text).toBe("shared constraint");
    owner.newSession();
    expect((await execute(owner, "history_read", { entryId: shared.id })).isError).toBe(true);
    expect((await search(owner, { query: "shared" })).matches).toHaveLength(0);
  });

  test("completed child observations are addressable without exposing thinking or arbitrary details", async () => {
    const owner = agent();
    const child: AgentMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private-thought" },
        { type: "text", text: "visible rationale" },
      ],
      model: "fake/fake-1",
      usage: zeroUsage(),
      stopReason: "end",
      timestamp: 1,
    };
    const entry = owner.session.appendMessage({
      ...observation("Task finished"),
      details: {
        type: "subagent",
        messages: [
          child,
          observation("child diagnostic"),
          null,
          { role: "assistant", content: [null], timestamp: 1 },
        ],
        arbitrary: "private-metadata",
      },
    });
    const found = await search(owner, { query: "child diagnostic" });
    expect(found.matches[0]).toMatchObject({
      entryId: entry.id,
      childMessage: 1,
      role: "toolResult",
    });
    expect((await read(owner, { entryId: entry.id, childMessage: 1 })).text).toContain(
      "child diagnostic",
    );
    expect((await search(owner, { query: "private" })).matches).toHaveLength(0);
    expect((await read(owner, { entryId: entry.id, childMessage: 0 })).text).toBe(
      "visible rationale",
    );
    expect(
      (await execute(owner, "history_read", { entryId: entry.id, childMessage: 2 })).isError,
    ).toBe(true);
  });

  test("tool observations include their original call arguments and history traffic is not reindexed", async () => {
    const owner = agent();
    owner.session.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "capture",
          name: "bash",
          arguments: { command: "test-original-source" },
        },
      ],
      model: "fake/fake-1",
      usage: zeroUsage(),
      stopReason: "toolUse",
      timestamp: 1,
    });
    const entry = owner.session.appendMessage(observation("diagnostic"));
    const found = await search(owner, { query: "test-original-source" });
    expect(found.matches[0].entryId).toBe(entry.id);
    owner.session.appendMessage({
      ...observation("recursive-needle"),
      toolName: "history_read",
    } as AgentMessage);
    expect((await search(owner, { query: "recursive-needle" })).matches).toHaveLength(0);
  });

  test("children get independent readers even when given every parent tool", async () => {
    const parent = agent();
    const entry = parent.session.appendMessage(userMessage("parent-only constraint"));
    const child = parent.createChild({ systemPrompt: "child", tools: parent.tools });
    expect(child.tools.find((tool) => tool.name === "history_read")).not.toBe(
      parent.tools.find((tool) => tool.name === "history_read"),
    );
    expect((await search(child, { query: "parent-only" })).matches).toHaveLength(0);
    expect((await execute(child, "history_read", { entryId: entry.id })).isError).toBe(true);
    child.session.appendMessage(userMessage("child-only fact"));
    expect((await search(child, { query: "child-only" })).matches).toHaveLength(1);
    expect((await search(parent, { query: "child-only" })).matches).toHaveLength(0);
  });

  test("uses normal permissions and event persistence in the real loop", async () => {
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "lookup",
            name: "history_search",
            arguments: { query: "sensitive" },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const owner = new Agent({
      provider,
      model: fakeModel,
      history: true,
      permissions: [{ permission: "history_search", pattern: "*", action: "deny" }],
    });
    owner.session.appendMessage(userMessage("sensitive evidence"));
    const result = await owner.run("look up earlier evidence");
    const lookup = result.messages.find((message) => message.role === "toolResult");
    expect(lookup?.role === "toolResult" && lookup.isError).toBe(true);
    expect(JSON.stringify(lookup)).toContain("Permission denied");
    const persisted = await owner.sessionStore.load(owner.sessionId);
    expect(JSON.stringify(persisted?.messagesAt())).toContain("Permission denied");
  });

  test("tool allowlists and caller overrides remain authoritative", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "done" }] }]);
    const host = new ExtensionHost();
    const override = {
      name: "history_read",
      description: "custom",
      inputSchema: { type: "object" },
      execute: async () => ({ content: [] }),
    };
    await host.register({ name: "custom-history", activate: (api) => api.registerTool(override) });
    const owner = new Agent({ provider, model: fakeModel, history: true, extensions: host });
    expect(owner.tools.filter((tool) => tool.name === "history_read")).toEqual([override]);
    await owner.run("go", { allowedTools: [] });
    expect(provider.requests[0]?.tools ?? []).toEqual([]);
    expect(agent(false).tools).toEqual([]);
  });

  test("cancelled lookups do not traverse history", async () => {
    const owner = agent();
    owner.session.appendMessage(userMessage("evidence"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      execute(owner, "history_search", { query: "evidence" }, controller.signal),
    ).rejects.toThrow();
  });

  test("a running large-history search yields so cancellation can interrupt it", async () => {
    const owner = agent();
    for (let i = 0; i < 2_000; i++) owner.session.appendMessage(userMessage(`evidence ${i}`));
    const controller = new AbortController();
    const pending = execute(owner, "history_search", { query: "absent" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  test("automatic eviction installs durable original references and respects tool allowlists", async () => {
    for (const allowHistory of [true, false]) {
      const provider = new FakeProvider([{ content: [{ type: "text", text: "done" }] }]);
      const owner = new Agent({
        provider,
        model: { ...fakeModel, contextWindow: 20_000 },
        history: true,
      });
      const entry = owner.session.appendMessage(observation("original evidence ".repeat(3_000)));
      for (let i = 0; i < 6; i++) owner.session.appendMessage(userMessage(`recent ${i}`));
      await owner.run("continue", allowHistory ? undefined : { allowedTools: [] });
      const evicted = owner.session.messagesAt()[0];
      expect(evicted?.role === "toolResult" && evicted.evicted).toBe(true);
      expect(JSON.stringify(evicted).includes("history_read")).toBe(allowHistory);
      if (allowHistory) {
        expect(JSON.stringify(evicted)).toContain(entry.id);
        expect((await read(owner, { entryId: entry.id })).text).toContain("original evidence");
      }
      const saved = await owner.sessionStore.load(owner.sessionId);
      expect(saved?.messagesAt()[0]).toEqual(evicted);
    }
  });
});
