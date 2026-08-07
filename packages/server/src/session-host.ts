import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  CommandRegistry,
  PermissionRequest,
  PermissionRule,
  ToolResultContent,
} from "@mu/core";
import {
  type ErrorCode,
  type Op,
  type OpResult,
  type Origin,
  resolvePolicy,
  type SessionState,
  type SessionSummary,
  type SubscriberPolicy,
  sessionStateFrom,
  sourceFor,
  type WorkspaceInfo,
} from "@mu/protocol";
import type { Agent } from "mu";
import { BlobStore } from "./blobs.ts";
import { canSelectMode, rulesForOrigin } from "./permissions.ts";
import { PowerAssertion } from "./power.ts";
import { EventRing, type SeqEvent } from "./ring.ts";
import { Shaper } from "./shaping.ts";

export interface Subscription {
  readonly seq: number;
  close: () => void;
}

export interface SubscriptionSink {
  event: (frame: SeqEvent) => void;
  // Sent when the requested sinceSeq has aged out of the ring.
  gap?: (from: number, to: number) => void;
}

export interface SessionHostOptions {
  agent: Agent;
  workspace: WorkspaceInfo;
  hostId?: string;
  instanceId?: string;
  // Rules the surface configured, before any mode is layered on. Needed so a
  // mode switch replaces the previous mode's rules rather than stacking.
  basePermissions?: PermissionRule[];
  // Layered after the configured rules for remote-originated work (RD8).
  remoteOverlay?: PermissionRule[];
  commands?: CommandRegistry;
  // Persists an "always allow" the way the local surface would.
  rememberPermission?: (permission: string, pattern: string) => void | Promise<void>;
  ringEntries?: number;
  ringBytes?: number;
  // Injected in tests so no real caffeinate/systemd-inhibit is ever spawned.
  power?: PowerAssertion;
}

function errorResult(code: ErrorCode, message: string): OpResult {
  return { ok: false, error: { code, message } };
}

function titleOf(state: SessionState): string | undefined {
  for (const message of state.messages) {
    if (message.role !== "user") continue;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (text.length > 0) return text.split("\n")[0];
  }
  return undefined;
}

// The unit the server serves: one Agent plus the state a second client needs
// but cannot reach — pending asks, the input queue, recent events, and the
// payloads that were budgeted out of its stream.
export class SessionHost {
  readonly id: string;
  readonly instanceId: string;
  readonly agent: Agent;
  readonly workspace: WorkspaceInfo;

  private readonly ring: EventRing;
  private readonly blobs = new BlobStore();
  private readonly subscribers = new Set<{ sink: SubscriptionSink; shaper: Shaper }>();
  private readonly resolvers = new Map<string, (outcome: "allow" | "deny") => void>();
  private readonly unsubscribe: () => void;
  private basePermissions: PermissionRule[];
  private active: Promise<unknown> | undefined;
  private closed = false;
  private restoreRules: PermissionRule[] | undefined;
  private readonly power: PowerAssertion;

  constructor(private readonly options: SessionHostOptions) {
    this.power = options.power ?? new PowerAssertion();
    this.agent = options.agent;
    this.workspace = options.workspace;
    this.id = options.hostId ?? `h_${randomUUID().slice(0, 8)}`;
    this.instanceId = options.instanceId ?? `i_${randomUUID().slice(0, 8)}`;
    this.basePermissions = [...(options.basePermissions ?? this.agent.permissions)];
    this.ring = new EventRing(options.ringEntries, options.ringBytes);
    this.unsubscribe = this.agent.subscribe((event) => this.publish(event));
  }

  get seq(): number {
    return this.ring.seq;
  }

  get isRunning(): boolean {
    return this.active !== undefined || this.agent.isRunning;
  }

  state(): SessionState {
    return sessionStateFrom(this.agent.state(), this.workspace);
  }

  summary(): SessionSummary {
    const state = this.state();
    const title = titleOf(state);
    return {
      id: state.sessionId,
      workspace: {
        name: this.workspace.name,
        ...(this.workspace.branch ? { branch: this.workspace.branch } : {}),
      },
      ...(title ? { title } : {}),
      updatedAt: new Date().toISOString(),
      running: state.running,
      pendingPermissions: state.pendingPermissions.length,
    };
  }

