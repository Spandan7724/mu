import type { CdpSession } from "../cdp/session.ts";

// Streams and beacons never "finish" in a way that means the page is busy.
const IGNORED_TYPES = new Set([
  "WebSocket",
  "EventSource",
  "Media",
  "Ping",
  "Prefetch",
  "CSPViolationReport",
]);

interface Inflight {
  started: number;
  url: string;
  session: string;
}

// In-flight requests of one tab across its own and its OOPIF sessions.
export class NetworkTracker {
  private readonly inflight = new Map<string, Inflight>();
  private readonly listeners = new Set<() => void>();
  lastActivity = 0;

  attach(session: CdpSession): () => void {
    // Request ids are browser-wide: a frame's document request can start in the
    // parent session and finish in the out-of-process frame's own session.
    const finish = (requestId: string) => {
      if (this.inflight.delete(requestId)) this.touch();
    };
    const offs = [
      session.on("Network.requestWillBeSent", (event) => {
        if (IGNORED_TYPES.has(event.type ?? "") || event.request.url.startsWith("data:")) return;
        this.inflight.set(event.requestId, {
          started: performance.now(),
          url: event.request.url,
          session: session.sessionId,
        });
        this.touch();
      }),
      session.on("Network.loadingFinished", (event) => finish(event.requestId)),
      session.on("Network.loadingFailed", (event) => finish(event.requestId)),
      session.on("Network.requestServedFromCache", (event) => finish(event.requestId)),
    ];
    return () => {
      for (const off of offs) off();
      for (const [id, request] of [...this.inflight]) {
        if (request.session === session.sessionId) this.inflight.delete(id);
      }
    };
  }

  private touch(): void {
    this.lastActivity = performance.now();
    for (const listener of [...this.listeners]) listener();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Requests older than `longPollMs` are treated as long-polls, not page work.
  pending(longPollMs: number): number {
    const now = performance.now();
    let count = 0;
    for (const request of this.inflight.values()) if (now - request.started < longPollMs) count++;
    return count;
  }

  // When the oldest counted request stops counting, if any.
  nextExpiry(longPollMs: number): number | undefined {
    let earliest: number | undefined;
    for (const request of this.inflight.values()) {
      const expiry = request.started + longPollMs;
      if (expiry > performance.now() && (earliest === undefined || expiry < earliest))
        earliest = expiry;
    }
    return earliest;
  }
}
