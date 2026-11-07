import { describe, expect, test } from "bun:test";
import { MemorySessionStore, SESSION_VERSION, SessionTree, userMessage } from "@mu/core";
import { normalizeSessionTitle, resumePickerItems, sessionPickerLabel } from "./session-picker.ts";

function session(
  id: string,
  firstPrompt?: string,
  createdAt = "2026-07-27T00:00:00.000Z",
): SessionTree {
  const tree = new SessionTree({
    type: "session",
    version: SESSION_VERSION,
    id,
    createdAt,
    profile: "coding",
    environment: {},
  });
  if (firstPrompt !== undefined) tree.appendMessage(userMessage(firstPrompt));
  return tree;
}

describe("resume picker labels", () => {
  test("normalizes entered titles", () => {
    expect(normalizeSessionTitle("  Authentication\n cleanup  ")).toBe("Authentication cleanup");
  });

  test("prefers a saved conversation title", () => {
    const tree = session("session-a", "first prompt");
    tree.setTitle("  Authentication\n cleanup  ");

    expect(sessionPickerLabel(tree, "session-a")).toBe("Authentication cleanup");
  });

  test("uses the first user message and normalizes it to one line", () => {
    const tree = session("session-a", "  fix the login\n\nflow  ");
    tree.appendMessage(userMessage("this later message is not the title"));

    expect(sessionPickerLabel(tree, "session-a")).toBe("fix the login flow");
  });

  test("uses the first user message on the active branch", () => {
    const tree = session("session-a", "abandoned prompt");
    tree.fork(null);
    tree.appendMessage(userMessage("current branch prompt"));

    expect(sessionPickerLabel(tree, "session-a")).toBe("current branch prompt");
  });

  test("falls back to the session id when no text prompt is available", () => {
    expect(sessionPickerLabel(session("session-a"), "session-a")).toBe("session-a");
  });

  test("keeps duplicate prompts mapped to their distinct session ids", async () => {
    const store = new MemorySessionStore();
    await store.save("session-a", session("session-a", "same prompt"));
    await store.save("session-b", session("session-b", "same prompt"));

    expect(await resumePickerItems(store)).toEqual([
      { label: "same prompt", value: "session-a" },
      { label: "same prompt", value: "session-b" },
    ]);
  });

  test("orders sessions from newest to oldest regardless of store order", async () => {
    const store = new MemorySessionStore();
    await store.save("oldest", session("oldest", "old work", "2026-07-25T12:00:00.000Z"));
    await store.save("newest", session("newest", "new work", "2026-07-27T12:00:00.000Z"));
    await store.save("middle", session("middle", "middle work", "2026-07-26T12:00:00.000Z"));

    expect((await resumePickerItems(store)).map((item) => item.value)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  test("a fork says which session it came from", async () => {
    const store = new MemorySessionStore();
    await store.save("parent", session("parent", "explain js", "2026-07-25T12:00:00.000Z"));
    const fork = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: "child",
      createdAt: "2026-07-26T12:00:00.000Z",
      profile: "coding",
      environment: {},
      forkedFrom: { sessionId: "parent", entryId: null },
    });
    fork.appendMessage(userMessage("explain ts"));
    await store.save("child", fork);
    const orphan = new SessionTree({
      ...(fork.header as NonNullable<typeof fork.header>),
      id: "orphan",
      createdAt: "2026-07-27T12:00:00.000Z",
      forkedFrom: { sessionId: "deleted", entryId: null },
    });
    await store.save("orphan", orphan);

    expect(await resumePickerItems(store)).toEqual([
      { label: "orphan", value: "orphan", description: "forked from deleted" },
      { label: "explain ts", value: "child", description: "forked from explain js" },
      { label: "explain js", value: "parent" },
    ]);
  });

  test("a corrupt session remains selectable by its id", async () => {
    const items = await resumePickerItems({
      list: async () => ["broken-session"],
      load: async () => {
        throw new Error("bad jsonl");
      },
    });

    expect(items).toEqual([{ label: "broken-session", value: "broken-session" }]);
  });
});
