// ARCHITECTURE §7, as a table rather than as scattered assignments. The doc's
// "observing" step is not a phase of its own: `BrowserConnectionPhase` has no such
// member, and the re-observation it describes is what the runtime performs on the
// way back to `ready`, which is why `resumed` and `reconnected` land there.
import { acceptsModelActions, type BrowserConnectionPhase } from "../contracts/connection.ts";

export type BrowserRuntimeTrigger =
  | "connect"
  | "approved"
  | "rejected"
  | "failed"
  | "acted"
  | "takeover"
  | "resumed"
  | "bridge-lost"
  | "reconnected"
  | "timed-out"
  | "shutdown"
  | "closed";

const TRANSITIONS: Readonly<
  Record<BrowserConnectionPhase, Partial<Record<BrowserRuntimeTrigger, BrowserConnectionPhase>>>
> = {
  disconnected: { connect: "connecting", shutdown: "disconnected" },
  connecting: {
    approved: "ready",
    rejected: "disconnected",
    failed: "failed",
    shutdown: "closing",
  },
  ready: {
    acted: "ready",
    takeover: "takeover",
    "bridge-lost": "reconnecting",
    failed: "failed",
    shutdown: "closing",
  },
  takeover: { resumed: "ready", "bridge-lost": "reconnecting", shutdown: "closing" },
  reconnecting: {
    reconnected: "ready",
    "timed-out": "failed",
    failed: "failed",
    shutdown: "closing",
  },
  closing: { closed: "disconnected", failed: "failed" },
  failed: { connect: "connecting", shutdown: "closing", closed: "disconnected" },
};

export function nextPhase(
  phase: BrowserConnectionPhase,
  trigger: BrowserRuntimeTrigger,
): BrowserConnectionPhase | undefined {
  return TRANSITIONS[phase][trigger];
}

export function canTransition(
  phase: BrowserConnectionPhase,
  trigger: BrowserRuntimeTrigger,
): boolean {
  return nextPhase(phase, trigger) !== undefined;
}

// Re-exported so a caller never has to remember that `ready` is the only phase
// that accepts model-authored actions.
export { acceptsModelActions };

export function phaseSummary(phase: BrowserConnectionPhase): string {
  switch (phase) {
    case "disconnected":
      return "not connected to a browser";
    case "connecting":
      return "waiting for the browser connection to be approved";
    case "ready":
      return "connected and accepting actions";
    case "takeover":
      return "paused — you have control of the browser";
    case "reconnecting":
      return "the connection dropped; reconnecting";
    case "closing":
      return "shutting the browser connection down";
    case "failed":
      return "the browser connection failed";
  }
}
