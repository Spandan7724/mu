import { z } from "zod";
import type { ClientFrame, ServerFrame } from "./frames.ts";
import type { Op } from "./ops.ts";
import type { SubscriberPolicy } from "./policy.ts";
import type { SessionState } from "./state.ts";

// `AgentEvent` and `AgentMessage` cross the wire verbatim (RD4). Re-declaring
// those unions here would create a second source of truth that drifts from the
// kernel's the moment a member is added, so the boundary checks only that they
// are objects carrying their discriminator and passes the rest through intact.
const agentEventSchema = z.looseObject({ type: z.string() });
const agentMessageSchema = z.looseObject({ role: z.string() });

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number().optional(),
});

const permissionRequestSchema = z.looseObject({
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  permission: z.string(),
  pattern: z.string(),
  description: z.string(),
});

const workspaceSchema = z.object({
  name: z.string(),
  root: z.string(),
  branch: z.string().optional(),
});

export const subscriberPolicySchema = z.object({
  updates: z.enum(["full", "coalesced", "none"]),
  updateHz: z.number().optional(),
  maxInlineBytes: z.number().optional(),
  taskOutput: z.boolean().optional(),
  images: z.enum(["inline", "stub"]).optional(),
});

export const sessionStateSchema = z.object({
  sessionId: z.string(),
  profile: z.string(),
  workspace: workspaceSchema,
  model: z.string(),
  thinkingLevel: z.string(),
  thinkingLevels: z.array(z.string()),
  permissionMode: z
    .object({
      id: z.string(),
      label: z.string(),
      tone: z.enum(["restrictive", "permissive", "unrestricted"]).optional(),
    })
    .optional(),
  running: z.boolean(),
  compacting: z.boolean(),
  usage: usageSchema,
  contextTokens: z.number(),
  contextPercent: z.number(),
  messages: z.array(agentMessageSchema),
  pendingPermissions: z.array(permissionRequestSchema),
  queuedInputs: z.array(z.object({ kind: z.enum(["steer", "follow-up"]), text: z.string() })),
  tasks: z.array(z.object({ taskId: z.string(), command: z.string(), running: z.boolean() })),
});

export const opSchema = z.discriminatedUnion("k", [
  z.object({ k: z.literal("input"), text: z.string() }),
  z.object({ k: z.literal("steer"), text: z.string() }),
  z.object({ k: z.literal("follow_up"), text: z.string() }),
  z.object({
    k: z.literal("withdraw_queued"),
    kind: z.enum(["steer", "follow-up"]),
    text: z.string(),
  }),
  z.object({ k: z.literal("abort") }),
  z.object({
    k: z.literal("permission_reply"),
    requestId: z.string(),
    outcome: z.enum(["allow", "deny"]),
    remember: z.boolean().optional(),
  }),
  z.object({ k: z.literal("set_permission_mode"), modeId: z.string() }),
  z.object({ k: z.literal("set_model"), ref: z.string() }),
  z.object({ k: z.literal("set_thinking"), level: z.string() }),
  z.object({ k: z.literal("command"), text: z.string() }),
  z.object({ k: z.literal("compact"), focus: z.string().optional() }),
  z.object({ k: z.literal("undo") }),
  z.object({ k: z.literal("redo") }),
  z.object({ k: z.literal("fork"), entryId: z.string() }),
  z.object({ k: z.literal("fork_points") }),
  z.object({ k: z.literal("session_diff") }),
  z.object({ k: z.literal("session_new") }),
  z.object({ k: z.literal("session_resume"), sessionId: z.string() }),
  z.object({ k: z.literal("session_list") }),
  z.object({ k: z.literal("task_list") }),
  z.object({ k: z.literal("task_kill"), taskId: z.string() }),
  z.object({ k: z.literal("fetch_blob"), ref: z.string() }),
]);

export const errorCodeSchema = z.enum([
  "unknown_session",
  "unknown_request",
  "unknown_blob",
  "busy",
  "not_permitted",
  "unsupported",
  "internal",
]);

export const hostInfoSchema = z.object({
  hostId: z.string(),
  instanceId: z.string(),
  name: z.string(),
  version: z.string(),
  workspace: workspaceSchema,
});

export const sessionSummarySchema = z.object({
  id: z.string(),
  workspace: z.object({ name: z.string(), branch: z.string().optional() }),
  title: z.string().optional(),
  updatedAt: z.string(),
  running: z.boolean(),
  pendingPermissions: z.number(),
});

export const clientFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("attach"),
    session: z.string(),
    policy: subscriberPolicySchema,
    sinceSeq: z.number().optional(),
  }),
  z.object({ t: z.literal("detach"), session: z.string() }),
  z.object({
    t: z.literal("op"),
    id: z.string(),
    session: z.string().optional(),
    op: opSchema,
  }),
]);

// `reply` is two shapes sharing one `t`, so it discriminates on `ok` and joins
// the rest as a plain union.
const replyFrameSchema = z.discriminatedUnion("ok", [
  z.object({
    t: z.literal("reply"),
    id: z.string(),
    ok: z.literal(true),
    data: z.unknown().optional(),
  }),
  z.object({
    t: z.literal("reply"),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ code: errorCodeSchema, message: z.string() }),
  }),
]);

export const serverFrameSchema = z.union([
  z.discriminatedUnion("t", [
    z.object({ t: z.literal("hello"), protocol: z.number(), host: hostInfoSchema }),
    z.object({ t: z.literal("sessions"), sessions: z.array(sessionSummarySchema) }),
    z.object({
      t: z.literal("state"),
      session: z.string(),
      seq: z.number(),
      state: sessionStateSchema,
    }),
    z.object({
      t: z.literal("event"),
      session: z.string(),
      seq: z.number(),
      event: agentEventSchema,
    }),
    z.object({ t: z.literal("gap"), session: z.string(), from: z.number(), to: z.number() }),
    z.object({ t: z.literal("bye"), reason: z.enum(["revoked", "shutdown", "protocol"]) }),
  ]),
  replyFrameSchema,
]);

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function parseWith<T>(schema: z.ZodType, value: unknown): ParseResult<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data as T };
  const first = result.error.issues[0];
  return {
    ok: false,
    message: first ? `${first.path.join(".") || "frame"}: ${first.message}` : "invalid frame",
  };
}

// The only entry point for anything arriving from a peer. Every path that turns
// bytes into a frame goes through here.
export function parseClientFrame(value: unknown): ParseResult<ClientFrame> {
  return parseWith<ClientFrame>(clientFrameSchema, value);
}

export function parseServerFrame(value: unknown): ParseResult<ServerFrame> {
  return parseWith<ServerFrame>(serverFrameSchema, value);
}

export function parseOp(value: unknown): ParseResult<Op> {
  return parseWith<Op>(opSchema, value);
}

export function parseSessionState(value: unknown): ParseResult<SessionState> {
  return parseWith<SessionState>(sessionStateSchema, value);
}

export function parseSubscriberPolicy(value: unknown): ParseResult<SubscriberPolicy> {
  return parseWith<SubscriberPolicy>(subscriberPolicySchema, value);
}

export function decodeClientFrame(line: string): ParseResult<ClientFrame> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return parseClientFrame(parsed);
}

export function decodeServerFrame(line: string): ParseResult<ServerFrame> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return parseServerFrame(parsed);
}
