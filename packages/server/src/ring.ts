import type { AgentEvent } from "@mu/core";

export interface SeqEvent {
  seq: number;
  event: AgentEvent;
}

export const DEFAULT_RING_ENTRIES = 2_000;
export const DEFAULT_RING_BYTES = 8 * 1024 * 1024;

// Bounded, sequence-numbered history of recent events. A client that drops for
// twenty seconds re-attaches with `sinceSeq` and gets the gap replayed instead
// of a full resync. It is a reconnection convenience and never a source of
// truth — the session JSONL is (PROTOCOL.md §8.10).
export class EventRing {
  private entries: { seq: number; event: AgentEvent; bytes: number }[] = [];
  private lastSeq = 0;
  private bytes = 0;

  constructor(
    private readonly maxEntries = DEFAULT_RING_ENTRIES,
    private readonly maxBytes = DEFAULT_RING_BYTES,
  ) {}

  get seq(): number {
    return this.lastSeq;
  }

  // The oldest sequence still replayable, or seq + 1 when the ring is empty.
  get oldestSeq(): number {
    return this.entries[0]?.seq ?? this.lastSeq + 1;
  }

  push(event: AgentEvent): SeqEvent {
    this.lastSeq += 1;
    const bytes = JSON.stringify(event).length;
    this.entries.push({ seq: this.lastSeq, event, bytes });
    this.bytes += bytes;
    while (
      this.entries.length > this.maxEntries ||
      (this.bytes > this.maxBytes && this.entries.length > 1)
    ) {
      const dropped = this.entries.shift();
      this.bytes -= dropped?.bytes ?? 0;
    }
    return { seq: this.lastSeq, event };
  }

  // Everything after `sinceSeq`. `undefined` means the caller asked for history
  // that has aged out and must take a fresh snapshot instead.
  since(sinceSeq: number): SeqEvent[] | undefined {
    if (sinceSeq > this.lastSeq) return [];
    if (sinceSeq < this.oldestSeq - 1) return undefined;
    return this.entries
      .filter((entry) => entry.seq > sinceSeq)
      .map(({ seq, event }) => ({ seq, event }));
  }
}
