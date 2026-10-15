import type {
  AssistantMessage,
  ToolResultContent,
  ToolResultMessage,
  Usage,
  WebSearchContent,
} from "@mu/ai";
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

// What the summarizer knows while it runs, in serialized characters. Consumers
// derive any percentage; the final summary length is unknown until it ends, so
// `expectedOutputChars` is an estimate rather than a bound.
export interface CompactionProgress {
  sourceTokens: number;
  sourceChars: number;
  summarizedChars: number;
  request: number;
  requestChars: number;
  outputChars: number;
  expectedOutputChars: number;
}

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
  | {
      type: "tool_execution_update";
      toolCallId: string;
      partial: ToolResultContent[];
      details?: unknown;
    }
  | { type: "tool_execution_end"; toolCallId: string; result: ToolResultMessage }
  | { type: "web_search_start"; search: WebSearchContent }
  | { type: "web_search_end"; search: WebSearchContent }
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
      progress?: CompactionProgress;
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
  // The model does not offer the selected thinking level, so requests use
  // `level` instead. Emitted once per model and selection.
  | {
      type: "thinking_adjusted";
      model: string;
      requested: string;
      level: string;
      inferredModel?: boolean;
    }
  // A child agent that runs in the background after the tool call that started
  // it has returned. `details` are the same progress/result shapes the
  // delegation tool reports for a foreground child.
  | {
      type: "subagent_started";
      subagentId: string;
      toolCallId: string;
      kind: string;
      description: string;
    }
  | { type: "subagent_progress"; subagentId: string; details: unknown }
  | {
      type: "subagent_ended";
      subagentId: string;
      status: "done" | "error" | "stopped";
      content: ToolResultContent[];
      details?: unknown;
    }
  | {
      type: "usage_updated";
      sessionTotals: Usage;
      contextTokens: number;
      contextPercent: number;
    };

export type AgentEventType = AgentEvent["type"];

export type EventSink = (event: AgentEvent) => void | Promise<void>;