  // An ask that arrived while nobody was attached is still answerable: the
  // resolver lives here, not in whichever surface happened to be open.
  onPermission(request: PermissionRequest): Promise<"allow" | "deny"> {
    return new Promise<"allow" | "deny">((resolve) => {
      this.resolvers.set(request.id, resolve);
    });
  }

  subscribe(policy: SubscriberPolicy, sink: SubscriptionSink, sinceSeq?: number): Subscription {
    const resolved = resolvePolicy(policy);
    const shaper = new Shaper({
      policy: resolved,
      blobs: this.blobs,
      emit: (event) => sink.event({ seq: this.ring.seq, event }),
    });
    const entry = { sink, shaper };
    this.subscribers.add(entry);

    if (sinceSeq !== undefined) {
      const missed = this.ring.since(sinceSeq);
      if (missed === undefined) sink.gap?.(sinceSeq + 1, this.ring.oldestSeq - 1);
      else for (const frame of missed) sink.event(frame);
    }

    return {
      seq: this.ring.seq,
      close: () => {
        shaper.close();
        this.subscribers.delete(entry);
      },
    };
  }

  blob(ref: string): ToolResultContent[] | undefined {
    return this.blobs.get(ref);
  }

  async apply(op: Op, origin: Origin): Promise<OpResult> {
    if (this.closed) return errorResult("internal", "the session has shut down");
    this.audit(op, origin);
    try {
      return await this.dispatch(op, origin);
    } catch (error) {
      return errorResult("internal", error instanceof Error ? error.message : String(error));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [id, resolve] of this.resolvers) {
      resolve("deny");
      this.resolvers.delete(id);
    }
    for (const entry of this.subscribers) entry.shaper.close();
    this.subscribers.clear();
    this.power.release();
    this.unsubscribe();
  }

  // Waits for whatever this host started, so a caller can shut down without
  // cutting an in-flight run short.
  async idle(): Promise<void> {
    await this.active?.catch(() => {});
    await this.agent.waitForIdle();
  }

  private publish(event: AgentEvent): void {
    // Driven off the event stream rather than off `apply`, so a run the local
    // surface started holds the assertion too.
    if (event.type === "agent_start") this.power.acquire();
    if (event.type === "agent_end") this.power.release();
    const frame = this.ring.push(event);
    for (const { shaper } of this.subscribers) shaper.push(frame.event);
  }

  // Every remote op lands in the durable session record, for free.
  private audit(op: Op, origin: Origin): void {
    if (origin.kind !== "remote") return;
    this.agent.session.append({
      type: "custom",
      customType: "remote-op",
      data: { op: op.k, deviceId: origin.deviceId, at: new Date().toISOString() },
    });
  }

  private async dispatch(op: Op, origin: Origin): Promise<OpResult> {
    switch (op.k) {
      case "input":
        return this.startRun(op.text, origin);

      case "steer":
        this.agent.send(op.text, sourceFor(origin));
        return { ok: true };

      case "follow_up":
        this.agent.followUp(op.text, sourceFor(origin));
        return { ok: true };

      case "withdraw_queued":
        return { ok: true, data: { removed: this.agent.removeQueuedMessage(op.kind, op.text) } };

      case "abort":
        this.agent.abort();
        return { ok: true };

      case "permission_reply":
        return this.replyToPermission(op.requestId, op.outcome, op.remember ?? false);

      case "set_permission_mode":
        return this.setPermissionMode(op.modeId, origin);

      case "set_model":
        if (this.isRunning) return errorResult("busy", "Cannot switch models during a run.");
        this.agent.setModel(op.ref);
        return { ok: true, data: { model: this.agent.modelRef } };

      case "set_thinking":
        this.agent.setThinking(op.level);
        return { ok: true, data: { thinkingLevel: this.agent.thinking } };

      case "command":
        return this.runCommand(op.text, origin);

      case "compact":
        return { ok: true, data: await this.agent.compactNow(op.focus) };

      case "undo":
        return { ok: true, data: await this.agent.undo() };

      case "redo":
        return { ok: true, data: await this.agent.redo() };

      case "fork":
        return { ok: true, data: await this.agent.fork(op.entryId) };

      case "fork_points":
        return { ok: true, data: { points: this.agent.forkPoints() } };

      case "session_diff":
        return { ok: true, data: { files: await this.agent.sessionDiff() } };

      case "session_new":
        if (this.isRunning) return errorResult("busy", "Cannot start a new session during a run.");
        this.agent.newSession();
        return { ok: true, data: { sessionId: this.agent.sessionId } };

      case "session_resume": {
        if (this.isRunning) return errorResult("busy", "Cannot resume during a run.");
        const tree = await this.agent.sessionStore.load(op.sessionId);
        if (!tree) return errorResult("unknown_session", `no such session: ${op.sessionId}`);
        this.agent.resume(tree);
        return { ok: true, data: { sessionId: this.agent.sessionId } };
      }

      case "session_list":
        return { ok: true, data: { sessions: await this.agent.sessionStore.list() } };

      case "task_list":
        return { ok: true, data: { tasks: this.state().tasks } };

      case "task_kill":
        return { ok: true, data: { killed: this.agent.killTask(op.taskId) } };

      case "fetch_blob": {
        const content = this.blobs.get(op.ref);
        if (!content) return errorResult("unknown_blob", "no longer available");
        return { ok: true, data: { content } };
      }
    }
  }

