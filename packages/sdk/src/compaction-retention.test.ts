import { expect, test } from "bun:test";
import { type AgentMessage, customMessage, SessionTree, userMessage } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";

const summary = {
  content: [
    {
      type: "text" as const,
      text: "## Current task state\nKeep compatibility. Continue investigating the failure.",
    },
  ],
};
const call: AgentMessage = {
  role: "assistant",
  content: [0, 1, 2].map((i) => ({
    type: "toolCall",
    id: `c${i}`,
    name: "inspect",
    arguments: { i },
  })),
  timestamp: 1,
  model: "fake/fake-1",
  stopReason: "toolUse",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const model = { ...fakeModel, contextWindow: 10000 };

test("automatic compaction of an oversized live tool group preserves envelopes and resumes from the same context", async () => {
  const provider = new FakeProvider([
    { content: call.content },
    ...Array.from({ length: 30 }, () => summary),
  ]);
  const request = "Investigate this failure without changing the public API.";
  const agent = new Agent({
    provider,
    model,
    tools: [
      {
        name: "inspect",
        description: "Inspect evidence",
        inputSchema: { type: "object" },
        execute: async (_id, args) => ({
          content: [{ type: "text", text: `${args.i} ${"observation ".repeat(3000)}` }],
        }),
      },
    ],
  });
  const result = await agent.run(request);
  expect(result.reason).toBe("done");
  const live = agent.session.messagesAt();
  expect(
    live.some(
      (message) =>
        message.role === "user" &&
        message.content[0]?.type === "text" &&
        message.content[0].text === request,
    ),
  ).toBe(true);
  expect(
    live
      .filter((message) => message.role === "toolResult")
      .map((message) => message.role === "toolResult" && message.toolCallId),
  ).toEqual(["c0", "c1", "c2"]);
  expect(JSON.stringify(live)).toContain("Condensed tool observation");
  const original = agent.session
    .activePath()
    .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
  expect(original).toHaveLength(3);
  expect(JSON.stringify(original)).toContain("observation ".repeat(3000));
  const reloaded = SessionTree.fromJsonl(agent.session.toJsonl());
  expect(reloaded.messagesAt()).toEqual(live);
  const last = provider.requests.at(-1);
  expect(JSON.stringify(last)).toContain("Condensed tool observation");
  expect(result.usage.inputTokens).toBe(provider.callCount * 10);
});

test("manual compaction and repeated resume preserve the exact active request and latest instruction snapshot", async () => {
  const provider = new FakeProvider(Array.from({ length: 40 }, () => summary));
  const agent = new Agent({ provider, model, autoCompact: false });
  await agent.run("earlier task");
  agent.session.appendMessage({
    ...customMessage("instructions-v1", "obsolete instruction"),
    retention: { key: "instructions" },
  });
  agent.session.appendMessage({
    ...customMessage("instructions-v2", "Never rename public exports."),
    retention: { key: "instructions" },
  });
  agent.session.appendMessage(userMessage("Keep the API unchanged. Resolve the latest failure."));
  agent.session.appendMessage(call);
  for (let i = 0; i < 3; i++)
    agent.session.appendMessage({
      role: "toolResult",
      toolCallId: `c${i}`,
      toolName: "inspect",
      content: [{ type: "text", text: `${i} ${"evidence ".repeat(4000)}` }],
      timestamp: 1,
      isError: false,
    });
  expect((await agent.compactNow()).status).toBe("completed");
  const first = agent.session.messagesAt();
  expect(JSON.stringify(first)).toContain("Never rename public exports.");
  expect(JSON.stringify(first)).not.toContain("obsolete instruction");
  expect(JSON.stringify(first)).toContain("Keep the API unchanged. Resolve the latest failure.");
  const resumed = new Agent({ provider, model, autoCompact: false });
  resumed.resume(SessionTree.fromJsonl(agent.session.toJsonl()));
  await resumed.run("Continue, and preserve compatibility.");
  expect((await resumed.compactNow()).status).toBe("completed");
  expect(JSON.stringify(resumed.session.messagesAt())).toContain("Never rename public exports.");
  expect(JSON.stringify(resumed.session.messagesAt())).toContain(
    "Continue, and preserve compatibility.",
  );
  expect(SessionTree.fromJsonl(resumed.session.toJsonl()).messagesAt()).toEqual(
    resumed.session.messagesAt(),
  );
});

test("image expiry persists the tombstone without changing the original image", async () => {
  const image: AgentMessage = {
    role: "toolResult",
    toolName: "inspect",
    toolCallId: "image",
    timestamp: 1,
    isError: false,
    content: [{ type: "image", mimeType: "image/png", data: "original-payload" }],
  };
  const provider = new FakeProvider(Array.from({ length: 10 }, () => summary));
  const agent = new Agent({
    provider,
    model: fakeModel,
    imageRetentionTurns: 2,
    initialMessages: [
      { ...call, content: [{ type: "toolCall", id: "image", name: "inspect", arguments: {} }] },
      image,
    ],
  });
  await agent.run("inspect");
  await agent.run("continue");
  expect(JSON.stringify(agent.session.messagesAt())).toContain("original-payload");
  await agent.run("continue again");
  expect(JSON.stringify(agent.session.messagesAt())).not.toContain("original-payload");
  expect(JSON.stringify(agent.session.activePath())).toContain("original-payload");
  expect(SessionTree.fromJsonl(agent.session.toJsonl()).messagesAt()).toEqual(
    agent.session.messagesAt(),
  );
});

test("invalid preserved references cannot remove visible history", () => {
  const tree = new SessionTree({
    type: "session",
    version: 1,
    id: "test",
    createdAt: "2026-09-07T00:00:00.000Z",
    profile: "test",
    environment: {},
  });
  tree.appendMessage(userMessage("must remain"));
  const before = tree.messagesAt();
  tree.append({
    type: "compaction",
    summary: "invalid",
    firstKeptEntryId: null,
    preservedEntryIds: ["missing"],
  });
  expect(tree.messagesAt()).toEqual(before);
});

test("model response caps respect the remaining window even when the catalog allows a larger output", async () => {
  const provider = new FakeProvider([summary]);
  const agent = new Agent({ provider, model: { ...model, maxOutput: 20_000 }, autoCompact: false });
  await agent.run("request ".repeat(1000));
  const limit = provider.streamOptions[0]?.maxTokens;
  expect(limit).toBeDefined();
  expect(limit).toBeGreaterThan(0);
  expect(limit).toBeLessThan(7500);
});
