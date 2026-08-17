import { connect, type Socket } from "node:net";
import type { AgentEvent } from "mu";
import { currentExecutableCommand } from "./agent-supervisor.ts";
import {
  type AgentViewAttachment,
  type AgentViewRequest,
  type AgentViewResponse,
  MAX_AGENT_VIEW_LINE_CHARS,
  parseAgentViewResponse,
} from "./agent-view-protocol.ts";
import { AGENT_VIEW_PROTOCOL_VERSION, type ManagedSessionRecord } from "./agent-view-state.ts";
import { type AgentViewPaths, agentViewPaths } from "./agent-view-store.ts";

type ResponseListener = (response: AgentViewResponse) => void;

export interface AgentViewClientOptions {
  paths?: AgentViewPaths;
  scope: string;
  cwd: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openSocket(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

export async function ensureAgentSupervisor(paths = agentViewPaths()): Promise<void> {
  try {
    const socket = await openSocket(paths.endpoint);
    socket.destroy();
    return;
  } catch {}

  const child = Bun.spawn(currentExecutableCommand(["__agents-supervisor"]), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
    detached: true,
  });
  child.unref();
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const socket = await openSocket(paths.endpoint);
      socket.destroy();
      return;
    } catch (error) {
      lastError = error;
      if (await Promise.race([child.exited.then(() => true), delay(25).then(() => false)])) break;
    }
  }
  throw new Error(
    `agent supervisor did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export class AgentViewClient {
  private socket: Socket | undefined;
  private buffer = "";
  private listeners = new Set<ResponseListener>();
  private pending = new Map<
    string,
    {
      resolve: (response: AgentViewResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private helloPromise: Promise<void> | undefined;
  private helloResolve: (() => void) | undefined;
  private helloReject: ((error: Error) => void) | undefined;
  private helloReceived = false;
  private snapshotReceived = false;
  records: ManagedSessionRecord[] = [];

  constructor(private options: AgentViewClientOptions) {}

  async connect(startSupervisor = true): Promise<void> {
    const paths = this.options.paths ?? agentViewPaths();
    if (startSupervisor) await ensureAgentSupervisor(paths);
    this.socket = await openSocket(paths.endpoint);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.consume(chunk));
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () => this.fail(new Error("agent supervisor disconnected")));
    this.helloReceived = false;
    this.snapshotReceived = false;
    this.helloPromise = new Promise<void>((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });
    this.send({
      type: "hello",
      id: crypto.randomUUID(),
      version: AGENT_VIEW_PROTOCOL_VERSION,
      scope: this.options.scope,
      cwd: this.options.cwd,
    });
    await this.helloPromise;
  }

  subscribe(listener: ResponseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(): Promise<void> {
    await this.request({ type: "list", id: crypto.randomUUID() });
  }

  async dispatch(options: {
    prompt: string;
    cwd: string;
    profile: string;
    model?: string;
    permissionMode?: string;
    noInstructions?: boolean;
    environment?: Record<string, string>;
  }): Promise<void> {
    await this.request({
      type: "dispatch",
      id: crypto.randomUUID(),
      prompt: options.prompt,
      cwd: options.cwd,
      profile: options.profile,
      ...(options.model ? { model: options.model } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options.noInstructions ? { noInstructions: true } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });
  }

  async attach(sessionId: string): Promise<AgentViewAttachment> {
    const response = await this.request({ type: "attach", id: crypto.randomUUID(), sessionId });
    if (response.type !== "attached") throw new Error("supervisor returned no attachment snapshot");
    return response.attachment;
  }

  async detach(sessionId: string): Promise<void> {
    await this.request({ type: "detach", id: crypto.randomUUID(), sessionId });
  }

  async sessionOp(
    sessionId: string,
    op:
      | { type: "input" | "steer" | "follow_up" | "command"; text: string }
      | { type: "shell"; command: string }
      | { type: "remove_queued"; kind: "steer" | "follow-up"; text: string }
      | { type: "cycle_permission_mode" }
      | { type: "permission_mode"; id: string }
      | {
          type: "permission_reply";
          requestId: string;
          outcome: "allow" | "deny";
          remember?: boolean | undefined;
        }
      | { type: "abort" }
      | { type: "thinking"; level: string },
  ): Promise<void> {
    await this.request({ type: "session_op", id: crypto.randomUUID(), sessionId, op });
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request({ type: "resize", id: crypto.randomUUID(), sessionId, cols, rows });
  }

  async stop(sessionId: string): Promise<void> {
    await this.request({ type: "stop", id: crypto.randomUUID(), sessionId });
  }

  async remove(sessionId: string): Promise<void> {
    await this.request({ type: "remove", id: crypto.randomUUID(), sessionId });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private request(request: AgentViewRequest): Promise<AgentViewResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`agent supervisor did not answer ${request.type} within 20s`));
      }, 20_000);
      this.pending.set(request.id, { resolve, reject, timer });
      this.send(request);
    });
  }

  private send(request: AgentViewRequest): void {
    if (!this.socket || this.socket.destroyed) throw new Error("agent supervisor is not connected");
    this.socket.write(`${JSON.stringify(request)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_AGENT_VIEW_LINE_CHARS && !this.buffer.includes("\n")) {
      this.fail(new Error("agent supervisor sent an oversized response"));
      this.socket?.destroy();
      return;
    }
    let end = this.buffer.indexOf("\n");
    while (end !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.trim()) {
        try {
          this.handle(parseAgentViewResponse(line));
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          this.socket?.destroy();
          return;
        }
      }
      end = this.buffer.indexOf("\n");
    }
  }

  private handle(response: AgentViewResponse): void {
    if (response.type === "hello") this.helloReceived = true;
    if (response.type === "snapshot") {
      this.records = response.records;
      this.snapshotReceived = true;
    }
    if (this.helloReceived && this.snapshotReceived) this.helloResolve?.();
    if (response.type === "record") {
      const next = this.records.filter((record) => record.sessionId !== response.record.sessionId);
      next.push(response.record);
      this.records = next.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    if (response.type === "removed") {
      this.records = this.records.filter((record) => record.sessionId !== response.sessionId);
    }
    if ("id" in response && response.id) {
      const pending = this.pending.get(response.id);
      if (pending) {
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.type === "error") pending.reject(new Error(response.message));
        else pending.resolve(response);
      }
    }
    for (const listener of this.listeners) listener(response);
  }

  private fail(error: Error): void {
    this.helloReject?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export type ManagedAgentEvent = { sessionId: string; event: AgentEvent };
