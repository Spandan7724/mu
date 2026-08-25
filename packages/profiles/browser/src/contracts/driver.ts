import type {
  ActionOutcome,
  BrowserAction,
  BrowserPointerAction,
  NavigateRequest,
  ObserveRequest,
  SubmitRequest,
  UploadRequest,
  WaitRequest,
} from "./actions.ts";
import type { BrowserConnectionState, ConnectOptions } from "./connection.ts";
import type { JsonValue } from "./json.ts";
import type { BrowserObservation } from "./observation.ts";
import type { TabOutcome, TabRequest } from "./tabs.ts";
import type { TakeoverReason } from "./takeover.ts";

// Every long-running method takes an AbortSignal. `status()` is synchronous and
// `takeover()` only marks a state transition, so neither needs one.
export interface BrowserDriver {
  connect(options: ConnectOptions, signal: AbortSignal): Promise<BrowserConnectionState>;
  disconnect(): Promise<void>;
  status(): BrowserConnectionState;
  observe(request: ObserveRequest, signal: AbortSignal): Promise<BrowserObservation>;
  navigate(request: NavigateRequest, signal: AbortSignal): Promise<ActionOutcome>;
  act(request: BrowserAction, signal: AbortSignal): Promise<ActionOutcome>;
  pointer(request: BrowserPointerAction, signal: AbortSignal): Promise<ActionOutcome>;
  submit(request: SubmitRequest, signal: AbortSignal): Promise<ActionOutcome>;
  tabs(request: TabRequest, signal: AbortSignal): Promise<TabOutcome>;
  upload(request: UploadRequest, signal: AbortSignal): Promise<ActionOutcome>;
  wait(request: WaitRequest, signal: AbortSignal): Promise<ActionOutcome>;
  takeover(reason: TakeoverReason): Promise<void>;
  resumeFromTakeover(signal: AbortSignal): Promise<BrowserObservation>;
}

// Failures the driver raises instead of describing in an ActionOutcome: they end
// the operation rather than reporting on a page. Page-level results — blocked,
// stale, unknown — stay in ActionOutcome so the model can react to them.
export type BrowserDriverErrorCode =
  | "not-connected"
  | "connection-lost"
  | "browser-crashed"
  | "timeout"
  | "aborted"
  | "protocol-mismatch"
  | "unsupported";

export const RECONNECTABLE_ERROR_CODES: readonly BrowserDriverErrorCode[] = [
  "connection-lost",
  "browser-crashed",
];

export class BrowserDriverError extends Error {
  readonly code: BrowserDriverErrorCode;

  constructor(code: BrowserDriverErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "BrowserDriverError";
    this.code = code;
  }

  get reconnectable(): boolean {
    return RECONNECTABLE_ERROR_CODES.includes(this.code);
  }

  // Errors are thrown, not emitted. This is the only shape of one that may reach
  // a tool result, event or session entry.
  toDetails(): JsonValue {
    return { kind: "browser-driver-error", code: this.code, message: this.message };
  }
}

export function isBrowserDriverError(value: unknown): value is BrowserDriverError {
  return value instanceof BrowserDriverError;
}

export function abortError(signal?: AbortSignal): BrowserDriverError {
  const reason = signal?.reason;
  const message = reason instanceof Error ? reason.message : "operation aborted";
  return new BrowserDriverError("aborted", message);
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}
