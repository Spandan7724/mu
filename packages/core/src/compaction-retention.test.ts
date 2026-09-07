import { expect, test } from "bun:test";
import {
  applyCompaction,
  compact,
  estimateTokens,
  planCompaction,
  serializeCompactionMessages,
} from "./compaction.ts";
import { type AgentMessage, customMessage, userMessage } from "./messages.ts";
import { IMAGE_TOMBSTONE, microcompact } from "./microcompaction.ts";
import { FakeProvider, fakeModel } from "./testing/fake-provider.ts";

const answer = (text = "progress"): Extract<AgentMessage, { role: "assistant" }> => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: 1,
  model: "fake/fake-1",
  stopReason: "end",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
const output = (text: string, id = "c"): Extract<AgentMessage, { role: "toolResult" }> => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "inspect",
  content: [{ type: "text", text }],
  timestamp: 1,
  isError: false,
});
const response = (text = "## Current task state\nEvidence preserved.") => ({
  content: [{ type: "text" as const, text }],
});
const model = { ...fakeModel, contextWindow: 10_000 };

function evidenceRequests(provider: FakeProvider): string[] {
  return provider.requests.map((request) => {
    const text = request.messages[0]?.content[0];
    if (text?.type !== "text") throw new Error("missing compactor input");
    return /<conversation offset="\d+">\n([\s\S]*)\n<\/conversation>/.exec(text.text)?.[1] ?? "";
  });
}

test("unique observations survive cheap cleanup and reach summarization beyond 2,000 characters", async () => {
  const evidence = `${"prefix ".repeat(800)}MIDDLE_DIAGNOSTIC${" suffix".repeat(800)}`;
  const messages = [
    userMessage("old task"),
    answer(),
    output(evidence),
    answer(),
    userMessage("continue with the diagnostic"),
  ];
  const cleaned = microcompact(messages, { keepRecent: 0, targetTokens: 1 });
  expect(cleaned.messages[2]).toBe(messages[2]);
  const provider = new FakeProvider([response()]);
  const result = await compact(cleaned.messages, { provider, model, keepRecentTokens: 20 });
  expect(evidenceRequests(provider).join("")).toContain(evidence);
  expect(result.keptMessages).toContain(messages[4] as AgentMessage);
});

test("bounded requests process every character of a large source, carrying handoffs between chunks", async () => {
  const text = `begin\n${"middle evidence\n".repeat(7000)}end`;
  const old = output(text);
  const messages = [userMessage("old"), answer(), old, answer(), userMessage("next")];
  const provider = new FakeProvider(Array.from({ length: 30 }, () => response()));
  await compact(messages, { provider, model, keepRecentTokens: 10 });
  const chunks = evidenceRequests(provider);
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.join("")).toContain(serializeCompactionMessages([old]));
  for (const request of provider.requests)
    expect(JSON.stringify(request).length / 3.5).toBeLessThan(model.contextWindow);
  expect(JSON.stringify(provider.requests[1])).toContain("Evidence preserved");
});

test("a transient overflow does not permanently shrink subsequent chunks", async () => {
  const provider = new FakeProvider([
    {
      content: [],
      stopReason: "error",
      errorMessage: "maximum context length exceeded",
      usage: { costUsd: 0.01 },
    },
    ...Array.from({ length: 30 }, () => response()),
  ]);
  const messages = [
    userMessage("old"),
    answer(),
    output("evidence ".repeat(12000)),
    answer(),
    userMessage("next"),
  ];
  const result = await compact(messages, { provider, model, keepRecentTokens: 10 });
  const chunks = evidenceRequests(provider);
  expect(chunks[1]?.length).toBeLessThan(chunks[0]?.length ?? 0);
  expect(chunks[2]?.length).toBeGreaterThan((chunks[1]?.length ?? 0) * 1.5);
  expect(chunks.slice(1).join("")).toContain(
    serializeCompactionMessages([messages[2] as AgentMessage]),
  );
  expect(result.usage.costUsd).toBeCloseTo(0.01 + (provider.callCount - 1) * 0.0001);
});

test("oversized last tool groups retain all call/result envelopes and the exact active request", async () => {
  const call: AgentMessage = {
    ...answer(),
    content: [0, 1, 2].map((i) => ({
      type: "toolCall",
      id: `c${i}`,
      name: "inspect",
      arguments: {},
    })),
  };
  const request = userMessage("Keep the API unchanged. Investigate the failures.");
  const results = [0, 1, 2].map((i) => output(`${i} ${"observation ".repeat(3000)}`, `c${i}`));
  const messages = [userMessage("old"), answer(), request, call, ...results];
  const plan = planCompaction(messages, 1000);
  expect(plan.keepFromIndex).toBe(3);
  const provider = new FakeProvider(Array.from({ length: 30 }, () => response()));
  const result = await compact(messages, { provider, model, keepRecentTokens: 1000 });
  expect(result.preservedMessages).toEqual([request]);
  expect(result.keptMessages[0]).toBe(call);
  expect(
    result.keptMessages
      .slice(1)
      .map((message) => message.role === "toolResult" && message.toolCallId),
  ).toEqual(["c0", "c1", "c2"]);
  expect(result.replacements).toHaveLength(3);
  expect(estimateTokens(applyCompaction(result))).toBeLessThan(7000);
  expect(messages.slice(4)).toEqual(results);
});