  private startRun(text: string, origin: Origin): OpResult {
    if (this.isRunning) {
      return errorResult("busy", "a run is already active; use steer or wait for it");
    }
    const restore = this.applyOriginPermissions(origin);
    const source = sourceFor(origin);
    const task = this.agent
      .run(text, source ? { source } : undefined)
      .catch(() => {})
      .finally(() => {
        restore();
        if (this.active === task) this.active = undefined;
      });
    this.active = task;
    return { ok: true, data: { started: true } };
  }

  // A remote-originated run is gated by the narrowed ruleset for its duration.
  // Only one run is ever in flight, so this cannot race another origin's.
  private applyOriginPermissions(origin: Origin): () => void {
    if (origin.kind === "local") return () => {};
    // Held as state, not captured: an "always allow" answered during the run
    // has to survive the restore, or approving from a phone would silently
    // forget itself the moment the turn ended.
    this.restoreRules = this.agent.permissions;
    this.agent.setPermissions(
      rulesForOrigin(origin, this.agent.permissions, this.options.remoteOverlay),
    );
    return () => {
      if (this.restoreRules) this.agent.setPermissions(this.restoreRules);
      this.restoreRules = undefined;
    };
  }

  private replyToPermission(
    requestId: string,
    outcome: "allow" | "deny",
    remember: boolean,
  ): OpResult {
    const resolve = this.resolvers.get(requestId);
    if (!resolve) return errorResult("unknown_request", `unknown permission request: ${requestId}`);
    const request = this.agent.pendingPermissions.find((pending) => pending.id === requestId);
    this.resolvers.delete(requestId);
    // "Always allow" writes the same explicit rule it would locally — a phone
    // never gets to broaden silently.
    if (outcome === "allow" && remember && request) {
      const rule: PermissionRule = {
        permission: request.permission,
        pattern: request.pattern,
        action: "allow",
      };
      this.basePermissions.push(rule);
      this.restoreRules?.push(rule);
      this.agent.addPermissionRule(rule);
      void Promise.resolve(this.options.rememberPermission?.(rule.permission, rule.pattern)).catch(
        () => {},
      );
    }
    resolve(outcome);
    return { ok: true, data: { resolved: true } };
  }

  private setPermissionMode(modeId: string, origin: Origin): OpResult {
    const mode = this.agent.permissionModes.find((candidate) => candidate.id === modeId);
    if (!mode) return errorResult("unsupported", `unknown permission mode: ${modeId}`);
    if (!canSelectMode(origin, this.agent.permissionMode, mode)) {
      return errorResult("not_permitted", `a remote origin cannot select "${mode.label}"`);
    }
    this.agent.setPermissions([...this.basePermissions, ...mode.rules]);
    this.agent.setPermissionMode(mode);
    return { ok: true, data: { modeId: mode.id } };
  }

  private async runCommand(text: string, origin: Origin): Promise<OpResult> {
    const registry = this.options.commands;
    if (!registry) return errorResult("unsupported", "this host runs no commands");
    const result = await registry.execute(text, {
      inject: (message) => {
        if (message.role === "custom" && message.content[0]?.type === "text") {
          this.agent.followUp(message.content[0].text, sourceFor(origin));
        }
      },
      print: () => {},
      getModel: () => this.agent.modelRef,
      setModel: (ref) => this.agent.setModel(ref),
    });
    return {
      ok: true,
      data: {
        handled: result.handled,
        ...(result.message !== undefined ? { message: result.message } : {}),
        ...(result.data !== undefined ? { data: result.data } : {}),
      },
    };
  }
}
