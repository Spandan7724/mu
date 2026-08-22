// TOOLS.md design rule 7: a tool error is a recoverable instruction. Every failure that
// reaches the model leaves it with a next move — observe again, wait, request takeover,
// ask the user — never a bare protocol string.
import {
  BrowserDriverError,
  type BrowserDriverErrorCode,
  isBrowserDriverError,
} from "../contracts/driver.ts";

export interface NormalizedToolError {
  code: BrowserDriverErrorCode | "internal";
  message: string;
  instruction: string;
  /** False when trying the same call again cannot help until something else changes. */
  retryable: boolean;
}

const INSTRUCTIONS: Record<BrowserDriverErrorCode, string> = {
  "not-connected":
    "No browser is connected. Ask the user to connect one with /browser connect, then observe before acting.",
  "approval-required":
    "The user has to approve this connection in the browser window. Ask them to approve it, then observe again.",
  "connection-lost":
    "The browser connection dropped. Nothing about the last action is confirmed: reconnect, observe the page, and read what it actually says before deciding anything.",
  "browser-crashed":
    "The browser stopped. Nothing about the last action is confirmed: ask the user to restart it, then observe the page before deciding anything.",
  timeout:
    "The page did not respond in time. Observe again, or use browser_wait for the condition you expect before retrying.",
  aborted: "The operation was cancelled. Nothing further was attempted.",
  "protocol-mismatch":
    "The browser driver and the browser do not agree on a protocol version. Tell the user to update, and stop rather than working around it.",
  unsupported:
    "The browser cannot do this in its current state. Observe again, or request browser_takeover so the user can do it directly.",
};

const NEVER_RETRYABLE: readonly BrowserDriverErrorCode[] = [
  "approval-required",
  "aborted",
  "protocol-mismatch",
  "unsupported",
];

export function normalizeToolError(error: unknown): NormalizedToolError {
  if (isBrowserDriverError(error)) {
    return {
      code: error.code,
      message: error.message,
      instruction: INSTRUCTIONS[error.code],
      retryable: !NEVER_RETRYABLE.includes(error.code),
    };
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
    instruction:
      "The browser tool failed before it reached the page. Observe again; if it repeats, tell the user rather than retrying.",
    retryable: false,
  };
}

export function toolErrorText(error: unknown): string {
  const normalized = normalizeToolError(error);
  return `${normalized.message}\n${normalized.instruction}`;
}

export function isAbort(error: unknown): boolean {
  if (isBrowserDriverError(error)) return error.code === "aborted";
  return error instanceof Error && error.name === "AbortError";
}

export function abortedError(): BrowserDriverError {
  return new BrowserDriverError("aborted", "the browser operation was cancelled");
}
