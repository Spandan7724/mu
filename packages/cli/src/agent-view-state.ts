import type { AgentEvent, PermissionRequest } from "mu";
import { z } from "zod";

export const AGENT_VIEW_PROTOCOL_VERSION = 1;
export const MAX_AGENT_VIEW_PROMPT_CHARS = 1_000_000;
export const MAX_AGENT_VIEW_SUMMARY_CHARS = 240;
export const MAX_AGENT_VIEW_NAME_CHARS = 80;
export const MAX_AGENT_VIEW_ERROR_CHARS = 2_000;

export const managedSessionStateSchema = z.enum([
  "starting",
  "working",
  "needs_input",
  "completed",
  "failed",
  "stopped",
]);
export type ManagedSessionState = z.infer<typeof managedSessionStateSchema>;

export const permissionRequestSchema = z.object({
  id: z.string().min(1).max(256),
  toolCallId: z.string().min(1).max(512),
  toolName: z.string().min(1).max(256),
  permission: z.string().min(1).max(256),
  pattern: z.string().max(MAX_AGENT_VIEW_PROMPT_CHARS),
  description: z.string().max(MAX_AGENT_VIEW_ERROR_CHARS),
  preview: z.unknown().optional(),
});

export const managedSessionRecordSchema = z
  .object({
    sessionId: z.string().min(1).max(512),
    scope: z.string().min(1).max(256),
    name: z.string().min(1).max(MAX_AGENT_VIEW_NAME_CHARS),
    initialPrompt: z.string().min(1).max(MAX_AGENT_VIEW_PROMPT_CHARS),
    originCwd: z.string().min(1).max(8_192),
    workingCwd: z.string().min(1).max(8_192),
    profile: z.string().min(1).max(512),
    model: z.string().max(512).optional(),
    state: managedSessionStateSchema,
    summary: z.string().max(MAX_AGENT_VIEW_SUMMARY_CHARS),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),
    ownerPid: z.number().int().positive().optional(),
    attached: z.boolean(),
    pendingRequest: permissionRequestSchema.optional(),
    lastError: z.string().max(MAX_AGENT_VIEW_ERROR_CHARS).optional(),
  })
  .passthrough();

export type ManagedSessionRecord = z.infer<typeof managedSessionRecordSchema>;

export const rosterSchema = z
  .object({
    version: z.literal(AGENT_VIEW_PROTOCOL_VERSION),
    records: z.array(managedSessionRecordSchema).max(10_000),
  })
  .passthrough();

export type ManagedSessionTransition =
  | { type: "runtime_ready"; pid: number; model?: string }
  | { type: "agent_event"; event: AgentEvent }
  | { type: "worker_failed"; message: string }
  | { type: "stopped" }
  | { type: "attached"; attached: boolean };

