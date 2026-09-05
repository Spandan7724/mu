import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userMessage } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";
import { FileSessionStore } from "./file-store.ts";
import { compactionScenario } from "./testing/compaction-scenario.ts";

test("repeated compaction preserves the evidence for a corrected task without history lookups", async () => {
  const root = await mkdtemp(join(tmpdir(), "mu-compaction-evidence-"));
  try {
    const result = await compactionScenario(true, new FileSessionStore({ root }));
    expect(result.firstTaskEvidencePreserved).toBe(true);
    expect(result.nextTaskEvidenceAbsentFromFirstHandoff).toBe(true);
    expect(result.correctActions).toBe(1);
    expect(result.attemptedActions).toBe(1);
    expect(result.historyCalls).toBe(0);
    expect(result.contextTokens).toBeLessThan(2_800); // same 1,200 summary + 1,600 tail budget
    expect(result.compactorCalls).toBeGreaterThan(3);
    expect(JSON.stringify(result.finalContext)).toContain("retry_limit=7");
    expect(JSON.stringify(result.finalContext)).toContain(result.evidenceSourceId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same policy cannot take the evidence-dependent action with the old compactor inputs", async () => {
  const result = await compactionScenario(false);
  expect(result.firstTaskEvidencePreserved).toBe(false);
  expect(result.correctActions).toBe(0);
  expect(result.historyCalls).toBe(0);
});

test("a failed later chunk preserves the live context and persists all compactor costs", async () => {
  const provider = new FakeProvider([
    { content: [{ type: "text", text: "partial handoff" }], usage: { costUsd: 0.2 } },
    { content: [], errorMessage: "second chunk failed", usage: { costUsd: 0.3 } },
  ]);
  const agent = new Agent({
    provider,
    model: { ...fakeModel, contextWindow: 8_000 },
    autoCompact: false,
  });
  agent.session.appendMessage(userMessage("critical constraint\n".repeat(5_000)));
  const before = agent.session.messagesAt();
  const result = await agent.compactNow();
  expect(result.status).toBe("failed");
  expect(agent.session.messagesAt()).toEqual(before);
  expect(agent.session.activePath().at(-1)?.type).toBe("compaction-attempt");
  expect(agent.usage.costUsd).toBe(0.5);
  const saved = await agent.sessionStore.load(agent.sessionId);
  if (!saved) throw new Error("Missing saved session");
  const resumed = new Agent({ provider: new FakeProvider([]), model: fakeModel });
  resumed.resume(saved);
  expect(resumed.usage.costUsd).toBe(0.5);
  expect(resumed.session.messagesAt()).toEqual(before);
});

test("compaction checks the budget between source chunks and leaves an incomplete handoff uninstalled", async () => {
  const provider = new FakeProvider([
    { content: [{ type: "text", text: "partial handoff" }], usage: { costUsd: 0.2 } },
  ]);
  const agent = new Agent({
    provider,
    model: { ...fakeModel, contextWindow: 8_000 },
    autoCompact: false,
    budget: { maxCostUsd: 0.1 },
  });
  agent.session.appendMessage(userMessage("critical constraint\n".repeat(5_000)));
  const before = agent.session.messagesAt();
  const result = await agent.compactNow();
  expect(result.status).toBe("failed");
  expect(provider.callCount).toBe(1);
  expect(agent.usage.costUsd).toBe(0.2);
  expect(agent.session.messagesAt()).toEqual(before);
});

test("original compaction sources exclude discarded branches", async () => {
  const provider = new FakeProvider([
    { content: [{ type: "text", text: "active branch handoff" }] },
  ]);
  const agent = new Agent({ provider, model: fakeModel, autoCompact: false });
  const root = agent.session.appendMessage(userMessage("shared instruction"));
  agent.session.appendMessage(userMessage("discarded-branch-constraint"));
  agent.session.fork(root.id);
  agent.session.appendMessage(userMessage("active-branch-constraint"));
  expect((await agent.compactNow()).status).toBe("completed");
  expect(JSON.stringify(provider.requests)).toContain("active-branch-constraint");
  expect(JSON.stringify(provider.requests)).not.toContain("discarded-branch-constraint");
});
