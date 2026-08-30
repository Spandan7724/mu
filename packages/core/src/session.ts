import { compactionSummaryMessage } from "./compaction.ts";
import type { AgentMessage, Usage } from "./messages.ts";

export const SESSION_VERSION = 1;

export type SessionEntry =
  | {
      type: "session";
      version: number;
      id: string;
      createdAt: string;
      profile: string;
      environment: Record<string, string>;
    }
  | {
      type: "message";
      id: string;
      parentId: string | null;
      message: AgentMessage;
      checkpointRef?: string;
    }
  | {
      type: "compaction";
      id: string;
      parentId: string | null;
      summary: string;
      carryover?: unknown;
      firstKeptEntryId: string | null;
      timestamp?: number;
      trigger?: "manual" | "threshold" | "overflow" | "model-change";
      contextTokensBefore?: number;
      contextTokensAfter?: number;
      model?: string;
      compactorModel?: string;
      windowNumber?: number;
      strategy?: "summary-tail";
      keptTokens?: number;
      toolResultsCleared?: number;
      // The compactor's own LLM call cost — distinct from contextTokensBefore/
      // After, which describe the conversation it summarized. Absent on
      // sessions written before this field existed.
      usage?: Usage;
    }
  | {
      type: "microcompaction";
      id: string;
      parentId: string | null;
      replacements: { entryId: string; message: AgentMessage }[];
    }
  | {
      type: "compaction-attempt";
      id: string;
      parentId: string | null;
      status: "failed" | "cancelled";
      trigger: "manual" | "threshold" | "overflow" | "model-change";
      model: string;
      compactorModel: string;
      timestamp: number;
      usage: Usage;
    }
  | {
      type: "checkpoint";
      id: string;
      parentId: string | null;
      beforeEntryId: string | null;
      checkpointRef: string;
      checkpointAfterRef: string;
      label?: string;
    }
  | {
      type: "settings-change";
      id: string;
      parentId: string | null;
      model?: string;
      thinkingLevel?: string;
    }
  | {
      type: "custom";
      id: string;
      parentId: string | null;
      customType: string;
      data: unknown;
    };

export type TreeEntry = Exclude<SessionEntry, { type: "session" }>;

// Omit must distribute over the union or the discriminated variants collapse
// into their common keys.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type NewTreeEntry = DistributiveOmit<TreeEntry, "id" | "parentId"> & {
  id?: string;
  parentId?: string | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optional(value: unknown, predicate: (candidate: unknown) => boolean): boolean {
  return value === undefined || predicate(value);
}

function validUsage(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    finite(value.inputTokens) &&
    value.inputTokens >= 0 &&
    finite(value.outputTokens) &&
    value.outputTokens >= 0 &&
    finite(value.cacheReadTokens) &&
    value.cacheReadTokens >= 0 &&
    finite(value.cacheWriteTokens) &&
    value.cacheWriteTokens >= 0 &&
    optional(value.costUsd, (candidate) => finite(candidate) && candidate >= 0)
  );
}

function validContent(value: unknown, roles: readonly string[]): boolean {
  if (!record(value) || !string(value.type) || !roles.includes(value.type)) return false;
  if (value.type === "text") return string(value.text);
  if (value.type === "image") {
    return (
      string(value.mimeType) &&
      string(value.data) &&
      optional(value.evictable, (candidate) => typeof candidate === "boolean")
    );
  }
  if (value.type === "thinking") {
    return (
      string(value.thinking) &&
      optional(value.signature, string) &&
      optional(value.redacted, (candidate) => typeof candidate === "boolean")
    );
  }
  return (
    string(value.id) &&
    string(value.name) &&
    record(value.arguments) &&
    optional(value.signature, string)
  );
}

function validMessage(value: unknown): boolean {
  if (!record(value) || !string(value.role) || !Array.isArray(value.content)) return false;
  if (!finite(value.timestamp)) return false;
  if (value.role === "user")
    return value.content.every((block) => validContent(block, ["text", "image"]));
  if (value.role === "custom") {
    return (
      string(value.customType) &&
      optional(value.display, (candidate) => typeof candidate === "boolean") &&
      value.content.every((block) => validContent(block, ["text", "image"]))
    );
  }
  if (value.role === "toolResult") {
    return (
      string(value.toolCallId) &&
      string(value.toolName) &&
      typeof value.isError === "boolean" &&
      optional(value.usage, validUsage) &&
      optional(value.evicted, (candidate) => typeof candidate === "boolean") &&
      value.content.every((block) => validContent(block, ["text", "image"]))
    );
  }
  if (value.role === "assistant") {
    return (
      string(value.model) &&
      validUsage(value.usage) &&
      ["end", "toolUse", "length", "aborted", "error"].includes(String(value.stopReason)) &&
      optional(value.errorMessage, string) &&
      value.content.every((block) => validContent(block, ["text", "thinking", "toolCall"]))
    );
  }
  return false;
}

