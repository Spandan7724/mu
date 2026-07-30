import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type SessionStore, SessionTree } from "@mu/core";

export interface FileSessionStoreOptions {
  // Root directory for sessions. Default: ~/.mu/sessions
  root?: string;
  // Sub-directory grouping sessions (profiles derive this from their environment).
  scope?: string;
}

export class FileSessionStore implements SessionStore {
  private readonly dir: string;

  constructor(options: FileSessionStoreOptions = {}) {
    const root = options.root ?? join(homedir(), ".mu", "sessions");
    this.dir = options.scope ? join(root, options.scope) : root;
  }

  private path(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.dir, `${safe}.jsonl`);
  }

  async load(sessionId: string): Promise<SessionTree | undefined> {
    try {
      return SessionTree.fromJsonl(await readFile(this.path(sessionId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(sessionId: string, tree: SessionTree): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(sessionId), tree.toJsonl(), "utf8");
  }

  async list(): Promise<string[]> {
    try {
      const names = await readdir(this.dir);
      return names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -".jsonl".length));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
