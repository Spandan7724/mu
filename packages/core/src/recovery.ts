// Layer 3 — reactive recovery. When a provider rejects a request because the
// context is too long, compact and retry once rather than failing the run.
// This is the safety net for when Layers 0–2 mis-estimated.
import { AiError, isContextTooLongMessage } from "@mu/ai";

export function isContextTooLongError(error: unknown): boolean {
  if (error instanceof AiError) return error.kind === "context_too_long";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return isContextTooLongMessage(message);
}

// An assistant message that failed for context reasons, as surfaced by the
// loop (which turns provider errors into a message rather than a throw).
export function isContextTooLongResult(result: {
  stopReason: string;
  errorMessage?: string | undefined;
}): boolean {
  if (result.stopReason !== "error") return false;
  return isContextTooLongMessage(result.errorMessage ?? "");
}

export interface RecoveryAttempt<T> {
  run: () => Promise<T>;
  recover: () => Promise<void>;
  isRecoverable: (value: T) => boolean;
}

// Runs, and on a recoverable outcome compacts once and runs again. Exactly one
// retry: if the second attempt still fails, the caller sees the real error
// rather than an endless compaction loop.
export async function withContextRecovery<T>(attempt: RecoveryAttempt<T>): Promise<{
  value: T;
  recovered: boolean;
}> {
  const first = await attempt.run();
  if (!attempt.isRecoverable(first)) return { value: first, recovered: false };

  await attempt.recover();
  return { value: await attempt.run(), recovered: true };
}
