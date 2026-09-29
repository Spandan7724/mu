import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userMessage } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent, optionsFromProfile } from "mu";
import { browserProfile } from "../index.ts";

test("compaction mid-task keeps URL/tabs, todo, notes and the ledger", async () => {
  const profile = await browserProfile({ home: mkdtempSync(join(tmpdir(), "mu-carry-")) });
  const provider = new FakeProvider([
    { content: [{ type: "text", text: "summary of the shopping task" }] },
    { content: [{ type: "text", text: "continuing" }] },
  ]);
  const options = await optionsFromProfile(profile, "fake/fake-1", {
    provider,
    model: { ...fakeModel, contextWindow: 16_000 },
    compactThreshold: 0.4,
  });
  const agent = new Agent({
    ...options,
    initialMessages: [
      ...(options.initialMessages ?? []),
      userMessage("context filler. ".repeat(400)),
    ],
  });
  await profile.refreshContext?.([], { sessionId: agent.sessionId });
  profile.notes.replace("prices", "Classic Mug $12.50\nTall Mug $9.99");
  profile.ledger.append({
    id: "c1",
    at: Date.UTC(2026, 8, 29, 10, 42),
    host: "mail.test",
    url: "https://mail.test/",
    action: "click",
    target: 'button "Send" [e13]',
  });
  profile.todos.replace([{ content: "compare mug prices", status: "in_progress" }]);
  const carryover = profile.carryoverExtractor?.([]) as Record<string, unknown>;
  expect(carryover).toMatchObject({
    todo: [{ content: "compare mug prices", status: "in_progress" }],
    notes: [{ key: "prices", text: "Classic Mug $12.50\nTall Mug $9.99" }],
    commitsAlreadyPerformed: [{ host: "mail.test", target: 'button "Send" [e13]' }],
    browser: { tabs: [] },
  });

  await agent.run("continue the task");
  const request = provider.requests.at(-1);
  const text = (request?.messages ?? [])
    .flatMap((message) =>
      message.role === "user"
        ? message.content.filter((c) => c.type === "text").map((c) => c.text)
        : [],
    )
    .join("\n");
  expect(text).toContain("summary of the shopping task");
  expect(text).toContain("Classic Mug $12.50");
  expect(text).toContain("compare mug prices");
  expect(text).toContain('button \\"Send\\" [e13]');
  expect(text).toContain("never repeat them");
  await agent.shutdown();
});
