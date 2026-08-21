import type { AssistantMessage, ToolResultContent, ToolResultMessage, Usage } from "@mu/ai";
import type { AgentMessage } from "./messages.ts";
import type { PermissionRequest } from "./permission.ts";

// Fine-grained deltas for renderers that stream. Carried alongside the
// accumulating partial message on message_update.
export type StreamDelta =
  | { kind: "text_start"; contentIndex: number }
  | { kind: "text_delta"; contentIndex: number; text: string }
  | { kind: "text_end"; contentIndex: number }
  | { kind: "thinking_start"; contentIndex: number }
  | { kind: "thinking_delta"; contentIndex: number; text: string }
  | { kind: "thinking_end"; contentIndex: number }
  | { kind: "toolcall_start"; contentIndex: number }
  | { kind: "toolcall_delta"; contentIndex: number; argsFragment: string }
  | { kind: "toolcall_end"; contentIndex: number; toolCallId: string };

export type AgentEndReason = "done" | "aborted" | "budget" | "maxTurns" | "error";
export type CompactionTrigger = "manual" | "threshold" | "overflow" | "model-change";
export type CompactionStage = "clearing-tool-output" | "summarizing" | "installing";

// THE contract. Every consumer (UI, session persistence, extensions, RPC
// clients, SDK streaming) reads this union, and nothing user-visible happens
// outside it. Every member must be JSON-serializable.
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; reason: AgentEndReason }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AssistantMessage; delta: StreamDelta }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; partial: ToolResultContent[] }
  | { type: "tool_execution_end"; toolCallId: string; result: ToolResultMessage }
  | { type: "permission_asked"; request: PermissionRequest }
  | {
      type: "permission_resolved";
      requestId: string;
      outcome: "allow" | "deny";
      remembered?: boolean;
    }
  | {
      type: "compaction_start";
      layer: 1 | 2 | 3;
      trigger?: CompactionTrigger;
      contextTokensBefore?: number;
    }
  | {
      type: "compaction_update";
      layer: 1 | 2 | 3;
      stage: CompactionStage;
      toolResultsCleared?: number;
    }
  | {
      type: "compaction_end";
      layer: 1 | 2 | 3;
      tokensFreed: number;
      summaryEntryId?: string;
      trigger?: CompactionTrigger;
      status?: "completed" | "failed" | "cancelled" | "noop";
      contextTokensBefore?: number;
      contextTokensAfter?: number;
      toolResultsCleared?: number;
      keptTokens?: number;
      errorMessage?: string;
    }
  | { type: "task_started"; taskId: string; command: string; background: boolean }
  | { type: "task_output"; taskId: string; chunk: string }
  | {
      type: "task_exited";
      taskId: string;
      exitCode: number | null;
      status?: "exited" | "killed";
    }
  | {
      type: "usage_updated";
      sessionTotals: Usage;
      contextTokens: number;
      contextPercent: number;
    }
  // Status of a resource a profile owns — a browser connection, a database session, a
  // remote runtime. The kernel forwards it without interpreting any of it: no field
  // here names a domain, and there is no free-form metadata bag for one to hide in.
  // Ephemeral by design: it describes what is true now, so it is never written to the
  // transcript and never replayed.
  | {
      type: "profile_resource_status";
      resourceId: string;
      state: string;
      summary: string;
      detail?: string;
    };

export const PROFILE_RESOURCE_STATUS_LIMITS = {
  maxResourceIdLength: 64,
  maxStateLength: 64,
  maxSummaryLength: 200,
  maxDetailLength: 2_000,
} as const;

const PROFILE_RESOURCE_ID = /^[a-z][a-z0-9-]*$/;

// A profile can emit anything; the kernel guarantees the shape stays small and
// serializable so every consumer can render it without defensive truncation.
export function profileResourceStatus(input: {
  resourceId: string;
  state: string;
  summary: string;
  detail?: string | undefined;
}): Extract<AgentEvent, { type: "profile_resource_status" }> {
  const { maxResourceIdLength, maxStateLength, maxSummaryLength, maxDetailLength } =
    PROFILE_RESOURCE_STATUS_LIMITS;
  if (!PROFILE_RESOURCE_ID.test(input.resourceId))
    throw new Error(`Invalid profile resource id: "${input.resourceId.slice(0, 64)}"`);
  if (input.resourceId.length > maxResourceIdLength)
    throw new Error("Invalid profile resource id: too long");
  const clamp = (value: string, max: number) =>
    value.length > max ? `${value.slice(0, max - 1)}…` : value;
  return {
    type: "profile_resource_status",
    resourceId: input.resourceId,
    state: clamp(input.state, maxStateLength),
    summary: clamp(input.summary, maxSummaryLength),
    ...(input.detail === undefined ? {} : { detail: clamp(input.detail, maxDetailLength) }),
  };
}

export type AgentEventType = AgentEvent["type"];

export type EventSink = (event: AgentEvent) => void | Promise<void>;
