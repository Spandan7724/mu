import { describe, expect, test } from "bun:test";
import type { AgentEvent, PermissionRequest } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent, type AgentState } from "mu";
import type { ClientFrame, ServerFrame } from "./frames.ts";
import { encodeFrame } from "./frames.ts";
import type { Op, OpKind } from "./ops.ts";
import { sourceFor } from "./ops.ts";
import { FULL_FIDELITY, MAX_UPDATE_HZ, MIN_UPDATE_HZ, resolvePolicy } from "./policy.ts";
import {
  decodeClientFrame,
  decodeServerFrame,
  parseClientFrame,
  parseOp,
  parseServerFrame,
  parseSessionState,
} from "./schema.ts";
import { sessionStateFrom } from "./state.ts";
import { PROTOCOL_VERSION } from "./version.ts";

// Keyed by kind, so a new op that has no sample here fails to compile rather
// than quietly going untested.
const OPS: Record<OpKind, Op> = {
  input: { k: "input", text: "add a test" },
  steer: { k: "steer", text: "not that file" },
  follow_up: { k: "follow_up", text: "then run it" },
  withdraw_queued: { k: "withdraw_queued", kind: "steer", text: "not that file" },
  abort: { k: "abort" },
  permission_reply: {
    k: "permission_reply",
    requestId: "p1",
    outcome: "allow",
    remember: true,
  },
  set_permission_mode: { k: "set_permission_mode", modeId: "strict" },
  set_model: { k: "set_model", ref: "fake/fake-1" },
  set_thinking: { k: "set_thinking", level: "high" },
  command: { k: "command", text: "/diff" },
  compact: { k: "compact", focus: "the migration" },
  undo: { k: "undo" },
  redo: { k: "redo" },
  fork: { k: "fork", entryId: "e1" },
  fork_points: { k: "fork_points" },
  session_diff: { k: "session_diff" },
  session_new: { k: "session_new" },
  session_resume: { k: "session_resume", sessionId: "s1" },
  session_list: { k: "session_list" },
  task_list: { k: "task_list" },
  task_kill: { k: "task_kill", taskId: "task_1" },
  fetch_blob: { k: "fetch_blob", ref: "b_1" },
};

const permissionRequest: PermissionRequest = {
  id: "p1",
  toolCallId: "c1",
  toolName: "bash",
  permission: "bash",
  pattern: "rm -rf build",
  description: "Run rm -rf build",
  preview: { kind: "text", lines: ["rm -rf build"] },
};

const state = sessionStateFrom(
  {
    sessionId: "s1",
    profile: "coding",
    environment: { root: "/home/x/app", branch: "main" },
    model: "fake/fake-1",
    thinkingLevel: "medium",
    thinkingLevels: ["off", "medium", "high"],
    permissionMode: {
      id: "strict",
      label: "strict",
      description: "ask for everything",
      tone: "restrictive",
      rules: [{ permission: "*", pattern: "*", action: "ask" }],
    },
    permissionModes: [],
    running: true,
    compacting: false,
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    },
    contextTokens: 1200,
    contextPercent: 3,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
    pendingPermissions: [permissionRequest],
    queuedInputs: [{ kind: "steer", text: "wait" }],
    tasks: [
      {
        id: "task_1",
        command: "bun test",
        status: "running",
        exitCode: null,
        startedAt: 0,
        outputBytes: 0,
        truncated: false,
        detached: false,
      },
    ],
  },
  { name: "app", root: "/home/x/app", branch: "main" },
);

const SERVER_FRAMES: Record<ServerFrame["t"] | "reply_error", ServerFrame> = {
  hello: {
    t: "hello",
    protocol: PROTOCOL_VERSION,
    host: {
      hostId: "h1",
      instanceId: "i1",
      name: "workstation",
      version: "0.0.4",
      workspace: { name: "app", root: "/home/x/app", branch: "main" },
    },
  },
  sessions: {
    t: "sessions",
    sessions: [
      {
        id: "s1",
        workspace: { name: "app", branch: "main" },
        title: "add a test",
        updatedAt: new Date(0).toISOString(),
        running: true,
        pendingPermissions: 1,
      },
    ],
  },
  state: { t: "state", session: "s1", seq: 12, state },
  event: {
    t: "event",
    session: "s1",
    seq: 13,
    event: { type: "permission_asked", request: permissionRequest },
  },
  gap: { t: "gap", session: "s1", from: 4, to: 12 },
  reply: { t: "reply", id: "r1", ok: true, data: { queued: true } },
  reply_error: {
    t: "reply",
    id: "r2",
    ok: false,
    error: { code: "unknown_session", message: "no such session" },
  },
  bye: { t: "bye", reason: "protocol" },
};

