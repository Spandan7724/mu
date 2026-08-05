import { describe, expect, test } from "bun:test";
import { customMessage, userMessage } from "./messages.ts";
import {
  MemorySessionStore,
  parseSession,
  SESSION_VERSION,
  SessionTree,
  serializeSession,
} from "./session.ts";

function newTree(): SessionTree {
  return new SessionTree({
    type: "session",
    version: SESSION_VERSION,
    id: "s1",
    createdAt: "2026-07-26T00:00:00.000Z",
    profile: "coding",
    environment: { scope: "test" },
  });
}

function assistant(text: string, signature?: string) {
  return {
    role: "assistant" as const,
    content: signature
      ? [
          { type: "thinking" as const, thinking: "reasoning", signature },
          { type: "text" as const, text },
        ]
      : [{ type: "text" as const, text }],
    model: "fake/fake-1",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end" as const,
    timestamp: 1,
  };
}

describe("SessionTree", () => {
  test("writes and reloads a JSONL tree", () => {
    const tree = newTree();
    tree.appendMessage(userMessage("hello"));
    tree.appendMessage(assistant("hi there"));

    const jsonl = tree.toJsonl();
    expect(jsonl.split("\n").filter(Boolean).length).toBe(3); // header + 2
    const reloaded = SessionTree.fromJsonl(jsonl);
    expect(reloaded.header?.id).toBe("s1");
    expect(reloaded.messagesAt().length).toBe(2);
    expect(reloaded.toJsonl()).toBe(jsonl);
  });

  test("thinking signatures round-trip through storage", () => {
    const tree = newTree();
    tree.appendMessage(assistant("answer", "SIG_ROUNDTRIP"));
    const reloaded = SessionTree.fromJsonl(tree.toJsonl());
    const message = reloaded.messagesAt()[0];
    expect(message?.role).toBe("assistant");
    if (message?.role === "assistant") {
      const thinking = message.content.find((c) => c.type === "thinking");
      expect(thinking?.type === "thinking" && thinking.signature).toBe("SIG_ROUNDTRIP");
    }
  });

  test("entries form a parent chain", () => {
    const tree = newTree();
    const a = tree.appendMessage(userMessage("a"));
    const b = tree.appendMessage(userMessage("b"));
    expect(a.parentId).toBeNull();
    expect(b.parentId).toBe(a.id);
    expect(tree.activePath().map((e) => e.id)).toEqual([a.id, b.id]);
  });

  test("fork branches from an arbitrary entry", () => {
    const tree = newTree();
    const first = tree.appendMessage(userMessage("shared"));
    tree.appendMessage(userMessage("branch-1"));
    expect(tree.messagesAt().length).toBe(2);

    tree.fork(first.id);
    tree.appendMessage(userMessage("branch-2"));

    const texts = tree
      .messagesAt()
      .map((m) => (m.role === "user" && m.content[0]?.type === "text" ? m.content[0].text : ""));
    expect(texts).toEqual(["shared", "branch-2"]);
    // The abandoned branch is still on disk — nothing is destroyed by forking.
    expect(tree.all().length).toBe(4);
  });

  test("forking from an unknown entry throws", () => {
    const tree = newTree();
    expect(() => tree.fork("nope")).toThrow("unknown entry");
  });

  test("resume reconstructs the active branch only", () => {
    const tree = newTree();
    const root = tree.appendMessage(userMessage("root"));
    tree.appendMessage(userMessage("dead-end"));
    tree.fork(root.id);
    tree.appendMessage(userMessage("live"));

    const reloaded = SessionTree.fromJsonl(tree.toJsonl());
    // Reload replays in file order, so head is the last written entry.
    const texts = reloaded
      .messagesAt()
      .map((m) => (m.role === "user" && m.content[0]?.type === "text" ? m.content[0].text : ""));
    expect(texts).toEqual(["root", "live"]);
  });

  test("compaction entry rebuilds context as summary + tail", () => {
    const tree = newTree();
    tree.appendMessage(userMessage("old-1"));
    tree.appendMessage(userMessage("old-2"));
    const kept = tree.appendMessage(userMessage("kept"));
    tree.append({
      type: "compaction",
      summary: "Earlier discussion summarized.",
      carryover: { files: ["a", "b"] },
      firstKeptEntryId: kept.id,
    });
    tree.appendMessage(userMessage("after"));

    const messages = tree.messagesAt();
    const texts = messages.map((m) =>
      m.role === "custom" || m.role === "user"
        ? m.content[0]?.type === "text"
          ? m.content[0].text
          : ""
        : "",
    );
    expect(texts[0]).toContain("Earlier discussion summarized.");
    expect(texts[0]).toContain('"files"');
    expect(texts.slice(1)).toEqual(["kept", "after"]);
    expect(messages[0]?.role).toBe("custom");
  });

  test("a compaction entry's compactor usage survives a JSONL round-trip", () => {
    const tree = newTree();
    tree.appendMessage(userMessage("old-1"));
    const kept = tree.appendMessage(userMessage("kept"));
    const usage = {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    };
    tree.append({
      type: "compaction",
      summary: "Earlier discussion summarized.",
      firstKeptEntryId: kept.id,
      usage,
    });

    const reloaded = SessionTree.fromJsonl(tree.toJsonl());
    const entry = reloaded.activePath().find((e) => e.type === "compaction");
    expect(entry?.type === "compaction" && entry.usage).toEqual(usage);
  });

  test("a malformed compaction anchor preserves the original transcript", () => {
    const tree = newTree();
    tree.appendMessage(userMessage("old-1"));
    tree.appendMessage(userMessage("old-2"));
    tree.append({
      type: "compaction",
      summary: "must not replace history",
      firstKeptEntryId: "missing",
    });
    tree.appendMessage(userMessage("after"));

    const texts = tree
      .messagesAt()
      .filter((message) => message.role === "user")
      .map((message) => (message.content[0]?.type === "text" ? message.content[0].text : ""));
    expect(texts).toEqual(["old-1", "old-2", "after"]);
    expect(tree.messagesAt().some((message) => message.role === "custom")).toBe(false);
  });

  test("microcompaction replacements survive a JSONL round-trip", () => {
    const tree = newTree();
    const result = tree.appendMessage({
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "large output" }],
      isError: false,
      timestamp: 1,
    });
    tree.append({
      type: "microcompaction",
      replacements: [
        {
          entryId: result.id,
          message: {
            role: "toolResult",
            toolCallId: "call",
            toolName: "read",
            content: [{ type: "text", text: "[cleared]" }],
            isError: false,
            evicted: true,
            timestamp: 1,
          },
        },
      ],
    });

    expect(SessionTree.fromJsonl(tree.toJsonl()).messagesAt()).toEqual(tree.messagesAt());
  });

  test("checkpointRef is preserved on message entries", () => {
    const tree = newTree();
    tree.appendMessage(userMessage("mutating step"), "abc123");
    const reloaded = SessionTree.fromJsonl(tree.toJsonl());
    const entry = reloaded.activePath()[0];
    expect(entry?.type === "message" && entry.checkpointRef).toBe("abc123");
  });

  test("checkpoint steps preserve both state refs and the conversation target", () => {
    const tree = newTree();
    const message = userMessage("change it");
    const prompt = tree.appendMessage(message);
    const entry = tree.append({
      type: "checkpoint",
      beforeEntryId: prompt.id,
      checkpointRef: "before",
      checkpointAfterRef: "after",
      label: "change",
    });

    const loaded = SessionTree.fromJsonl(tree.toJsonl()).get(entry.id);
    expect(loaded).toEqual(entry);
    expect(SessionTree.fromJsonl(tree.toJsonl()).messagesAt()).toEqual([message]);
  });

  test("forking to the session root clears the active transcript", () => {
    const tree = newTree();
    tree.appendMessage(userMessage("one"));
    tree.fork(null);

    expect(tree.head).toBeNull();
    expect(tree.messagesAt()).toEqual([]);
  });

  test("custom messages survive the round trip", () => {
    const tree = newTree();
    tree.appendMessage(customMessage("system-reminder", "stop repeating", true));
    const reloaded = SessionTree.fromJsonl(tree.toJsonl());
    const message = reloaded.messagesAt()[0];
    expect(message?.role).toBe("custom");
    if (message?.role === "custom") {
      expect(message.customType).toBe("system-reminder");
      expect(message.display).toBe(true);
    }
  });

  test("settings-change entries are recorded without affecting the transcript", () => {
    const tree = newTree();
    tree.appendMessage(userMessage("hi"));
    tree.append({ type: "settings-change", model: "anthropic/claude-opus-5" });
    tree.appendMessage(userMessage("bye"));
    expect(tree.messagesAt().length).toBe(2);
    expect(tree.all().some((e) => e.type === "settings-change")).toBe(true);
  });
});

describe("jsonl helpers", () => {
  test("serialize/parse round-trip", () => {
    const tree = newTree();
    tree.appendMessage(userMessage("x"));
    const entries = tree.all();
    expect(parseSession(serializeSession(entries))).toEqual(entries);
  });

  test("blank lines are ignored on parse", () => {
    expect(
      parseSession('\n{"type":"custom","id":"a","parentId":null,"customType":"x","data":1}\n\n')
        .length,
    ).toBe(1);
  });
});

describe("MemorySessionStore", () => {
  test("saves, lists and loads sessions", async () => {
    const store = new MemorySessionStore();
    const tree = newTree();
    tree.appendMessage(userMessage("persisted"));
    await store.save("s1", tree);

    expect(await store.list()).toEqual(["s1"]);
    const loaded = await store.load("s1");
    expect(loaded?.messagesAt().length).toBe(1);
    expect(await store.load("missing")).toBeUndefined();
  });
});
