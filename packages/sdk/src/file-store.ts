import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
    const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
    return join(this.dir, `${encoded}.jsonl`);
  }

  private fallbackId(name: string): string {
    const stem = name.slice(0, -".jsonl".length);
    try {
      const decoded = Buffer.from(stem, "base64url").toString("utf8");
      return this.path(decoded).endsWith(name) ? decoded : stem;
    } catch {
      return stem;
    }
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
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.dir, 0o700);
    const destination = this.path(sessionId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, tree.toJsonl(), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
      if (process.platform !== "win32") await chmod(destination, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async list(): Promise<string[]> {
    try {
      const names = await readdir(this.dir);
      const ids = await Promise.all(
        names
          .filter((name) => name.endsWith(".jsonl"))
          .map(async (name) => {
            try {
              const tree = SessionTree.fromJsonl(await readFile(join(this.dir, name), "utf8"));
              return tree.header?.id ?? this.fallbackId(name);
            } catch {
              return this.fallbackId(name);
            }
          }),
      );
      return [...new Set(ids)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async delete(sessionId: string): Promise<boolean> {
    try {
      await rm(this.path(sessionId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
