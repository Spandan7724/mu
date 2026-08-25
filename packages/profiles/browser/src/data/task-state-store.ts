import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrowserTaskLedgerSnapshot,
  parseBrowserTaskLedgerSnapshot,
} from "../tools/task-ledger.ts";

const MAX_STATE_BYTES = 512 * 1024;

export class BrowserTaskStateStore {
  constructor(readonly root: string) {}

  path(sessionId: string): string {
    const key = createHash("sha256").update(sessionId).digest("hex");
    return join(this.root, `${key}.json`);
  }

  async load(sessionId: string): Promise<BrowserTaskLedgerSnapshot | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES) return undefined;
    try {
      return parseBrowserTaskLedgerSnapshot(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  async save(sessionId: string, value: unknown): Promise<void> {
    const snapshot = parseBrowserTaskLedgerSnapshot(value);
    if (snapshot === undefined) throw new TypeError("invalid browser task-ledger snapshot");
    const serialized = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES)
      throw new TypeError("browser task state is too large");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.root, 0o700);
    const destination = this.path(sessionId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
      if (process.platform !== "win32") await chmod(destination, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
