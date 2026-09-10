import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyTool, MemorySessionStore, SessionTree, userMessage } from "@mu/core";
import { z } from "zod";
import { FileSessionStore } from "./file-store.ts";
import { recallTools } from "./recall.ts";

function session(id: string, directory = "project-a", profile = "coding") {
  return new SessionTree({
    type: "session",
    version: 1,
    createdAt: "2026-09-07T00:00:00Z",
    id,
    profile,
    environment: { directory },
  });
}

async function call(
  tools: AnyTool[],
  name: string,
  args: unknown,
  signal = new AbortController().signal,
) {
  const target = tools.find((tool) => tool.name === name);
  if (!target) throw new Error(`Missing ${name}`);
  const result = await target.execute("test", args, signal);
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const searchPage = z.object({
  matches: z.array(
    z.object({
      sessionId: z.string(),
      entryId: z.string(),
      branch: z.string(),
      snippet: z.string(),
    }),
  ),
  nextOffset: z.number().nullable(),
  unreadable: z.number(),
});

describe("Recall history access", () => {
  test("finds raw compacted evidence, alternate branches, and unsaved current entries without mutation", async () => {
    const current = session("current");
    const root = current.appendMessage(userMessage("Investigate the timeout"));
    const abandoned = current.appendMessage(userMessage("timeout attempt failed assertion E42"));
    current.fork(root.id);
    const active = current.appendMessage(
      userMessage("timeout increase was proposed, not executed"),
    );
    current.append({
      type: "compaction",
      summary: "Continue investigating",
      firstKeptEntryId: null,
    });
    expect(JSON.stringify(current.messagesAt())).not.toContain("E42");
    const before = current.toJsonl();
    const tools = recallTools(current, new MemorySessionStore(), { directory: "project-a" });
    current.appendMessage(userMessage("added after snapshot"));
    const found = searchPage.parse(
      JSON.parse(await call(tools, "history_search", { query: "TIMEOUT", limit: 1 })),
    );
    expect(found.matches.map((match) => match.entryId)).toEqual([root.id]);
    expect(found.nextOffset).toBe(1);
    const rest = searchPage.parse(
      JSON.parse(await call(tools, "history_search", { query: "timeout", offset: 1 })),
    );
    expect(rest.matches).toEqual([
      expect.objectContaining({ entryId: abandoned.id, branch: "alternate" }),
      expect.objectContaining({ entryId: active.id, branch: "active" }),
    ]);
    const alternate = searchPage.parse(
      JSON.parse(await call(tools, "history_search", { query: "timeout", branch: "alternate" })),
    );
    expect(alternate.matches).toEqual([
      expect.objectContaining({ entryId: abandoned.id, branch: "alternate" }),
    ]);
    const read = await call(tools, "history_read", {
      sessionId: "current",
      entryId: abandoned.id,
      includePath: true,
    });
    expect(read).toContain("E42");
    expect(read).toContain(`session:current#${abandoned.id}`);
    expect(read).toContain('"branch":"alternate"');
    expect(JSON.parse(read).path).toEqual([
      expect.objectContaining({ entryId: root.id, branch: "active" }),
      expect.objectContaining({ entryId: abandoned.id, branch: "alternate" }),
    ]);
    expect(JSON.parse(read).nextPathOffset).toBeNull();
    expect(await call(tools, "history_read", { sessionId: "current", entryId: root.id })).toContain(
      `"reference":"session:current#${abandoned.id}","type":"message","branch":"alternate"`,
    );
    const listing = await call(tools, "history_sessions", {});
    expect(listing).toContain('"alternateEntryCount":1');
    expect(listing).toContain('"alternateHeadCount":1');
    expect(listing).toContain(`"alternateHeads":[{"entryId":"${abandoned.id}"`);
    expect(listing).toContain('"alternateHeadsOmitted":0');
    expect(await call(tools, "history_search", { query: "added after snapshot" })).toContain(
      '"matches":[]',
    );
    expect(current.toJsonl()).toStartWith(before.trimEnd());
  });

  test("preserves an unsaved fork cursor and rejects unbounded read requests", async () => {
    const current = session("current");
    const root = current.appendMessage(userMessage("root"));
    const undone = current.appendMessage(userMessage("undone attempt"));
    current.fork(root.id);
    const before = current.toJsonl();
    const tools = recallTools(current, new MemorySessionStore());
    expect(
      await call(tools, "history_read", { sessionId: "current", entryId: undone.id }),
    ).toContain('"branch":"alternate"');
    expect(await call(tools, "history_sessions", {})).toContain(`"head":"${root.id}"`);
    await expect(
      call(tools, "history_read", { sessionId: "current", entryId: root.id, limit: 16001 }),
    ).rejects.toThrow("Invalid arguments");
    await expect(call(tools, "history_search", { query: "root", offset: -1 })).rejects.toThrow(
      "Invalid arguments",
    );
    expect(current.toJsonl()).toBe(before);
    expect(current.head).toBe(root.id);
  });

  test("searches saved project sessions but rejects other projects, profiles and arbitrary IDs", async () => {
    const store = new MemorySessionStore();
    const current = session("current");
    const older = session("older");
    const old = older.appendMessage(userMessage("SQLite rejected due to lock contention"));
    const foreign = session("foreign", "project-b");
    const secret = foreign.appendMessage(userMessage("SQLite secret from another project"));
    const otherProfile = session("browser", "project-a", "browser");
    otherProfile.appendMessage(userMessage("SQLite other profile"));
    for (const tree of [older, foreign, otherProfile])
      await store.save(tree.header?.id ?? "", tree);
    const tools = recallTools(current, store, { directory: "project-a" });
    const listing = await call(tools, "history_sessions", {});
    expect(listing).toContain("older");
    expect(listing).toContain("current");
    expect(listing).not.toContain("foreign");
    expect(listing).not.toContain("browser");
    const result = searchPage.parse(
      JSON.parse(await call(tools, "history_search", { query: "SQLite" })),
    );
    expect(result.matches.map((match) => match.entryId)).toEqual([old.id]);
    for (const sessionId of ["foreign", "browser", "../../outside"]) {
      await expect(call(tools, "history_read", { sessionId, entryId: secret.id })).rejects.toThrow(
        "unavailable",
      );
      expect(await call(tools, "history_search", { query: "SQLite", sessionId })).toContain(
        '"matches":[]',
      );
    }
    const page = z.object({
      sessions: z.array(z.object({ sessionId: z.string() })),
      nextOffset: z.number().nullable(),
    });
    const first = page.parse(JSON.parse(await call(tools, "history_sessions", { limit: 1 })));
    expect(first.sessions.map((item) => item.sessionId)).toEqual(["current"]);
    const second = page.parse(
      JSON.parse(await call(tools, "history_sessions", { offset: first.nextOffset })),
    );
    expect(second.sessions.map((item) => item.sessionId)).toEqual(["older"]);
  });

  test("diversifies ranked search pages across sessions and reports complete match coverage", async () => {
    const store = new MemorySessionStore();
    const current = session("current");
    const repeated = session("a-repeated");
    for (let index = 0; index < 35; index++)
      repeated.appendMessage(userMessage(`compaction duplicate ${index}`));
    const decisive = session("b-decisive");
    const decision = decisive.appendMessage(userMessage("compaction decision D58 was implemented"));
    await store.save("a-repeated", repeated);
    await store.save("b-decisive", decisive);
    const tools = recallTools(current, store, { directory: "project-a" });
    const first = z
      .object({
        matches: z.array(z.object({ sessionId: z.string(), entryId: z.string() })),
        totalMatches: z.number(),
        activeMatches: z.number(),
        alternateMatches: z.number(),
        nextOffset: z.number().nullable(),
        coverage: z.string(),
      })
      .parse(JSON.parse(await call(tools, "history_search", { query: "compaction", limit: 2 })));
    expect(first.matches).toEqual([
      expect.objectContaining({ sessionId: "a-repeated" }),
      expect.objectContaining({ sessionId: "b-decisive", entryId: decision.id }),
    ]);
    expect(first.totalMatches).toBe(36);
    expect(first.activeMatches).toBe(36);
    expect(first.alternateMatches).toBe(0);
    expect(first.nextOffset).toBe(2);
    expect(first.coverage).toContain("partial");
  });

  test("deduplicates repeated evidence, reports scan coverage, and keeps pagination stable", async () => {
    const store = new MemorySessionStore();
    const current = session("current");
    const firstSession = session("first");
    const firstEntry = firstSession.appendMessage(userMessage("same retained finding"));
    const secondSession = session("second");
    const secondEntry = secondSession.appendMessage(userMessage("same retained finding"));
    secondSession.appendMessage(userMessage("another retained finding"));
    await store.save("first", firstSession);
    await store.save("second", secondSession);
    const tools = recallTools(current, store, { directory: "project-a" });
    const resultSchema = z.object({
      matches: z.array(
        z.object({
          entryId: z.string(),
          occurrenceCount: z.number(),
          duplicateReferences: z.array(z.object({ reference: z.string() })),
        }),
      ),
      cursor: z.string(),
      totalMatches: z.number(),
      uniqueMatches: z.number(),
      duplicateMatches: z.number(),
      candidateSessions: z.number(),
      scannedSessions: z.number(),
      excludedSessions: z.number(),
      scannedEntries: z.number(),
      activeEntriesScanned: z.number(),
      alternateEntriesScanned: z.number(),
      excludedPriorRecall: z.number(),
      nextOffset: z.number().nullable(),
    });
    const first = resultSchema.parse(
      JSON.parse(await call(tools, "history_search", { query: "retained finding", limit: 1 })),
    );
    expect(first).toEqual(
      expect.objectContaining({
        totalMatches: 3,
        uniqueMatches: 2,
        duplicateMatches: 1,
        candidateSessions: 3,
        scannedSessions: 3,
        excludedSessions: 0,
        scannedEntries: 3,
        activeEntriesScanned: 3,
        alternateEntriesScanned: 0,
        excludedPriorRecall: 0,
        nextOffset: 1,
      }),
    );
    expect(first.matches[0]).toEqual(
      expect.objectContaining({
        entryId: firstEntry.id,
        occurrenceCount: 2,
        duplicateReferences: [
          expect.objectContaining({ reference: `session:second#${secondEntry.id}` }),
        ],
      }),
    );

    secondSession.appendMessage({
      role: "toolResult",
      toolName: "read",
      toolCallId: "new",
      timestamp: Date.now(),
      isError: false,
      content: [{ type: "text", text: "new higher-ranked retained finding" }],
    });
    await store.save("second", secondSession);
    const stable = resultSchema.parse(
      JSON.parse(
        await call(tools, "history_search", {
          query: "retained finding",
          cursor: first.cursor,
          offset: 1,
          limit: 1,
        }),
      ),
    );
    expect(stable.cursor).toBe(first.cursor);
    expect(stable.totalMatches).toBe(3);
    expect(stable.matches[0]?.occurrenceCount).toBe(1);
    expect(stable.nextOffset).toBeNull();
    await expect(
      call(tools, "history_search", {
        query: "different search",
        cursor: first.cursor,
      }),
    ).rejects.toThrow("different search options");
  });

  test("matches grammatical phrase variants and omits derivative Recall results by default", async () => {
    const current = session("current");
    const evidence = current.appendMessage({
      role: "toolResult",
      toolName: "read",
      toolCallId: "read-decision",
      timestamp: 1,
      isError: false,
      content: [
        {
          type: "text",
          text: "D58: Working context is backed by retrievable branch evidence",
        },
      ],
    });
    const derivative = current.appendMessage({
      role: "toolResult",
      toolName: "recall",
      toolCallId: "prior-recall",
      timestamp: 2,
      isError: false,
      content: [
        {
          type: "text",
          text: "working context backed by retrievable branch evidence was D59",
        },
      ],
    });
    const tools = recallTools(current, new MemorySessionStore());
    const related = searchPage.parse(
      JSON.parse(
        await call(tools, "history_search", {
          query: "working context backed by retrievable branch evidence",
          mode: "all_terms",
        }),
      ),
    );
    expect(related.matches).toEqual([
      expect.objectContaining({ entryId: evidence.id, snippet: expect.stringContaining("D58") }),
    ]);
    expect(await call(tools, "history_search", { query: "was D59" })).not.toContain(derivative.id);
    expect(
      await call(tools, "history_search", {
        query: "was D59",
        includePriorRecall: true,
      }),
    ).toContain(derivative.id);
  });

  test("does not enumerate a shared store without a configured scope", async () => {
    class UnavailableStore extends MemorySessionStore {
      override async list(): Promise<string[]> {
        throw new Error("must not enumerate");
      }
    }
    const tools = recallTools(session("current"), new UnavailableStore());
    expect(await call(tools, "history_sessions", {})).toContain("current");
  });

  test("reads original nested child evidence and paginates long entries without exposing image or reasoning payloads", async () => {
    const current = session("current");
    const child = current.appendMessage({
      role: "toolResult",
      toolName: "search",
      toolCallId: "child",
      timestamp: 1,
      isError: false,
      content: [{ type: "text", text: "Short conclusion" }],
      details: {
        type: "subagent",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private-thought", signature: "opaque-signature" },
              {
                type: "toolCall",
                id: "inspect",
                name: "inspect",
                signature: "opaque-signature",
                arguments: { signature: "recorded API signature" },
              },
            ],
          },
          {
            role: "toolResult",
            content: [
              { type: "text", text: `${"x".repeat(19000)}Decisive child assertion E99` },
              { type: "image", mimeType: "image/png", data: "private-image-payload" },
            ],
          },
        ],
      },
    });
    const tools = recallTools(current, new MemorySessionStore());
    const result = await call(tools, "history_search", { query: "Decisive child" });
    expect(result).toContain(child.id);
    const readPage = z.object({
      text: z.string(),
      nextOffset: z.number().nullable(),
      totalCharacters: z.number(),
    });
    let offset: number | null = 0;
    let text = "";
    while (offset !== null) {
      const read = readPage.parse(
        JSON.parse(
          await call(tools, "history_read", { sessionId: "current", entryId: child.id, offset }),
        ),
      );
      expect(read.text.length).toBeLessThanOrEqual(8000);
      text += read.text;
      offset = read.nextOffset;
      if (offset === null) expect(text.length).toBe(read.totalCharacters);
    }
    expect(text).toContain("Decisive child assertion E99");
    expect(text).toContain("recorded API signature");
    for (const secret of ["private-thought", "opaque-signature", "private-image-payload"]) {
      expect(text).not.toContain(secret);
      expect(await call(tools, "history_search", { query: secret })).toContain('"matches":[]');
    }
    expect(JSON.parse(text).id).toBe(child.id);
  });

  test("survives corrupt saved sessions and honors cancellation", async () => {
    class CorruptStore extends MemorySessionStore {
      override async list() {
        return ["broken", ...(await super.list())];
      }
      override async load(id: string) {
        if (id === "broken") throw new Error("invalid JSONL");
        return super.load(id);
      }
    }
    const tools = recallTools(session("current"), new CorruptStore(), { directory: "project-a" });
    expect(await call(tools, "history_sessions", {})).toContain('"unreadable":1');
    expect(await call(tools, "history_search", { query: "missing" })).toContain('"unreadable":1');
    for (const [name, args] of [
      ["history_sessions", {}],
      ["history_search", { query: "anything" }],
      ["history_read", { sessionId: "current", entryId: "missing" }],
    ] as const) {
      await expect(call(tools, name, args, AbortSignal.abort())).rejects.toThrow();
    }
  });

  test("loads persisted originals after file-store resume and avoids normalized-scope collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-recall-"));
    const store = new FileSessionStore({ root, scope: "same-normalized-scope" });
    const prior = session("prior", "/project/a-b");
    const evidence = prior.appendMessage(userMessage("Rejected pooling: assertion E77"));
    prior.append({
      type: "microcompaction",
      replacements: [{ entryId: evidence.id, message: userMessage("condensed") }],
    });
    prior.append({ type: "compaction", summary: "Continue", firstKeptEntryId: null });
    await store.save("prior", prior);
    const collision = session("collision", "/project/a/b");
    collision.appendMessage(userMessage("Rejected secret"));
    await store.save("collision", collision);
    const reopened = new FileSessionStore({ root, scope: "same-normalized-scope" });
    const tools = recallTools(session("current", "/project/a-b"), reopened, {
      directory: "/project/a-b",
    });
    const result = await call(tools, "history_search", { query: "Rejected" });
    expect(result).toContain("E77");
    expect(result).not.toContain("secret");
    expect(
      await call(tools, "history_read", { sessionId: "prior", entryId: evidence.id }),
    ).toContain("E77");
  });
});
