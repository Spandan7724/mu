import type { AgentEvent, AgentMessage, PermissionRequest, Usage } from "mu";
import { builtinProviderConfigs } from "mu";
import { z } from "zod";
import {
  AGENT_VIEW_PROTOCOL_VERSION,
  MAX_AGENT_VIEW_PROMPT_CHARS,
  type ManagedSessionRecord,
  managedSessionRecordSchema,
  permissionRequestSchema,
} from "./agent-view-state.ts";

export const MAX_AGENT_VIEW_LINE_CHARS = 2_000_000;
export const MANAGED_ENVIRONMENT_KEYS = [
  ...new Set([
    "PATH",
    "Path",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "AWS_DEFAULT_REGION",
    "AWS_REGION",
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_RESOURCE_NAME",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_GATEWAY_ID",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    ...[...builtinProviderConfigs.values()].flatMap((provider) => provider.env),
  ]),
] as readonly string[];
export const MANAGED_PROFILE_ENV_PREFIX = "MU_PROFILE_";
const managedEnvironmentKeys = new Set<string>(MANAGED_ENVIRONMENT_KEYS);
const managedEnvironmentKey = (key: string): boolean =>
  managedEnvironmentKeys.has(key) ||
  (key.startsWith(MANAGED_PROFILE_ENV_PREFIX) && /^[A-Z_][A-Z0-9_]*$/.test(key));
const requestId = z.string().min(1).max(128);
const sessionId = z.string().min(1).max(512);
const text = z.string().max(MAX_AGENT_VIEW_PROMPT_CHARS);

export const agentViewRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      id: requestId,
      version: z.literal(AGENT_VIEW_PROTOCOL_VERSION),
      scope: z.string().min(1).max(256),
      cwd: z.string().min(1).max(8_192),
    })
    .strict(),
  z.object({ type: z.literal("list"), id: requestId }).strict(),
  z
    .object({
      type: z.literal("dispatch"),
      id: requestId,
      prompt: text.min(1),
      cwd: z.string().min(1).max(8_192),
      profile: z.string().min(1).max(512),
      model: z.string().min(1).max(512).optional(),
      permissionMode: z.string().min(1).max(128).optional(),
      noInstructions: z.boolean().optional(),
      environment: z
        .record(z.string(), z.string().max(100_000))
        .refine((value) => Object.keys(value).length <= 64, "environment has too many entries")
        .refine(
          (value) => Object.keys(value).every(managedEnvironmentKey),
          "environment contains a key that managed runtimes do not accept",
        )
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("attach"), id: requestId, sessionId }).strict(),
  z.object({ type: z.literal("detach"), id: requestId, sessionId }).strict(),
  z
    .object({
      type: z.literal("session_op"),
      id: requestId,
      sessionId,
      op: z.discriminatedUnion("type", [
        z.object({ type: z.literal("input"), text: text.min(1) }).strict(),
        z.object({ type: z.literal("steer"), text: text.min(1) }).strict(),
        z.object({ type: z.literal("follow_up"), text: text.min(1) }).strict(),
        z.object({ type: z.literal("command"), text: text.min(1) }).strict(),
        z.object({ type: z.literal("shell"), command: text.min(1) }).strict(),
        z
          .object({
            type: z.literal("remove_queued"),
            kind: z.enum(["steer", "follow-up"]),
            text: text.min(1),
          })
          .strict(),
        z.object({ type: z.literal("cycle_permission_mode") }).strict(),
        z.object({ type: z.literal("permission_mode"), id: z.string().min(1).max(128) }).strict(),
        z
          .object({
            type: z.literal("permission_reply"),
            requestId: z.string().min(1).max(256),
            outcome: z.enum(["allow", "deny"]),
            remember: z.boolean().optional(),
          })
          .strict(),
        z.object({ type: z.literal("abort") }).strict(),
        z.object({ type: z.literal("thinking"), level: z.string().min(1).max(128) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("resize"),
      id: requestId,
      sessionId,
      cols: z.number().int().min(1).max(2_000),
      rows: z.number().int().min(1).max(2_000),
    })
    .strict(),
  z.object({ type: z.literal("stop"), id: requestId, sessionId }).strict(),
  z.object({ type: z.literal("remove"), id: requestId, sessionId }).strict(),
]);

export type AgentViewRequest = z.infer<typeof agentViewRequestSchema>;

const messageSchema = z
  .object({ role: z.enum(["user", "assistant", "toolResult", "custom"]) })
  .passthrough();

const usageSchema = z
  .object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  })
  .passthrough();

