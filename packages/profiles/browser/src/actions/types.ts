import type { TabInfo } from "../browser/tabs.ts";

export type Ref = string;

export interface Timings {
  cdpMs: number;
  settleMs: number;
  snapshotMs: number;
  screenshotMs: number;
  totalMs: number;
}

export type OutcomeKind =
  | "stale-ref"
  | "occluded"
  | "no-change"
  | "navigated"
  | "new-tab"
  | "dialog"
  | "value-mismatch"
  | "timeout"
  | "blocked-by-dialog"
  | "not-interactable"
  | "error";

export interface OutcomeDetails {
  timings: Timings;
  url: string;
  tabId: string;
  fingerprint: string;
  snapshotTokens: number;
  settle?: string;
  path?: "mouse" | "js" | "keyboard";
}

export interface ActionOutcome {
  ok: boolean;
  summary: string;
  kind?: OutcomeKind;
  occludedBy?: { ref?: Ref; role: string; name: string };
  newTab?: TabInfo;
  details: OutcomeDetails;
}

// Accumulates per-phase durations for one tool call.
export class Stopwatch {
  private readonly started = performance.now();
  readonly timings: Omit<Timings, "totalMs"> = {
    cdpMs: 0,
    settleMs: 0,
    snapshotMs: 0,
    screenshotMs: 0,
  };

  async time<T>(phase: keyof Omit<Timings, "totalMs">, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await work();
    } finally {
      this.timings[phase] += performance.now() - start;
    }
  }

  finish(): Timings {
    const round = (value: number) => Math.round(value);
    return {
      cdpMs: round(this.timings.cdpMs),
      settleMs: round(this.timings.settleMs),
      snapshotMs: round(this.timings.snapshotMs),
      screenshotMs: round(this.timings.screenshotMs),
      totalMs: round(performance.now() - this.started),
    };
  }
}
