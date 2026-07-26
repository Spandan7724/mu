import { statSync } from "node:fs";
import { resolve } from "node:path";

// Tracks which files the agent has read, so writes/edits can require a prior
// read (the read-before-write guard) and detect changes made behind its back.
export class FileState {
  private reads = new Map<string, number>(); // absolute path -> mtimeMs at read
  private modified = new Set<string>();

  markRead(path: string): void {
    const absolute = resolve(path);
    try {
      this.reads.set(absolute, statSync(absolute).mtimeMs);
    } catch {
      this.reads.set(absolute, 0);
    }
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
  isStale(path: string): boolean {
    const absolute = resolve(path);
    const seen = this.reads.get(absolute);
    if (seen === undefined) return false;
    try {
      return statSync(absolute).mtimeMs > seen;
    } catch {
      return false;
    }
  }

  readFiles(): string[] {
    return [...this.reads.keys()];
  }

  modifiedFiles(): string[] {
    return [...this.modified];
  }
}
