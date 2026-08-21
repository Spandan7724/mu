import { describe, expect, test } from "bun:test";
import { customMessage, userMessage } from "./messages.ts";
import {
  MemorySessionStore,
  NO_SESSION_PROFILE,
  normalizeSessionEnvironment,
  normalizeSessionProfile,
  parseEntry,
  parseSession,
  SESSION_ENVIRONMENT_LIMITS,
  SESSION_VERSION,
  SessionTree,
  serializeSession,
  sessionEnvironmentIssues,
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

  test("rejects malformed entries and invalid tree topology", () => {
    const header = JSON.stringify(newTree().header);
    const validMessage = JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      message: userMessage("hello"),
    });
    const cases = [
      validMessage,
      `${header}\n${JSON.stringify({ type: "message", id: "e1", parentId: null })}`,
      `${header}\n${validMessage}\n${validMessage}`,
      `${header}\n${JSON.stringify({
        type: "message",
        id: "e2",
        parentId: "missing",
        message: userMessage("orphan"),
      })}`,
      `${header}\n${header}`,
      `${header}\n${JSON.stringify({
        type: "message",
        id: "",
        parentId: null,
        message: userMessage("empty id"),
      })}`,
      `${header}\n${JSON.stringify({ type: "custom", id: "e1", parentId: null, customType: "x" })}`,
    ];

    for (const jsonl of cases) expect(() => SessionTree.fromJsonl(jsonl)).toThrow();
  });

  test("failed compaction usage round-trips without changing model context", () => {
    const tree = newTree();
    tree.appendMessage(userMessage("hello"));
    tree.append({
      type: "compaction-attempt",
      status: "failed",
      trigger: "manual",
      model: "fake/fake-1",
      compactorModel: "fake/fake-1",
      timestamp: 2,
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });

    const loaded = SessionTree.fromJsonl(tree.toJsonl());
    expect(loaded.activePath().at(-1)?.type).toBe("compaction-attempt");
    expect(loaded.messagesAt()).toEqual(tree.messagesAt());
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

describe("session environment contract", () => {
  test("a bounded environment survives serialization untouched", () => {
    const environment = normalizeSessionEnvironment({
      surface: "remote",
      connection: "socket",
      "host.family": "linux",
      tab_count: "3",
    });
    const header = {
      type: "session" as const,
      version: SESSION_VERSION,
      id: "s1",
      createdAt: new Date(0).toISOString(),
      profile: "example",
      environment,
    };

    expect(parseSession(serializeSession([header]))[0]).toEqual(header);
    expect(new SessionTree(header).header?.environment).toEqual(environment);
  });

  test("an oversized value is clamped instead of rejected", () => {
    const clamped = normalizeSessionEnvironment({ note: "x".repeat(9_000) });
    expect(clamped.note?.length).toBe(SESSION_ENVIRONMENT_LIMITS.maxValueLength);
    expect(clamped.note?.endsWith("\u2026")).toBe(true);
    expect(sessionEnvironmentIssues(clamped)).toEqual([]);
  });

  test("a malformed environment is a loud error, not a silent header", () => {
    expect(() => normalizeSessionEnvironment({ ok: 42 })).toThrow("expected a string");
    expect(() => normalizeSessionEnvironment({ "not a key": "v" })).toThrow(
      "Invalid session environment key",
    );
    expect(() => normalizeSessionEnvironment("nope")).toThrow("expected an object");
    expect(() =>
      normalizeSessionEnvironment(
        Object.fromEntries(
          Array.from({ length: SESSION_ENVIRONMENT_LIMITS.maxEntries + 1 }, (_, i) => [
            `k${i}`,
            "v",
          ]),
        ),
      ),
    ).toThrow("more than");
  });

  test("a header carrying an out-of-contract environment does not load", () => {
    const header = {
      type: "session",
      version: SESSION_VERSION,
      id: "s1",
      createdAt: new Date(0).toISOString(),
      profile: "coding",
      environment: { "bad key": "v" },
    };
    expect(() => parseEntry(JSON.stringify(header))).toThrow("Invalid session header");
    expect(() => parseEntry(JSON.stringify({ ...header, environment: { ok: 1 } }))).toThrow(
      "Invalid session header",
    );
    expect(() => parseEntry(JSON.stringify({ ...header, profile: "" }))).toThrow(
      "Invalid session header",
    );
  });

  test("a profile identity has to be a real name", () => {
    expect(normalizeSessionProfile(undefined)).toBe(NO_SESSION_PROFILE);
    expect(normalizeSessionProfile("browser")).toBe("browser");
    expect(() => normalizeSessionProfile("")).toThrow("non-empty string");
    expect(() => normalizeSessionProfile("   ")).toThrow("non-empty string");
    expect(() => normalizeSessionProfile("p".repeat(200))).toThrow("too long");
  });
});

describe("pre-v2 session environments migrate rather than fail", () => {
  const v1 = (environment: unknown) =>
    JSON.stringify({
      type: "session",
      version: 1,
      id: "s1",
      createdAt: new Date(0).toISOString(),
      profile: "coding",
      environment,
    });

  test("an over-limit entry count is trimmed, not rejected", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 40; i++) wide[`key${i}`] = "v";
    const entry = parseEntry(v1(wide));
    if (entry.type !== "session") throw new Error("expected a header");
    expect(Object.keys(entry.environment).length).toBe(SESSION_ENVIRONMENT_LIMITS.maxEntries);
    expect(entry.environmentMigration?.length).toBeGreaterThan(0);
  });

  test("an invalid key is dropped and an oversized value truncated", () => {
    const entry = parseEntry(
      v1({
        "bad key!": "x",
        good: "y",
        big: "z".repeat(SESSION_ENVIRONMENT_LIMITS.maxValueLength + 10),
      }),
    );
    if (entry.type !== "session") throw new Error("expected a header");
    expect(entry.environment["bad key!"]).toBeUndefined();
    expect(entry.environment.good).toBe("y");
    expect(entry.environment.big?.length).toBe(SESSION_ENVIRONMENT_LIMITS.maxValueLength);
    expect(entry.environmentMigration?.length).toBe(2);
  });

  test("a non-string value is dropped rather than failing the load", () => {
    const entry = parseEntry(v1({ ok: "1", nope: 2 }));
    if (entry.type !== "session") throw new Error("expected a header");
    expect(entry.environment).toEqual({ ok: "1" });
  });

  test("a clean v1 header migrates silently", () => {
    const entry = parseEntry(v1({ directory: "/tmp", platform: "linux" }));
    if (entry.type !== "session") throw new Error("expected a header");
    expect(entry.environmentMigration).toBeUndefined();
  });

  // v2 is the current contract, so a malformed v2 header is a bug, not history.
  test("a v2 header is still validated strictly", () => {
    expect(() =>
      parseEntry(
        JSON.stringify({
          type: "session",
          version: SESSION_VERSION,
          id: "s1",
          createdAt: new Date(0).toISOString(),
          profile: "coding",
          environment: { "bad key!": "x" },
        }),
      ),
    ).toThrow();
  });
});
