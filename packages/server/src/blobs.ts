import type { ToolResultContent } from "@mu/core";

export const DEFAULT_BLOB_ENTRIES = 200;
export const DEFAULT_BLOB_BYTES = 32 * 1024 * 1024;

// Full payloads that were budgeted out of a subscriber's stream, kept until
// something asks for them. The complete result is already durable in the
// session JSONL, so an aged-out blob is a degraded view, never data loss.
export class BlobStore {
  private blobs = new Map<string, { content: ToolResultContent[]; bytes: number }>();
  private counter = 0;
  private bytes = 0;

  constructor(
    private readonly maxEntries = DEFAULT_BLOB_ENTRIES,
    private readonly maxBytes = DEFAULT_BLOB_BYTES,
  ) {}

  put(content: ToolResultContent[]): { ref: string; bytes: number } {
    this.counter += 1;
    const ref = `b_${this.counter.toString(36)}`;
    const bytes = JSON.stringify(content).length;
    this.blobs.set(ref, { content, bytes });
    this.bytes += bytes;
    while (
      this.blobs.size > this.maxEntries ||
      (this.bytes > this.maxBytes && this.blobs.size > 1)
    ) {
      const oldest = this.blobs.keys().next();
      if (oldest.done) break;
      this.bytes -= this.blobs.get(oldest.value)?.bytes ?? 0;
      this.blobs.delete(oldest.value);
    }
    return { ref, bytes };
  }

  get(ref: string): ToolResultContent[] | undefined {
    return this.blobs.get(ref)?.content;
  }

  get size(): number {
    return this.blobs.size;
  }
}