function assertSessionEntry(value: unknown): asserts value is SessionEntry {
  if (!record(value) || !string(value.type))
    throw new Error("Invalid session entry: expected an object with a type");
  if (value.type === "session") {
    if (
      !finite(value.version) ||
      !nonEmptyString(value.id) ||
      !string(value.createdAt) ||
      !string(value.profile) ||
      !record(value.environment) ||
      !Object.values(value.environment).every(string)
    ) {
      throw new Error("Invalid session header");
    }
    return;
  }
  if (!nonEmptyString(value.id) || !(value.parentId === null || nonEmptyString(value.parentId))) {
    throw new Error(`Invalid ${value.type} session entry identity`);
  }
  switch (value.type) {
    case "message":
      if (!validMessage(value.message) || !optional(value.checkpointRef, string)) {
        throw new Error("Invalid message session entry");
      }
      return;
    case "compaction":
      if (
        !string(value.summary) ||
        !(value.firstKeptEntryId === null || string(value.firstKeptEntryId)) ||
        !optional(value.timestamp, finite) ||
        !optional(value.contextTokensBefore, finite) ||
        !optional(value.contextTokensAfter, finite) ||
        !optional(value.model, string) ||
        !optional(value.compactorModel, string) ||
        !optional(value.windowNumber, finite) ||
        !optional(value.keptTokens, finite) ||
        !optional(value.toolResultsCleared, finite) ||
        !optional(value.usage, validUsage)
      ) {
        throw new Error("Invalid compaction session entry");
      }
      return;
    case "microcompaction":
      if (
        !Array.isArray(value.replacements) ||
        !value.replacements.every(
          (item) => record(item) && string(item.entryId) && validMessage(item.message),
        )
      ) {
        throw new Error("Invalid microcompaction session entry");
      }
      return;
    case "compaction-attempt":
      if (
        !["failed", "cancelled"].includes(String(value.status)) ||
        !["manual", "threshold", "overflow", "model-change"].includes(String(value.trigger)) ||
        !string(value.model) ||
        !string(value.compactorModel) ||
        !finite(value.timestamp) ||
        !validUsage(value.usage)
      ) {
        throw new Error("Invalid compaction-attempt session entry");
      }
      return;
    case "checkpoint":
      if (
        !(value.beforeEntryId === null || string(value.beforeEntryId)) ||
        !string(value.checkpointRef) ||
        !string(value.checkpointAfterRef) ||
        !optional(value.label, string)
      ) {
        throw new Error("Invalid checkpoint session entry");
      }
      return;
    case "settings-change":
      if (!optional(value.model, string) || !optional(value.thinkingLevel, string)) {
        throw new Error("Invalid settings-change session entry");
      }
      return;
    case "custom":
      if (!nonEmptyString(value.customType) || !Object.hasOwn(value, "data")) {
        throw new Error("Invalid custom session entry");
      }
      return;
    default:
      throw new Error(`Unknown session entry type: ${value.type}`);
  }
}

export function isTreeEntry(entry: SessionEntry): entry is TreeEntry {
  return entry.type !== "session";
}

export function serializeEntry(entry: SessionEntry): string {
  return JSON.stringify(entry);
}

export function parseEntry(line: string): SessionEntry {
  const entry: unknown = JSON.parse(line);
  assertSessionEntry(entry);
  return entry;
}

export function serializeSession(entries: SessionEntry[]): string {
  return entries.map(serializeEntry).join("\n") + (entries.length > 0 ? "\n" : "");
}

export function parseSession(jsonl: string): SessionEntry[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseEntry);
}

let counter = 0;
export function newEntryId(): string {
  counter += 1;
  return `e${Date.now().toString(36)}${counter.toString(36)}`;
}

// Append-only tree of entries. Branching = a new entry pointing at an earlier
// parent, which makes fork and rewind free.
export class SessionTree {
  private entries: SessionEntry[] = [];
  private byId = new Map<string, TreeEntry>();
  private headId: string | null = null;

  constructor(header?: SessionEntry & { type: "session" }) {
    if (header) {
      assertSessionEntry(header);
      this.entries.push(header);
    }
  }

  static fromJsonl(jsonl: string): SessionTree {
    const tree = new SessionTree();
    const entries = parseSession(jsonl);
    if (entries.length === 0 || entries[0]?.type !== "session") {
      throw new Error("Invalid session: line 1 must be the session header");
    }
    for (const entry of entries) tree.push(entry);
    return tree;
  }

  toJsonl(): string {
    return serializeSession(this.entries);
  }

  get header(): (SessionEntry & { type: "session" }) | undefined {
    const first = this.entries[0];
    return first?.type === "session" ? first : undefined;
  }

  get head(): string | null {
    return this.headId;
  }

  all(): SessionEntry[] {
    return [...this.entries];
  }

  get(id: string): TreeEntry | undefined {
    return this.byId.get(id);
  }

