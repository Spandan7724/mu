export interface RateLimitOptions {
  // Handshake attempts allowed from one source before it is refused.
  perSource?: number;
  // Attempts allowed against one pairing token, ever.
  perToken?: number;
  windowMs?: number;
  now?: () => number;
}

export const DEFAULT_PER_SOURCE = 10;
export const DEFAULT_PER_TOKEN = 5;
export const DEFAULT_WINDOW_MS = 60_000;

// Everything before authentication is reachable by anyone who can route a
// packet, so it is capped per source and per token (SECURITY.md §6). A sliding
// window rather than a bucket: the interesting case is a burst, not a rate.
export class PreAuthLimiter {
  private readonly sources = new Map<string, number[]>();
  private readonly tokens = new Map<string, number>();
  private readonly perSource: number;
  private readonly perToken: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions = {}) {
    this.perSource = options.perSource ?? DEFAULT_PER_SOURCE;
    this.perToken = options.perToken ?? DEFAULT_PER_TOKEN;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  admit(source: string): { ok: true } | { ok: false; reason: string } {
    const at = this.now();
    const recent = (this.sources.get(source) ?? []).filter((stamp) => at - stamp < this.windowMs);
    if (recent.length >= this.perSource) {
      this.sources.set(source, recent);
      return { ok: false, reason: "too many handshake attempts" };
    }
    recent.push(at);
    this.sources.set(source, recent);
    return { ok: true };
  }

  // Counted separately: a token is a one-time secret, so repeated attempts
  // against one are a guessing attempt however many addresses they come from.
  admitToken(token: string): boolean {
    const used = (this.tokens.get(token) ?? 0) + 1;
    this.tokens.set(token, used);
    return used <= this.perToken;
  }

  // Called once a connection authenticates, so a paired device reconnecting all
  // day is never mistaken for an attacker.
  forget(source: string): void {
    this.sources.delete(source);
  }
}