const CLIENT_FRAMES: Record<ClientFrame["t"], ClientFrame> = {
  attach: {
    t: "attach",
    session: "s1",
    policy: { updates: "coalesced", updateHz: 8, maxInlineBytes: 16_384, images: "stub" },
    sinceSeq: 11,
  },
  detach: { t: "detach", session: "s1" },
  op: { t: "op", id: "o1", session: "s1", op: { k: "steer", text: "stop" } },
};

describe("ops", () => {
  test("every op JSON-serializes and validates against its schema", () => {
    for (const [kind, op] of Object.entries(OPS)) {
      const parsed = parseOp(JSON.parse(JSON.stringify(op)));
      expect(parsed.ok ? parsed.value : parsed.message).toEqual(op);
      expect(kind).toBe(op.k);
    }
  });

  test("an op unknown to this version is refused, not passed through", () => {
    const parsed = parseOp({ k: "read_file", path: "/etc/passwd" });
    expect(parsed.ok).toBe(false);
  });

  test("no op names a filesystem location", () => {
    const fields = Object.values(OPS).flatMap((op) => Object.keys(op));
    for (const field of fields) {
      expect(["path", "file", "dir", "directory", "cwd", "root"]).not.toContain(field);
    }
  });

  test("origin decides provenance; a local origin leaves the message unmarked", () => {
    expect(sourceFor({ kind: "local" })).toBeUndefined();
    expect(sourceFor({ kind: "remote", deviceId: "d1", deviceName: "pixel" })).toBe("remote:pixel");
  });
});

describe("frames", () => {
  test("every server frame round-trips through JSON and validates", () => {
    for (const frame of Object.values(SERVER_FRAMES)) {
      const decoded = decodeServerFrame(encodeFrame(frame));
      expect(decoded.ok ? decoded.value : decoded.message).toEqual(frame);
    }
  });

  test("every client frame round-trips through JSON and validates", () => {
    for (const frame of Object.values(CLIENT_FRAMES)) {
      const decoded = decodeClientFrame(encodeFrame(frame));
      expect(decoded.ok ? decoded.value : decoded.message).toEqual(frame);
    }
  });

  test("malformed input is refused with a message rather than thrown", () => {
    expect(decodeClientFrame("{not json").ok).toBe(false);
    expect(parseClientFrame({ t: "attach" }).ok).toBe(false);
    expect(parseClientFrame(null).ok).toBe(false);
    expect(parseServerFrame({ t: "hello", protocol: "one" }).ok).toBe(false);
  });

  test("an event crosses the wire verbatim, whatever member it is", () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "usage_updated", sessionTotals: state.usage, contextTokens: 1, contextPercent: 0 },
      { type: "task_output", taskId: "task_1", chunk: "line\n" },
      { type: "permission_resolved", requestId: "p1", outcome: "deny" },
    ];
    for (const event of events) {
      const frame: ServerFrame = { t: "event", session: "s1", seq: 1, event };
      const decoded = decodeServerFrame(encodeFrame(frame));
      expect(decoded.ok && decoded.value).toEqual(frame);
    }
  });
});

describe("SessionState", () => {
  test("validates and survives a JSON round trip", () => {
    const parsed = parseSessionState(JSON.parse(JSON.stringify(state)));
    expect(parsed.ok ? parsed.value : parsed.message).toEqual(state);
  });

  test("projects tasks and drops a mode's rules", () => {
    expect(state.tasks).toEqual([{ taskId: "task_1", command: "bun test", running: true }]);
    expect(state.permissionMode).toEqual({ id: "strict", label: "strict", tone: "restrictive" });
  });

  test("is assembled from a real Agent snapshot", () => {
    const agent = new Agent({
      provider: new FakeProvider([]),
      model: fakeModel,
      sessionId: "s-live",
    });
    const snapshot: AgentState = agent.state();
    const projected = sessionStateFrom(snapshot, { name: "app", root: "/home/x/app" });

    expect(projected.sessionId).toBe("s-live");
    expect(projected.workspace).toEqual({ name: "app", root: "/home/x/app" });
    expect(parseSessionState(JSON.parse(JSON.stringify(projected))).ok).toBe(true);
  });
});

describe("subscriber policy", () => {
  test("clamps updateHz and fills the remote-safe defaults", () => {
    expect(resolvePolicy({ updates: "coalesced" })).toEqual({
      updates: "coalesced",
      updateHz: 8,
      maxInlineBytes: 16_384,
      taskOutput: false,
      images: "stub",
    });
    expect(resolvePolicy({ updates: "coalesced", updateHz: 0 }).updateHz).toBe(MIN_UPDATE_HZ);
    expect(resolvePolicy({ updates: "coalesced", updateHz: 500 }).updateHz).toBe(MAX_UPDATE_HZ);
  });

  test("full fidelity budgets nothing away", () => {
    const resolved = resolvePolicy(FULL_FIDELITY);
    expect(resolved.updates).toBe("full");
    expect(resolved.images).toBe("inline");
    expect(resolved.taskOutput).toBe(true);
  });
});

describe("versioning", () => {
  test("is a single integer", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  });
});