  has(id: string | null): boolean {
    return id === null || this.byId.has(id);
  }

  // Replays an existing entry (used when loading). Advances head to it.
  push(entry: SessionEntry): void {
    assertSessionEntry(entry);
    if (entry.type === "session") {
      if (this.entries.length !== 0)
        throw new Error("Invalid session: header must appear only on line 1");
    } else {
      if (this.entries.length === 0 || this.entries[0]?.type !== "session") {
        throw new Error("Invalid session: missing header");
      }
      if (this.byId.has(entry.id))
        throw new Error(`Invalid session: duplicate entry id ${entry.id}`);
      if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
        throw new Error(`Invalid session: unknown parent ${entry.parentId}`);
      }
    }
    this.entries.push(entry);
    if (isTreeEntry(entry)) {
      this.byId.set(entry.id, entry);
      this.headId = entry.id;
    }
  }

  // Appends a new entry as a child of the current head.
  append(entry: NewTreeEntry): TreeEntry {
    const full = {
      ...entry,
      id: entry.id ?? newEntryId(),
      parentId: entry.parentId !== undefined ? entry.parentId : this.headId,
    } as TreeEntry;
    this.push(full);
    return full;
  }

  appendMessage(message: AgentMessage, checkpointRef?: string): TreeEntry {
    return this.append({
      type: "message",
      message,
      ...(checkpointRef ? { checkpointRef } : {}),
    });
  }

  // Walks parentId links from `id` back to the root, root-first.
  pathTo(id: string): TreeEntry[] {
    const path: TreeEntry[] = [];
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor) {
      if (seen.has(cursor)) break; // defensive: never loop on a corrupt file
      seen.add(cursor);
      const entry: TreeEntry | undefined = this.byId.get(cursor);
      if (!entry) break;
      path.push(entry);
      cursor = entry.parentId;
    }
    return path.reverse();
  }

  // The active branch: root → head.
  activePath(): TreeEntry[] {
    return this.headId ? this.pathTo(this.headId) : [];
  }

  entryIdForMessage(message: AgentMessage): string | undefined {
    const path = this.activePath();
    for (let i = path.length - 1; i >= 0; i--) {
      const entry = path[i];
      if (entry?.type === "message" && entry.message === message) return entry.id;
      if (entry?.type === "microcompaction") {
        const replacement = entry.replacements.find((item) => item.message === message);
        if (replacement) return replacement.entryId;
      }
    }
    return undefined;
  }

  // Rebuilds the model-visible transcript for a branch. A compaction entry
  // replaces everything before it with its summary (context = summary + tail).
  messagesAt(id: string | null = this.headId): AgentMessage[] {
    if (!id) return [];
    const path = this.pathTo(id);
    let visible: { message: AgentMessage; entryId?: string }[] = [];
    for (const entry of path) {
      if (entry.type === "message") {
        visible.push({ message: entry.message, entryId: entry.id });
        continue;
      }
      if (entry.type === "microcompaction") {
        for (const replacement of entry.replacements) {
          const index = visible.findIndex((item) => item.entryId === replacement.entryId);
          if (index !== -1) {
            visible[index] = {
              message: replacement.message,
              entryId: replacement.entryId,
            };
          }
        }
        continue;
      }
      if (entry.type === "compaction") {
        if (entry.firstKeptEntryId === null) {
          visible = [
            {
              message: compactionSummaryMessage(entry.summary, entry.carryover, entry.timestamp),
            },
          ];
          continue;
        }
        const keptIndex = visible.findIndex((item) => item.entryId === entry.firstKeptEntryId);
        // A corrupt boundary must never discard history. Only apply it when
        // its kept-tail anchor is a real ancestor message.
        if (keptIndex === -1) continue;
        visible = [
          {
            message: compactionSummaryMessage(entry.summary, entry.carryover, entry.timestamp),
          },
          ...visible.slice(keptIndex),
        ];
      }
    }
    return visible.map((item) => item.message);
  }

  // Branches from an arbitrary entry: subsequent appends descend from it.
  fork(entryId: string | null): void {
    if (entryId !== null && !this.byId.has(entryId)) {
      throw new Error(`Cannot fork from unknown entry: ${entryId}`);
    }
    this.headId = entryId;
  }
}

export interface SessionStore {
  load(sessionId: string): Promise<SessionTree | undefined>;
  save(sessionId: string, tree: SessionTree): Promise<void>;
  list(): Promise<string[]>;
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, string>();

  async load(sessionId: string): Promise<SessionTree | undefined> {
    const jsonl = this.sessions.get(sessionId);
    return jsonl === undefined ? undefined : SessionTree.fromJsonl(jsonl);
  }

  async save(sessionId: string, tree: SessionTree): Promise<void> {
    this.sessions.set(sessionId, tree.toJsonl());
  }

  async list(): Promise<string[]> {
    return [...this.sessions.keys()];
  }
}
