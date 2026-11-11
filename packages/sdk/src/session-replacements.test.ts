import { describe, expect, test } from "bun:test";
import { zeroUsage } from "@mu/ai";
import { type AgentMessage, SESSION_VERSION, SessionTree, userMessage } from "@mu/core";
import { appendCompactionBoundary } from "./session-replacements.ts";

function session() {
  const tree = new SessionTree({
    type: "session",
    version: SESSION_VERSION,
    id: "s",
    createdAt: new Date(0).toISOString(),
    profile: "test",
    environment: {},
  });
  const messages = ["one", "two", "three"].map((text) => userMessage(text));
  const entries = messages.map((message) => tree.appendMessage(message));
  return { tree, messages, entries };
}

const meta = {
  trigger: "threshold" as const,
  contextTokensBefore: 100,
  contextTokensAfter: 10,
  model: "fake/fake-1",
  compactorModel: "fake/fake-1",
};

describe("appendCompactionBoundary", () => {
  test("anchors the tail and journals replacements ahead of the boundary", () => {
    const { tree, messages, entries } = session();
    const [one, two, three] = messages as [AgentMessage, AgentMessage, AgentMessage];
    const shortened = userMessage("3");
    const { boundary, replacements } = appendCompactionBoundary(
      tree,
      {
        summary: "earlier work",
        keptMessages: [shortened],
        preservedMessages: [one],
        replacements: [{ original: three, message: shortened }],
        tokensFreed: 90,
        usage: zeroUsage(),
      },
      { ...meta, entryIdOf: (message) => tree.entryIdForMessage(message), recordCleared: true },
    );

    expect(replacements).toEqual([{ entryId: entries[2]?.id as string, message: shortened }]);
    expect(boundary).toMatchObject({
      type: "compaction",
      firstKeptEntryId: entries[2]?.id,
      preservedEntryIds: [entries[0]?.id],
      windowNumber: 1,
      toolResultsCleared: 1,
    });
    const visible = tree.messagesAt();
    expect(visible.length).toBe(3);
    expect(visible[0]?.role).toBe("custom");
    expect(visible.slice(1)).toEqual([one, shortened]);
    expect(visible).not.toContain(two);
  });

  test("an unmappable tail leaves the tree exactly as it was", () => {
    const { tree, messages } = session();
    const before = tree.toJsonl();
    expect(() =>
      appendCompactionBoundary(
        tree,
        {
          summary: "earlier work",
          keptMessages: [userMessage("never stored")],
          replacements: [
            { original: messages[0] as AgentMessage, message: userMessage("shortened") },
          ],
          tokensFreed: 0,
          usage: zeroUsage(),
        },
        { ...meta, entryIdOf: (message) => tree.entryIdForMessage(message) },
      ),
    ).toThrow("tail could not be mapped");
    expect(tree.toJsonl()).toBe(before);
  });
});