function bounded(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function promptName(prompt: string): string {
  return bounded(prompt, MAX_AGENT_VIEW_NAME_CHARS) || "new session";
}

export function displaySummary(value: string): string {
  return bounded(value, MAX_AGENT_VIEW_SUMMARY_CHARS);
}

function assistantText(event: Extract<AgentEvent, { type: "message_end" }>): string {
  if (event.message.role !== "assistant") return "";
  return event.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");
}

function primaryArgument(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const values = args as Record<string, unknown>;
  for (const key of ["path", "command", "pattern", "query", "url", "taskId"]) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function reduceManagedSession(
  previous: ManagedSessionRecord,
  transition: ManagedSessionTransition,
  now = Date.now(),
): ManagedSessionRecord {
  switch (transition.type) {
    case "runtime_ready":
      return {
        ...previous,
        state: previous.state === "starting" ? "working" : previous.state,
        ownerPid: transition.pid,
        ...(transition.model ? { model: transition.model } : {}),
        updatedAt: now,
        lastError: undefined,
      };
    case "attached":
      return { ...previous, attached: transition.attached, updatedAt: now };
    case "stopped":
      return {
        ...previous,
        state: "stopped",
        attached: false,
        ownerPid: undefined,
        pendingRequest: undefined,
        summary: "runtime stopped · session preserved",
        updatedAt: now,
      };
    case "worker_failed": {
      const message = bounded(transition.message, MAX_AGENT_VIEW_ERROR_CHARS);
      return {
        ...previous,
        state: "failed",
        attached: false,
        ownerPid: undefined,
        pendingRequest: undefined,
        lastError: message,
        summary: displaySummary(message),
        updatedAt: now,
        completedAt: now,
      };
    }
    case "agent_event": {
      const event = transition.event;
      switch (event.type) {
        case "agent_start":
          return {
            ...previous,
            state: "working",
            pendingRequest: undefined,
            completedAt: undefined,
            updatedAt: now,
          };
        case "permission_asked":
          return {
            ...previous,
            state: "needs_input",
            pendingRequest: event.request as PermissionRequest,
            summary: displaySummary(event.request.description),
            updatedAt: now,
          };
        case "permission_resolved":
          if (previous.pendingRequest?.id !== event.requestId) return previous;
          return {
            ...previous,
            state: "working",
            pendingRequest: undefined,
            summary: event.outcome === "allow" ? "permission allowed" : "permission denied",
            updatedAt: now,
          };
        case "tool_execution_start": {
          const primary = primaryArgument(event.args);
          return {
            ...previous,
            state: "working",
            summary: displaySummary(primary ? `${event.toolName} · ${primary}` : event.toolName),
            updatedAt: now,
          };
        }
        case "web_search_start":
        case "web_search_end": {
          const action = event.search.action;
          const detail =
            action?.type === "search"
              ? (action.query ?? action.queries?.join(", "))
              : action?.type === "openPage" || action?.type === "findInPage"
                ? action.url
                : undefined;
          return {
            ...previous,
            state: "working",
            summary: displaySummary(detail ? `web search · ${detail}` : "web search"),
            updatedAt: now,
          };
        }
        case "message_start":
          return event.message.role === "assistant"
            ? { ...previous, summary: "", updatedAt: now }
            : previous;
        case "message_update":
          if (event.delta.kind !== "text_delta") return previous;
          return {
            ...previous,
            summary: displaySummary(`${previous.summary}${event.delta.text}`),
            updatedAt: now,
          };
        case "message_end": {
          if (event.message.role !== "assistant") return previous;
          const text = assistantText(event);
          const error =
            event.message.stopReason === "error" ? event.message.errorMessage : undefined;
          return {
            ...previous,
            ...(text ? { summary: displaySummary(text) } : {}),
            ...(error ? { lastError: bounded(error, MAX_AGENT_VIEW_ERROR_CHARS) } : {}),
            updatedAt: now,
          };
        }
        case "agent_end": {
          const failed = event.reason === "error";
          return {
            ...previous,
            state: failed ? "failed" : "completed",
            pendingRequest: undefined,
            updatedAt: now,
            completedAt: now,
            ...(failed && !previous.lastError ? { lastError: "agent run failed" } : {}),
          };
        }
        default:
          return previous;
      }
    }
  }
}

export function createManagedSessionRecord(input: {
  sessionId: string;
  scope: string;
  prompt: string;
  cwd: string;
  profile: string;
  model?: string;
  now?: number;
}): ManagedSessionRecord {
  const now = input.now ?? Date.now();
  const prompt = input.prompt.trim();
  return {
    sessionId: input.sessionId,
    scope: input.scope,
    name: promptName(prompt),
    initialPrompt: prompt,
    originCwd: input.cwd,
    workingCwd: input.cwd,
    profile: input.profile,
    ...(input.model ? { model: input.model } : {}),
    state: "starting",
    summary: displaySummary(prompt),
    createdAt: now,
    updatedAt: now,
    attached: false,
  };
}