test("later-chunk failures and cancellation preserve original messages and report paid usage", async () => {
  const messages = [
    userMessage("old"),
    answer(),
    output("evidence ".repeat(8000)),
    answer(),
    userMessage("next"),
  ];
  const before = structuredClone(messages);
  const provider = new FakeProvider([
    response(),
    { content: [], stopReason: "error", errorMessage: "offline" },
  ]);
  try {
    await compact(messages, { provider, model, keepRecentTokens: 10 });
    throw new Error("expected compaction failure");
  } catch (error) {
    expect(String(error)).toContain("offline");
    expect((error as { usage: { inputTokens: number } }).usage.inputTokens).toBe(20);
  }
  expect(messages).toEqual(before);
  const controller = new AbortController();
  const delayed = new FakeProvider([{ ...response(), delayMs: 10 }]);
  const pending = compact(messages, { provider: delayed, model, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow("Compaction failed");
  expect(messages).toEqual(before);
});

test("incremental compaction keeps the active request and newest pinned snapshots without replaying retired evidence", async () => {
  const pin = (text: string) => ({
    ...customMessage("instructions", text),
    retention: { key: "instructions" },
  });
  const newest = pin("Do not change public names.");
  const request = userMessage("Investigate A, preserving compatibility.");
  const provider = new FakeProvider([
    response("First handoff with constraints"),
    response("Second handoff with constraints"),
  ]);
  const first = await compact(
    [
      pin("obsolete"),
      userMessage("retired evidence 000"),
      answer(),
      newest,
      request,
      answer("some progress"),
      answer("more progress"),
      answer("working"),
      output("last"),
    ],
    { provider, model, keepRecentTokens: 10 },
  );
  const second = await compact(
    [
      ...applyCompaction(first),
      answer("new progress ".repeat(300)),
      answer(),
      output("new result"),
    ],
    { provider, model, keepRecentTokens: 10 },
  );
  expect(second.preservedMessages).toContain(newest);
  expect(second.preservedMessages).toContain(request);
  expect(JSON.stringify(provider.requests[1])).not.toContain("retired evidence 000");
  expect(JSON.stringify(provider.requests[1])).toContain("First handoff with constraints");
  expect(JSON.stringify(applyCompaction(second))).not.toContain("obsolete");
});

test("image expiry counts model turns, preserves text and pins, and retains original payloads", () => {
  const image: AgentMessage = {
    ...output(""),
    content: [
      { type: "text", text: "observation" },
      { type: "image", data: "original", mimeType: "image/png" },
    ],
  };
  const recent = [
    image,
    ...Array.from({ length: 20 }, () => userMessage("notification")),
    answer(),
  ];
  expect(microcompact(recent, { imageRetentionTurns: 2 }).messages[0]).toBe(image);
  const expired = microcompact([...recent, answer()], { imageRetentionTurns: 2 });
  expect(JSON.stringify(expired.messages[0])).toContain(IMAGE_TOMBSTONE);
  expect(JSON.stringify(expired.messages[0])).toContain("observation");
  expect(image.content[1]?.type).toBe("image");
  const userImage: AgentMessage = {
    role: "user",
    content: [{ type: "image", data: "reference", mimeType: "image/png" }],
    timestamp: 1,
  };
  expect(
    microcompact([userImage, answer(), answer()], { imageRetentionTurns: 1 }).messages[0],
  ).toBe(userImage);
});

test("an oversized protected request fails explicitly without deleting or paraphrasing it", async () => {
  const request = userMessage("binding requirement ".repeat(10000));
  const provider = new FakeProvider([]);
  await expect(compact([request], { provider, model })).rejects.toThrow("protected context");
  expect(provider.callCount).toBe(0);
  expect(request.content[0]?.type === "text" && request.content[0].text.length).toBeGreaterThan(
    100000,
  );
});

test("the compactor stops between chunks when its cumulative budget is spent", async () => {
  const provider = new FakeProvider(Array.from({ length: 20 }, () => response()));
  const messages = [
    userMessage("old"),
    answer(),
    output("evidence ".repeat(8000)),
    answer(),
    userMessage("next"),
  ];
  const before = structuredClone(messages);
  await expect(
    compact(messages, {
      provider,
      model,
      keepRecentTokens: 10,
      canContinue: (usage) => usage.inputTokens < 10,
    }),
  ).rejects.toThrow("budget exhausted");
  expect(provider.callCount).toBe(1);
  expect(messages).toEqual(before);
});

test("subagent display transcripts never enter summarizer input", () => {
  const message = {
    ...output("Conclusion with decisive evidence"),
    details: { type: "subagent", messages: [userMessage("PRIVATE_CHILD_TRANSCRIPT")] },
  };
  expect(serializeCompactionMessages([message])).toContain("Conclusion with decisive evidence");
  expect(serializeCompactionMessages([message])).not.toContain("PRIVATE_CHILD_TRANSCRIPT");
});

test("a completed oversized assistant explanation is summarized while the active request stays exact", async () => {
  const request = userMessage("Keep the requirements unchanged.");
  const provider = new FakeProvider(Array.from({ length: 20 }, () => response()));
  const result = await compact([request, answer("long explanation ".repeat(4000))], {
    provider,
    model,
  });
  expect(result.preservedMessages).toEqual([request]);
  expect(estimateTokens(applyCompaction(result))).toBeLessThan(7000);
  expect(evidenceRequests(provider).join("")).toContain("long explanation ".repeat(4000));
});
