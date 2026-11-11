import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEntry, type SessionStore, SessionTree, serializeEntry } from "@mu/core";

export interface FileSessionStoreOptions {
  // Root directory for sessions. Default: ~/.mu/sessions
  root?: string;
  // Sub-directory grouping sessions (profiles derive this from their environment).
  scope?: string;
}

const HEADER_CHUNK_BYTES = 64 * 1024;

function lineHash(line: string): string {
  return createHash("sha1").update(line).digest("base64");
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

// The header is line 1; listing sessions must not read every transcript whole.
async function firstLine(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_CHUNK_BYTES);
    const { bytesRead } = await file.read(buffer, 0, HEADER_CHUNK_BYTES, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (end !== -1) return buffer.toString("utf8", 0, end);
    if (bytesRead < HEADER_CHUNK_BYTES) return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
  const text = await readFile(path, "utf8");
  const end = text.indexOf("\n");
  return end === -1 ? text : text.slice(0, end);
}

export class FileSessionStore implements SessionStore {
  private readonly dir: string;
  // What this store last left in each file, to tell an append from a rewrite.
  private readonly written = new Map<string, { hashes: string[]; size: number }>();
  private readonly queue = new Map<string, Promise<void>>();

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
    const path = this.path(sessionId);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    // An append cut short by a crash leaves a last line without its newline;
    // everything before it is intact.
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    const tree = SessionTree.fromJsonl(complete);
    if (complete === text) {
      this.written.set(path, {
        hashes: complete.split("\n").slice(0, -1).map(lineHash),
        size: Buffer.byteLength(complete),
      });
    } else this.written.delete(path);
    return tree;
  }

  // Saves for one session run in order, so an append never interleaves with a rewrite.
  save(sessionId: string, tree: SessionTree): Promise<void> {
    const path = this.path(sessionId);
    const lines = tree.all().map(serializeEntry);
    const next = (this.queue.get(path) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.write(path, lines));
    this.queue.set(path, next);
    void next
      .catch(() => {})
      .finally(() => {
        if (this.queue.get(path) === next) this.queue.delete(path);
      });
    return next;
  }

  // A session only grows at its end, so a save appends the lines the file lacks.
  // Anything else (a first save, an edited header, another branch of history, a
  // file this store did not leave as it is) replaces the file atomically.
  private async write(path: string, lines: string[]): Promise<void> {
    const hashes = lines.map(lineHash);
    const known = this.written.get(path);
    if (
      known &&
      known.hashes.length <= hashes.length &&
      known.hashes.every((hash, index) => hash === hashes[index]) &&
      (await fileSize(path)) === known.size
    ) {
      if (known.hashes.length === hashes.length) return;
      const suffix = `${lines.slice(known.hashes.length).join("\n")}\n`;
      try {
        await appendFile(path, suffix, "utf8");
      } catch (error) {
        this.written.delete(path);
        throw error;
      }
      this.written.set(path, { hashes, size: known.size + Buffer.byteLength(suffix) });
      return;
    }

    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.dir, 0o700);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    try {
      await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, path);
      if (process.platform !== "win32") await chmod(path, 0o600);
    } catch (error) {
      this.written.delete(path);
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    this.written.set(path, { hashes, size: Buffer.byteLength(text) });
  }

  async list(): Promise<string[]> {
    try {
      const names = await readdir(this.dir);
      const ids = await Promise.all(
        names
          .filter((name) => name.endsWith(".jsonl"))
          .map(async (name) => {
            try {
              const header = parseEntry(await firstLine(join(this.dir, name)));
              return header.type === "session" ? header.id : this.fallbackId(name);
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
    this.written.delete(this.path(sessionId));
    try {
      await rm(this.path(sessionId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
