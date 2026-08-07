import type { AgentEvent } from "@mu/core";
import type { ErrorCode, Op } from "./ops.ts";
import type { SubscriberPolicy } from "./policy.ts";
import type { SessionState, WorkspaceInfo } from "./state.ts";

export interface HostInfo {
  hostId: string;
  instanceId: string;
  // Resolved post-handshake only: an advertisement carries neither (RD9).
  name: string;
  version: string;
  workspace: WorkspaceInfo;
}

export interface SessionSummary {
  id: string;
  workspace: { name: string; branch?: string };
  title?: string;
  updatedAt: string;
  running: boolean;
  pendingPermissions: number;
}

export type ByeReason = "revoked" | "shutdown" | "protocol";

export type ServerFrame =
  | { t: "hello"; protocol: number; host: HostInfo }
  | { t: "sessions"; sessions: SessionSummary[] }
  | { t: "state"; session: string; seq: number; state: SessionState }
  | { t: "event"; session: string; seq: number; event: AgentEvent }
  // Not an error: the normal outcome of a phone backgrounded for an hour.
  | { t: "gap"; session: string; from: number; to: number }
  | { t: "reply"; id: string; ok: true; data?: unknown }
  | { t: "reply"; id: string; ok: false; error: { code: ErrorCode; message: string } }
  | { t: "bye"; reason: ByeReason };

export type ClientFrame =
  | { t: "attach"; session: string; policy: SubscriberPolicy; sinceSeq?: number }
  | { t: "detach"; session: string }
  | { t: "op"; id: string; session?: string; op: Op };

export function encodeFrame(frame: ServerFrame | ClientFrame): string {
  return JSON.stringify(frame);
}
