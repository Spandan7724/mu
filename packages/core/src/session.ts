import { compactionSummaryMessage } from "./compaction.ts";
import type { AgentMessage } from "./messages.ts";

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
    }
  | {
      type: "microcompaction";
      id: string;
      parentId: string | null;
      replacements: { entryId: string; message: AgentMessage }[];
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

export function isTreeEntry(entry: SessionEntry): entry is TreeEntry {
  return entry.type !== "session";
}

export function serializeEntry(entry: SessionEntry): string {
  return JSON.stringify(entry);
}

export function parseEntry(line: string): SessionEntry {
  return JSON.parse(line) as SessionEntry;
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
    if (header) this.entries.push(header);
  }

  static fromJsonl(jsonl: string): SessionTree {
    const tree = new SessionTree();
    for (const entry of parseSession(jsonl)) tree.push(entry);
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
