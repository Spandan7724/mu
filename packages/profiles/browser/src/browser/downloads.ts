import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CdpConnection } from "../cdp/connection.ts";

export interface DownloadRecord {
  guid: string;
  url: string;
  filename: string;
  path: string;
  state: "in progress" | "completed" | "canceled";
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
}

// Browser-wide downloads for this mu session, saved under one directory.
export class DownloadTracker {
  private readonly records = new Map<string, DownloadRecord>();
  private readonly listeners = new Set<() => void>();

  constructor(readonly directory: string) {}

  async attach(connection: CdpConnection, signal?: AbortSignal): Promise<void> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    connection.on("Browser.downloadWillBegin", (event) => {
      this.records.set(event.guid, {
        guid: event.guid,
        url: event.url,
        filename: event.suggestedFilename,
        path: join(this.directory, event.suggestedFilename),
        state: "in progress",
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: Date.now(),
      });
      this.notify();
    });
    connection.on("Browser.downloadProgress", (event) => {
      const record = this.records.get(event.guid);
      if (!record) return;
      record.receivedBytes = event.receivedBytes;
      record.totalBytes = event.totalBytes;
      if (event.state === "completed") {
        record.state = "completed";
        if (event.filePath) record.path = event.filePath;
      } else if (event.state === "canceled") record.state = "canceled";
      this.notify();
    });
    await connection.send(
      "Browser.setDownloadBehavior",
      { behavior: "allow", downloadPath: this.directory, eventsEnabled: true },
      { signal, timeoutMs: 5_000 },
    );
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  list(): DownloadRecord[] {
    return [...this.records.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  since(time: number): DownloadRecord[] {
    return this.list().filter((record) => record.startedAt >= time);
  }

  // Resolves when a download started since `time` exists, or at the cap.
  async waitForStart(time: number, capMs: number, signal?: AbortSignal): Promise<void> {
    if (this.since(time).length > 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const listener = () => {
        if (this.since(time).length > 0) done();
      };
      const timer = setTimeout(done, capMs);
      this.listeners.add(listener);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  // Resolves when every download started since `time` finished, or at the cap.
  async waitForFinished(time: number, capMs: number, signal?: AbortSignal): Promise<void> {
    const pending = () => this.since(time).some((record) => record.state === "in progress");
    if (!pending()) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, capMs);
      const off = (() => {
        const listener = () => {
          if (!pending()) done();
        };
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      })();
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

export function formatDownloads(records: DownloadRecord[]): string {
  if (records.length === 0) return "(no downloads in this session)";
  return records
    .map((record) => {
      const size =
        record.totalBytes > 0
          ? `${record.receivedBytes}/${record.totalBytes} bytes`
          : `${record.receivedBytes} bytes`;
      return `- ${record.filename} — ${record.state}, ${size} → ${record.path}`;
    })
    .join("\n");
}