const eventString = z.string().max(MAX_AGENT_VIEW_PROMPT_CHARS);
const eventId = z.string().min(1).max(512);
const streamDeltaSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("text_start"), contentIndex: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      kind: z.literal("text_delta"),
      contentIndex: z.number().int().nonnegative(),
      text: eventString,
    })
    .strict(),
  z.object({ kind: z.literal("text_end"), contentIndex: z.number().int().nonnegative() }).strict(),
  z
    .object({ kind: z.literal("thinking_start"), contentIndex: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      kind: z.literal("thinking_delta"),
      contentIndex: z.number().int().nonnegative(),
      text: eventString,
    })
    .strict(),
  z
    .object({ kind: z.literal("thinking_end"), contentIndex: z.number().int().nonnegative() })
    .strict(),
  z
    .object({ kind: z.literal("toolcall_start"), contentIndex: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      kind: z.literal("toolcall_delta"),
      contentIndex: z.number().int().nonnegative(),
      argsFragment: eventString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("toolcall_end"),
      contentIndex: z.number().int().nonnegative(),
      toolCallId: eventId,
    })
    .strict(),
]);

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start") }).strict(),
  z
    .object({
      type: z.literal("agent_end"),
      messages: z.array(messageSchema).max(100_000),
      reason: z.enum(["done", "aborted", "budget", "maxTurns", "error"]),
    })
    .strict(),
  z.object({ type: z.literal("turn_start") }).strict(),
  z
    .object({
      type: z.literal("turn_end"),
      message: messageSchema,
      toolResults: z.array(messageSchema).max(100_000),
    })
    .strict(),
  z.object({ type: z.literal("message_start"), message: messageSchema }).strict(),
  z
    .object({ type: z.literal("message_update"), message: messageSchema, delta: streamDeltaSchema })
    .strict(),
  z.object({ type: z.literal("message_end"), message: messageSchema }).strict(),
  z
    .object({
      type: z.literal("tool_execution_start"),
      toolCallId: eventId,
      toolName: z.string().min(1).max(256),
      args: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_execution_update"),
      toolCallId: eventId,
      partial: z.array(z.unknown()).max(100_000),
    })
    .strict(),
  z
    .object({ type: z.literal("tool_execution_end"), toolCallId: eventId, result: messageSchema })
    .strict(),
  z.object({ type: z.literal("permission_asked"), request: permissionRequestSchema }).strict(),
  z
    .object({
      type: z.literal("permission_resolved"),
      requestId: eventId,
      outcome: z.enum(["allow", "deny"]),
      remembered: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("compaction_start"),
      layer: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      trigger: z.enum(["manual", "threshold", "overflow", "model-change"]).optional(),
      contextTokensBefore: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("compaction_update"),
      layer: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      stage: z.enum(["clearing-tool-output", "summarizing", "installing"]),
      toolResultsCleared: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("compaction_end"),
      layer: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      tokensFreed: z.number(),
      summaryEntryId: eventId.optional(),
      trigger: z.enum(["manual", "threshold", "overflow", "model-change"]).optional(),
      status: z.enum(["completed", "failed", "cancelled", "noop"]).optional(),
      contextTokensBefore: z.number().nonnegative().optional(),
      contextTokensAfter: z.number().nonnegative().optional(),
      toolResultsCleared: z.number().int().nonnegative().optional(),
      keptTokens: z.number().nonnegative().optional(),
      errorMessage: z.string().max(20_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("task_started"),
      taskId: eventId,
      command: eventString,
      background: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("task_output"), taskId: eventId, chunk: eventString }).strict(),
  z
    .object({
      type: z.literal("task_exited"),
      taskId: eventId,
      exitCode: z.number().int().nullable(),
      status: z.enum(["exited", "killed"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("usage_updated"),
      sessionTotals: usageSchema,
      contextTokens: z.number().nonnegative(),
      contextPercent: z.number().nonnegative(),
    })
    .strict(),
]);

export interface AgentViewAttachment {
  sessionId: string;
  messages: AgentMessage[];
  model: string;
  contextWindow: number;
  thinking: string;
  thinkingLevels: string[];
  usage: Usage;
  contextPercent: number;
  isRunning: boolean;
  events?: AgentEvent[];
  models?: { label: string; description?: string }[];
  permissionModes?: { id: string; label: string; description: string }[];
  permissionMode?: string;
  pendingRequest?: PermissionRequest;
  commands?: { label: string; description?: string }[];
}

export const runtimeMetadataSchema = z
  .object({
    sessionId,
    model: z.string().min(1).max(512),
    contextWindow: z.number().int().nonnegative(),
    thinking: z.string().max(128),
    thinkingLevels: z.array(z.string().max(128)).max(64),
  })
  .strict();

export const attachmentSchema = z
  .object({
    sessionId,
    messages: z.array(messageSchema).max(100_000),
    model: z.string().min(1).max(512),
    contextWindow: z.number().int().nonnegative(),
    thinking: z.string().max(128),
    thinkingLevels: z.array(z.string().max(128)).max(64),
    usage: usageSchema,
    contextPercent: z.number().nonnegative(),
    isRunning: z.boolean(),
    events: z.array(agentEventSchema).max(10_000).optional(),
    models: z
      .array(
        z
          .object({
            label: z.string().min(1).max(512),
            description: z.string().max(512).optional(),
          })
          .strict(),
      )
      .max(10_000)
      .optional(),
    permissionModes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            label: z.string().min(1).max(128),
            description: z.string().max(512),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    permissionMode: z.string().min(1).max(128).optional(),
    pendingRequest: permissionRequestSchema.optional(),
    commands: z
      .array(
        z
          .object({
            label: z.string().min(1).max(128),
            description: z.string().max(512).optional(),
          })
          .strict(),
      )
      .max(1_000)
      .optional(),
  })
  .passthrough();

export const agentViewResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      version: z.literal(AGENT_VIEW_PROTOCOL_VERSION),
      pid: z.number().int().positive(),
    })
    .strict(),
  z.object({ type: z.literal("snapshot"), records: z.array(managedSessionRecordSchema) }).strict(),
  z.object({ type: z.literal("record"), record: managedSessionRecordSchema }).strict(),
  z.object({ type: z.literal("removed"), sessionId }).strict(),
  z.object({ type: z.literal("event"), sessionId, event: agentEventSchema }).strict(),
  z
    .object({
      type: z.literal("command_result"),
      sessionId,
      message: z.string().max(100_000).optional(),
      data: z.unknown().optional(),
      runtime: runtimeMetadataSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("attached"), id: requestId, attachment: attachmentSchema }).strict(),
  z.object({ type: z.literal("ok"), id: requestId }).strict(),
  z
    .object({ type: z.literal("error"), id: requestId.optional(), message: z.string().max(20_000) })
    .strict(),
]);

export type AgentViewResponse =
  | { type: "hello"; version: 1; pid: number }
  | { type: "snapshot"; records: ManagedSessionRecord[] }
  | { type: "record"; record: ManagedSessionRecord }
  | { type: "removed"; sessionId: string }
  | { type: "event"; sessionId: string; event: AgentEvent }
  | {
      type: "command_result";
      sessionId: string;
      message?: string;
      data?: unknown;
      runtime?: z.infer<typeof runtimeMetadataSchema>;
    }
  | { type: "attached"; id: string; attachment: AgentViewAttachment }
  | { type: "ok"; id: string }
  | { type: "error"; id?: string; message: string };

export function parseAgentViewRequest(line: string): AgentViewRequest {
  if (line.length > MAX_AGENT_VIEW_LINE_CHARS)
    throw new Error("agent-view request exceeds 2,000,000 characters");
  return agentViewRequestSchema.parse(JSON.parse(line) as unknown);
}

export function parseAgentViewResponse(line: string): AgentViewResponse {
  if (line.length > MAX_AGENT_VIEW_LINE_CHARS)
    throw new Error("agent-view response exceeds 2,000,000 characters");
  return agentViewResponseSchema.parse(JSON.parse(line) as unknown) as AgentViewResponse;
}
