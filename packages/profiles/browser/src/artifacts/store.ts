import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { basenameSchema } from "../contracts/primitives.ts";
import { type BrowserReceipt, browserReceiptSchema } from "../contracts/receipt.ts";
import {
  ARTIFACT_RETENTION,
  type ArtifactEntry,
  type ArtifactKind,
  planRetention,
  type RetentionLimits,
} from "./retention.ts";

const DIRECTORY_BY_KIND: Readonly<Record<ArtifactKind, string>> = {
  screenshot: "screenshots",
  observation: "observations",
  download: "downloads",
  log: "logs",
  receipt: "receipts",
};

export interface ArtifactWrite {
  // Relative to the artifact root: what a receipt or session entry may reference.
  path: string;
  bytes: number;
  evicted: string[];
}

export interface BrowserArtifactStoreOptions {
  root?: string | undefined;
  retention?: Partial<Record<ArtifactKind, RetentionLimits>> | undefined;
  now?: (() => number) | undefined;
}

export class ArtifactWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactWriteError";
  }
}

// SECURITY.md §11: private roots, 0700 directories, 0600 files, atomic writes.
export class BrowserArtifactStore {
  readonly root: string;
  private readonly retention: Record<ArtifactKind, RetentionLimits>;
  private readonly now: () => number;

  constructor(options: BrowserArtifactStoreOptions = {}) {
    this.root = options.root ?? join(homedir(), ".mu", "browser", "artifacts");
    this.retention = { ...ARTIFACT_RETENTION, ...options.retention };
    this.now = options.now ?? Date.now;
  }

  directory(kind: ArtifactKind): string {
    return join(this.root, DIRECTORY_BY_KIND[kind]);
  }

  relativePath(kind: ArtifactKind, name: string): string {
    return `${DIRECTORY_BY_KIND[kind]}/${name}`;
  }

  async write(kind: ArtifactKind, name: string, data: string | Uint8Array): Promise<ArtifactWrite> {
    const parsed = basenameSchema.safeParse(name);
    if (!parsed.success) {
      throw new ArtifactWriteError("an artifact is named by a bare filename");
    }
    const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    const limits = this.retention[kind];
    if (bytes > limits.maxBytes) {
      throw new ArtifactWriteError(
        `a ${kind} artifact of ${bytes} bytes exceeds the ${limits.maxBytes} byte budget for its kind`,
      );
    }
    const directory = this.directory(kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(this.root, 0o700);
      await chmod(directory, 0o700);
    }
    const destination = join(directory, name);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
      if (process.platform !== "win32") await chmod(destination, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return { path: this.relativePath(kind, name), bytes, evicted: await this.prune(kind) };
  }

  // A screenshot reaches disk as bytes. Base64 is an in-memory transport only and
  // never a value a receipt, event or log may hold (SECURITY.md §11).
  async writeScreenshot(name: string, base64: string): Promise<ArtifactWrite> {
    return this.write("screenshot", name, Buffer.from(base64, "base64"));
  }

  async writeReceipt(receipt: BrowserReceipt): Promise<ArtifactWrite> {
    const parsed = browserReceiptSchema.safeParse(receipt);
    if (!parsed.success) {
      throw new ArtifactWriteError(parsed.error.issues[0]?.message ?? "invalid receipt");
    }
    return this.write("receipt", `${receipt.id}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  }

  async readReceipt(id: string): Promise<BrowserReceipt | undefined> {
    let raw: string;
    try {
      raw = await readFile(join(this.directory("receipt"), `${id}.json`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = browserReceiptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as BrowserReceipt) : undefined;
  }

  async list(kind: ArtifactKind): Promise<ArtifactEntry[]> {
    const directory = this.directory(kind);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: ArtifactEntry[] = [];
    for (const name of names) {
      if (name.endsWith(".tmp")) continue;
      try {
        const stats = await stat(join(directory, name));
        if (!stats.isFile()) continue;
        entries.push({ name, bytes: stats.size, createdAt: stats.mtimeMs });
      } catch {
        // A file that disappeared under us needs no eviction.
      }
    }
    return entries.sort((left, right) => left.createdAt - right.createdAt);
  }

  async prune(kind: ArtifactKind): Promise<string[]> {
    const plan = planRetention(await this.list(kind), this.retention[kind], this.now());
    const directory = this.directory(kind);
    for (const entry of plan.evict) {
      await rm(join(directory, entry.name), { force: true });
    }
    return plan.evict.map((entry) => entry.name);
  }

  async pruneAll(): Promise<Record<ArtifactKind, string[]>> {
    const result = {} as Record<ArtifactKind, string[]>;
    for (const kind of Object.keys(DIRECTORY_BY_KIND) as ArtifactKind[]) {
      result[kind] = await this.prune(kind);
    }
    return result;
  }
}
