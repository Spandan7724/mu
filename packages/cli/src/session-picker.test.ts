import { describe, expect, test } from "bun:test";
import { MemorySessionStore, SESSION_VERSION, SessionTree, userMessage } from "@mu/core";
import { resumePickerItems, sessionPickerLabel } from "./session-picker.ts";

function session(id: string, firstPrompt?: string): SessionTree {
  const tree = new SessionTree({
    type: "session",
    version: SESSION_VERSION,
    id,
    createdAt: "2026-07-27T00:00:00.000Z",
    profile: "coding",
    environment: {},
  });
  if (firstPrompt !== undefined) tree.appendMessage(userMessage(firstPrompt));
  return tree;
}

describe("resume picker labels", () => {
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
