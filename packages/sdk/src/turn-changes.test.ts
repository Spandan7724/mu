import { describe, expect, test } from "bun:test";
import {
  type AnyTool,
  type CheckpointProvider,
  SESSION_VERSION,
  SessionTree,
  userMessage,
} from "@mu/core";
import { mappedReplacements } from "./session-replacements.ts";
import { type PendingCheckpoint, TurnChanges } from "./turn-changes.ts";

function tool(extra: Partial<AnyTool>): AnyTool {
  return {
    name: "t",
    description: "t",
    inputSchema: { type: "object" },
    execute: async () => ({ content: [] }),
    ...extra,
  };
}

describe("TurnChanges", () => {
  test("a call that cannot name what it changes marks the turn unknown", async () => {
    const changes = new TurnChanges(undefined, () => undefined);
    await changes.record(tool({ changesState: false }), {});
    expect(changes.unknown).toBe(false);
    await changes.record(tool({ changedResources: () => ["a.ts"] }), {});
    expect([...changes.resources]).toEqual(["a.ts"]);
    expect(changes.unknown).toBe(false);
    await changes.record(tool({}), {});
    expect(changes.unknown).toBe(true);
    await changes.record(
      tool({
        changesState: () => {
          throw new Error("broken classifier");
        },
      }),
      {},
    );
    expect(changes.unknown).toBe(true);
  });

  test("declared coverage records each resource once, before its first change", async () => {
    const captured: string[][] = [];
    const pending: PendingCheckpoint = { beforeEntryId: null, beforeRef: "r0" };
    const provider = {
      coverage: "declared",
      snapshotResources: async (base: string, resources: string[]) => {
        captured.push([base, ...resources]);
        if (resources.includes("locked.ts")) throw new Error("unreadable");
        return `${base}+${resources.join(",")}`;
      },
    } as unknown as CheckpointProvider;
    const changes = new TurnChanges(provider, () => pending);
    const write = tool({ changedResources: (args) => [(args as { path: string }).path] });

    await changes.record(write, { path: "a.ts" });
    await changes.record(write, { path: "a.ts" });
    await changes.record(write, { path: "b.ts" });
    await changes.record(write, { path: "locked.ts" });

    expect(captured).toEqual([
      ["r0", "a.ts"],
      ["r0+a.ts", "b.ts"],
      ["r0+a.ts+b.ts", "locked.ts"],
    ]);
    expect(pending.beforeRef).toBe("r0+a.ts+b.ts");
    expect([...changes.uncaptured]).toEqual(["locked.ts"]);
  });
});

describe("mappedReplacements", () => {
  test("maps rewritten messages to their entries, or refuses the whole set", () => {
    const tree = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: "s",
      createdAt: new Date(0).toISOString(),
      profile: "test",
      environment: {},
    });
    const one = userMessage("one");
    const two = userMessage("two");
    const first = tree.appendMessage(one);
    tree.appendMessage(two);
    const rewritten = userMessage("shortened");

    expect(mappedReplacements(tree, [one, two], [one, two])).toEqual([]);
    expect(mappedReplacements(tree, [one, two], [rewritten, two])).toEqual([
      { entryId: first.id, message: rewritten },
    ]);
    const stranger = userMessage("never stored");
    expect(mappedReplacements(tree, [stranger, two], [rewritten, two])).toBeUndefined();
    expect(mappedReplacements(tree, [one], [one, rewritten])).toBeUndefined();
  });
});
