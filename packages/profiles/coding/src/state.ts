import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

interface FileSnapshot {
  exists: boolean;
  device?: number;
  inode?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  digest?: string;
}

function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function snapshot(path: string, content?: string): FileSnapshot {
  try {
    const info = statSync(path);
    return {
      exists: true,
      device: info.dev,
      inode: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      digest: digest(content ?? readFileSync(path)),
    };
  } catch {
    return { exists: false };
  }
}

// Tracks which files the agent has read, so writes/edits can require a prior
// read (the read-before-write guard) and detect changes made behind its back.
export class FileState {
  private reads = new Map<string, FileSnapshot>();
  private modified = new Set<string>();

  markRead(path: string, content?: string): void {
    const absolute = resolve(path);
    this.reads.set(absolute, snapshot(absolute, content));
  }

  markWritten(path: string): void {
    const absolute = resolve(path);
    this.modified.add(absolute);
    this.markRead(absolute);
  }

  hasRead(path: string): boolean {
    return this.reads.has(resolve(path));
  }

  // Returns true when the file changed on disk since the agent last read it.
  isStale(path: string, currentContent?: string): boolean {
    const absolute = resolve(path);
    const seen = this.reads.get(absolute);
    if (seen === undefined) return false;
    const current = snapshot(absolute, currentContent);
    return (
      current.exists !== seen.exists ||
      current.device !== seen.device ||
      current.inode !== seen.inode ||
      current.size !== seen.size ||
      current.mtimeMs !== seen.mtimeMs ||
      current.ctimeMs !== seen.ctimeMs ||
      current.digest !== seen.digest
    );
  }

  readFiles(): string[] {
    return [...this.reads.keys()];
  }

  modifiedFiles(): string[] {
    return [...this.modified];
  }
}
