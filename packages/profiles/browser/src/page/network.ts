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
  type: string;
  session: string;
  write: boolean;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The registrable domain, approximately (no public suffix list): the last two labels,
// three under a two-letter country code with a generic second level (example.co.uk).
// A miss only decides whether a frame document counts as a long-poll.
export function siteOf(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (!host || /^[\d.]+$|:/.test(host)) return host || undefined;
  const labels = host.split(".");
  const generic = /^(co|com|org|net|gov|ac|edu|ne|or|go)$/.test(labels.at(-2) ?? "");
  const keep = generic && (labels.at(-1)?.length ?? 0) === 2 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

function ownFrame(request: Inflight, site: string | undefined): boolean {
  return site !== undefined && request.type === "Document" && siteOf(request.url) === site;
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
          type: event.type ?? "Other",
          session: session.sessionId,
          write: !READ_METHODS.has(event.request.method),
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

  // Requests older than `longPollMs` are treated as long-polls, not page work, except a
  // frame of the page's own site still loading its document: that is the page loading
  // (Gmail's data frame took 2 s on a cold start). Third-party frames are left out because
  // ad slots hang for many seconds.
  pending(longPollMs: number, pageUrl?: string): number {
    const now = performance.now();
    const site = pageUrl ? siteOf(pageUrl) : undefined;
    let count = 0;
    for (const request of this.inflight.values()) {
      if (now - request.started < longPollMs || ownFrame(request, site)) count++;
    }
    return count;
  }

  // Writes (form saves, submissions) started between `since` and `until`: finite work
  // however slow, never a long-poll.
  pendingWrites(since: number, until = Number.POSITIVE_INFINITY): number {
    let count = 0;
    for (const request of this.inflight.values())
      if (request.write && request.started >= since && request.started <= until) count++;
    return count;
  }

  // When the oldest counted request stops counting, if any.
  nextExpiry(longPollMs: number, pageUrl?: string): number | undefined {
    const site = pageUrl ? siteOf(pageUrl) : undefined;
    let earliest: number | undefined;
    for (const request of this.inflight.values()) {
      if (ownFrame(request, site)) continue;
      const expiry = request.started + longPollMs;
      if (expiry > performance.now() && (earliest === undefined || expiry < earliest))
        earliest = expiry;
    }
    return earliest;
  }
}
