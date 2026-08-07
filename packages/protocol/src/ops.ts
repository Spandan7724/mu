// The complete op vocabulary, derived by auditing every direct `agent.*` call
// the interactive surface makes. Nothing here is new capability: an op with no
// Agent method behind it means the SDK is missing something, and that is where
// it belongs (RD4).
export type Op =
  // conversation
  | { k: "input"; text: string }
  | { k: "steer"; text: string }
  | { k: "follow_up"; text: string }
  | { k: "withdraw_queued"; kind: "steer" | "follow-up"; text: string }
  | { k: "abort" }

  // permissions
  | { k: "permission_reply"; requestId: string; outcome: "allow" | "deny"; remember?: boolean }
  | { k: "set_permission_mode"; modeId: string }

  // settings
  | { k: "set_model"; ref: string }
  | { k: "set_thinking"; level: string }

  // session operations
  | { k: "command"; text: string }
  | { k: "compact"; focus?: string }
  | { k: "undo" }
  | { k: "redo" }
  | { k: "fork"; entryId: string }
  | { k: "fork_points" }
  | { k: "session_diff" }
  | { k: "session_new" }
  | { k: "session_resume"; sessionId: string }
  | { k: "session_list" }

  // background tasks
  | { k: "task_list" }
  | { k: "task_kill"; taskId: string }

  // payload retrieval
  | { k: "fetch_blob"; ref: string };

export type OpKind = Op["k"];

export type ErrorCode =
  | "unknown_session"
  | "unknown_request"
  | "unknown_blob"
  // a run is active and this op requires idle
  | "busy"
  // origin may not perform this op
  | "not_permitted"
  // op unknown to this protocol version
  | "unsupported"
  | "internal";

// Assigned by the host from the authenticated connection, never trusted from
// the client (PROTOCOL.md §7).
export type Origin = { kind: "local" } | { kind: "remote"; deviceId: string; deviceName: string };

export type OpResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: { code: ErrorCode; message: string } };

// What UserMessage.source is set to for a message this origin produced.
export function sourceFor(origin: Origin): string | undefined {
  return origin.kind === "remote" ? `remote:${origin.deviceName}` : undefined;
}
