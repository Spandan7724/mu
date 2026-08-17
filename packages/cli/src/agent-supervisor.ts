import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { terminateProcessTree } from "@mu/profile-coding";
import type { AgentEvent, AgentMessage, PermissionRequest, Usage } from "mu";
import { z } from "zod";
import {
  type AgentViewAttachment,
  type AgentViewRequest,
  type AgentViewResponse,
  agentEventSchema,
  attachmentSchema,
  MANAGED_ENVIRONMENT_KEYS,
  MANAGED_PROFILE_ENV_PREFIX,
  MAX_AGENT_VIEW_LINE_CHARS,
  parseAgentViewRequest,
  runtimeMetadataSchema,
} from "./agent-view-protocol.ts";
import {
  createManagedSessionRecord,
  displaySummary,
  MAX_AGENT_VIEW_ERROR_CHARS,
  type ManagedSessionRecord,
  reduceManagedSession,
} from "./agent-view-state.ts";
import {
  type AgentViewPaths,
  AgentViewRosterStore,
  acquireSessionOwnership,
  agentViewPaths,
  atomicPrivateWrite,
  isProcessAlive,
  projectScope,
  releaseSessionOwnership,
  type SessionOwnership,
  updateSessionOwnershipWorker,
} from "./agent-view-store.ts";
import type { ParsedArgs } from "./args.ts";

interface WorkerSnapshot {
  sessionId: string;
  messages: AgentMessage[];
  model: string;
  contextWindow: number;
  thinking: string;
  thinkingLevels: string[];
  usage: Usage;
  contextPercent: number;
  isRunning: boolean;
  commands?: { label: string; description?: string }[];
}

type WorkerLifecycle = "starting" | "ready" | "evicting" | "stopping";

interface WorkerRuntime {
  process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  ownership: SessionOwnership;
  snapshot?: WorkerSnapshot;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  lifecycle: WorkerLifecycle;
  pendingOperations: Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  exitHandled?: Promise<void>;
  startupTimer?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  termination?: Promise<void>;
  gracefulTerminationAttempted?: boolean;
  forceTerminationAttempted?: boolean;
  exitFinalization?: Promise<void>;
}

interface ClientConnection {
  id: string;
  socket: Socket;
  scope: string | undefined;
  attachment: string | undefined;
}

interface SupervisorOptions {
  paths?: AgentViewPaths;
  command?: (args: string[]) => string[];
  spawn?: typeof Bun.spawn;
  now?: () => number;
  completedIdleMs?: number;
  workerStartupMs?: number;
  forceStopMs?: number;
  terminateProcess?: (
    process: Parameters<typeof terminateProcessTree>[0],
    signal: NodeJS.Signals,
  ) => Promise<void>;
}

export const DEFAULT_COMPLETED_RUNTIME_IDLE_MS = 10 * 60 * 1_000;
const WORKER_OPERATION_TIMEOUT_MS = 20_000;
const SERVER_CLOSE_GRACE_MS = 500;

const workerOutSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      ownershipToken: z.string().uuid(),
      sessionId: z.string().min(1).max(512),
      model: z.string().min(1).max(512),
      contextWindow: z.number().int().nonnegative(),
      thinking: z.string().max(128),
      thinkingLevels: z.array(z.string().max(128)).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("snapshot"),
      ownershipToken: z.string().uuid(),
      snapshot: attachmentSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("event"),
      ownershipToken: z.string().uuid(),
      event: agentEventSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      ownershipToken: z.string().uuid(),
      message: z.string().max(20_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("command_result"),
      ownershipToken: z.string().uuid(),
      message: z.string().max(100_000).optional(),
      data: z.unknown().optional(),
      runtime: runtimeMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("op_result"),
      ownershipToken: z.string().uuid(),
      operationId: z.string().min(1).max(128),
      ok: z.boolean(),
      message: z.string().max(20_000).optional(),
    })
    .strict(),
  z.object({ type: z.literal("shutdown"), ownershipToken: z.string().uuid() }).strict(),
]);

export function currentExecutableCommand(args: string[]): string[] {
  const entry = process.argv[1];
  if (entry && !entry.startsWith("/$bunfs/") && /\.[cm]?[jt]s$/.test(entry)) {
    return [process.execPath, entry, ...args];
  }
  return [process.execPath, ...args];
}

function write(socket: Socket, response: AgentViewResponse): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

function workerWrite(runtime: WorkerRuntime, value: unknown): void {
  runtime.process.stdin.write(
    `${JSON.stringify({ ...(value as Record<string, unknown>), ownershipToken: runtime.ownership.token })}\n`,
  );
  runtime.process.stdin.flush();
}

function requestWorkerShutdown(runtime: WorkerRuntime): void {
  try {
    workerWrite(runtime, { type: "shutdown" });
  } catch {
    // The worker may have closed stdin before Bun publishes its exit code.
  }
}

async function waitForProcessExit(
  process: Pick<Bun.Subprocess, "exitCode" | "exited">,
  timeoutMs: number,
): Promise<boolean> {
  if (process.exitCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForCompletion(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function* streamLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n");
    while (end !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.length > MAX_AGENT_VIEW_LINE_CHARS)
        throw new Error("worker output exceeded the line limit");
      if (line.trim()) yield line;
      end = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_AGENT_VIEW_LINE_CHARS)
      throw new Error("worker output exceeded the line limit");
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

export class AgentSupervisor {
  readonly paths: AgentViewPaths;
  private readonly rosterStore: AgentViewRosterStore;
  private readonly records = new Map<string, ManagedSessionRecord>();
  private readonly runtimes = new Map<string, WorkerRuntime>();
  private readonly runtimeTransitions = new Map<string, Promise<WorkerRuntime>>();
  private readonly exitHandlers = new Set<Promise<void>>();
  private readonly clients = new Set<ClientConnection>();
  private saveChain = Promise.resolve();
  private server = createServer((socket) => this.accept(socket));
  private readonly command: (args: string[]) => string[];
  private readonly spawnProcess: typeof Bun.spawn;
  private readonly now: () => number;
  private readonly completedIdleMs: number;
  private readonly workerStartupMs: number;
  private readonly forceStopMs: number;
  private readonly terminateProcess: NonNullable<SupervisorOptions["terminateProcess"]>;
  private ownsLock = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: SupervisorOptions = {}) {
    this.paths = options.paths ?? agentViewPaths();
    this.rosterStore = new AgentViewRosterStore(this.paths);
    this.command = options.command ?? currentExecutableCommand;
    this.spawnProcess = options.spawn ?? Bun.spawn;
    this.now = options.now ?? Date.now;
    this.completedIdleMs = options.completedIdleMs ?? DEFAULT_COMPLETED_RUNTIME_IDLE_MS;
    this.workerStartupMs = options.workerStartupMs ?? 15_000;
    this.forceStopMs = options.forceStopMs ?? 5_000;
    this.terminateProcess = options.terminateProcess ?? terminateProcessTree;
  }

  async start(): Promise<void> {
    await this.rosterStore.initialize();
    await this.acquireSupervisorLock();
    try {
      let reconciled = false;
      for (const record of await this.rosterStore.load()) {
        if (["starting", "working", "needs_input"].includes(record.state)) {
          this.records.set(
            record.sessionId,
            reduceManagedSession(
              record,
              {
                type: "worker_failed",
                message:
                  "supervisor restarted during active work · resume from the last committed turn",
              },
              this.now(),
            ),
          );
          reconciled = true;
        } else {
          this.records.set(record.sessionId, record);
        }
      }
      if (reconciled) await this.rosterStore.save([...this.records.values()]);
      if (process.platform !== "win32") await rm(this.paths.endpoint, { force: true });
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.paths.endpoint, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
      if (process.platform !== "win32") await chmod(this.paths.endpoint, 0o600);
      await atomicPrivateWrite(
        this.paths.supervisor,
        `${JSON.stringify({ version: 1, pid: process.pid, endpoint: this.paths.endpoint, startedAt: this.now() })}\n`,
      );
    } catch (error) {
      try {
        this.server.close();
      } catch {}
      if (process.platform !== "win32") await rm(this.paths.endpoint, { force: true });
      if (this.ownsLock) await rm(this.paths.lock, { force: true });
      this.ownsLock = false;
      throw error;
    }
  }

  private async acquireSupervisorLock(): Promise<void> {
    try {
      const lock = await open(this.paths.lock, "wx", 0o600);
      this.ownsLock = true;
      try {
        await lock.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: this.now() })}\n`);
      } finally {
        await lock.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (this.ownsLock) await rm(this.paths.lock, { force: true });
        this.ownsLock = false;
        throw error;
      }
      let pid = 0;
      try {
        const parsed = JSON.parse(await readFile(this.paths.lock, "utf8")) as { pid?: unknown };
        if (typeof parsed.pid === "number") pid = parsed.pid;
      } catch {}
      if (pid > 0 && isProcessAlive(pid))
        throw new Error(`agent supervisor is already running as ${pid}`);
      await rm(this.paths.lock, { force: true });
      const lock = await open(this.paths.lock, "wx", 0o600);
      this.ownsLock = true;
      try {
        await lock.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: this.now() })}\n`);
      } catch (error) {
        await rm(this.paths.lock, { force: true });
        this.ownsLock = false;
        throw error;
      } finally {
        await lock.close();
      }
    }
  }

  async wait(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("close", resolve);
      this.server.once("error", reject);
    });
    if (this.closePromise) await this.closePromise;
  }

  async close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeInternal();
    await this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    const serverClosed = this.closeServer();
    const clients = [...this.clients];
    for (const client of clients) client.socket.destroy();
    await Promise.all(clients.map((client) => this.disconnect(client)));
    const runtimes = [...this.runtimes.entries()];
    await Promise.all(
      runtimes.map(([sessionId, runtime]) => this.shutdownRuntime(sessionId, runtime)),
    );
    while (this.exitHandlers.size > 0) {
      const handlers = [...this.exitHandlers];
      if (!(await waitForCompletion(Promise.all(handlers), Math.max(1_000, this.forceStopMs)))) {
        throw new Error(`timed out waiting for ${handlers.length} worker exit cleanup task(s)`);
      }
    }
    await this.saveChain;
    await serverClosed;
    if (process.platform !== "win32") await rm(this.paths.endpoint, { force: true });
    await rm(this.paths.supervisor, { force: true });
    if (this.ownsLock) await rm(this.paths.lock, { force: true });
    this.ownsLock = false;
  }

  private closeServer(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, SERVER_CLOSE_GRACE_MS);
      try {
        this.server.close(finish);
        this.server.unref();
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private accept(socket: Socket): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    const client: ClientConnection = {
      id: randomUUID(),
      socket,
      scope: undefined,
      attachment: undefined,
    };
    this.clients.add(client);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_AGENT_VIEW_LINE_CHARS && !buffer.includes("\n")) {
        write(socket, { type: "error", message: "agent-view request exceeds the line limit" });
        socket.destroy();
        return;
      }
      let end = buffer.indexOf("\n");
      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim()) void this.handleLine(client, line);
        end = buffer.indexOf("\n");
      }
    });
    const disconnected = () => void this.disconnect(client);
    socket.once("close", disconnected);
    socket.once("error", disconnected);
  }

  private async disconnect(client: ClientConnection): Promise<void> {
    if (!this.clients.delete(client)) return;
    if (client.attachment) await this.setAttached(client.attachment, false);
  }

  private async handleLine(client: ClientConnection, line: string): Promise<void> {
    let request: AgentViewRequest;
    try {
      request = parseAgentViewRequest(line);
    } catch (error) {
      write(client.socket, {
        type: "error",
        message: `invalid request: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    try {
      await this.handle(client, request);
    } catch (error) {
      write(client.socket, {
        type: "error",
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handle(client: ClientConnection, request: AgentViewRequest): Promise<void> {
    if (request.type !== "hello" && !client.scope)
      throw new Error("hello must be the first request");
    switch (request.type) {
      case "hello":
        client.scope = request.scope;
        write(client.socket, { type: "hello", version: 1, pid: process.pid });
        this.sendSnapshot(client);
        return;
      case "list":
        this.sendSnapshot(client);
        write(client.socket, { type: "ok", id: request.id });
        return;
      case "dispatch": {
        if (!request.prompt.trim()) throw new Error("dispatch prompt cannot be empty");
        const sessionId = `session-${randomUUID()}`;
        const scope = client.scope as string;
        const record = createManagedSessionRecord({
          sessionId,
          scope,
          prompt: request.prompt,
          cwd: request.cwd,
          profile: request.profile,
          ...(request.model ? { model: request.model } : {}),
          now: this.now(),
        });
        this.records.set(sessionId, record);
        await this.persistAndBroadcast(record);
        let runtime: WorkerRuntime | undefined;
        try {
          runtime = await this.spawnWorker(record, {
            ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
            ...(request.noInstructions ? { noInstructions: true } : {}),
            ...(request.environment ? { environment: request.environment } : {}),
          });
          await runtime.ready;
          await this.workerOperation(runtime, { type: "input", text: request.prompt });
        } catch (error) {
          if (runtime && runtime.process.exitCode === null) {
            runtime.lifecycle = "stopping";
            void this.terminateRuntime(runtime, "SIGTERM");
            this.scheduleForceStop(runtime);
          }
          const failed = reduceManagedSession(
            record,
            {
              type: "worker_failed",
              message: error instanceof Error ? error.message : String(error),
            },
            this.now(),
          );
          this.records.set(sessionId, failed);
          await this.persistAndBroadcast(failed);
          throw error;
        }
        write(client.socket, { type: "ok", id: request.id });
        return;
      }
      case "attach": {
        const record = this.requireRecord(request.sessionId, client.scope as string);
        const other = [...this.clients].find(
          (candidate) => candidate !== client && candidate.attachment === request.sessionId,
        );
        if (other) throw new Error("session already has an interactive attachment");
        const runtime = await this.ensureRuntime(record);
        this.cancelIdleEviction(runtime);
        await runtime.ready;
        delete runtime.snapshot;
        await this.workerOperation(runtime, { type: "snapshot" });
        if (!runtime.snapshot)
          throw new Error("session runtime did not provide an attach snapshot");
        client.attachment = request.sessionId;
        await this.setAttached(request.sessionId, true);
        const snapshot = runtime.snapshot as WorkerSnapshot;
        const current = this.records.get(request.sessionId) as ManagedSessionRecord;
        const attachment: AgentViewAttachment = {
          ...snapshot,
          ...(current.pendingRequest
            ? { pendingRequest: current.pendingRequest as PermissionRequest }
            : {}),
        };
        write(client.socket, { type: "attached", id: request.id, attachment });
        return;
      }
      case "detach":
        if (client.attachment !== request.sessionId)
          throw new Error("session is not attached here");
        client.attachment = undefined;
        await this.setAttached(request.sessionId, false);
        write(client.socket, { type: "ok", id: request.id });
        return;
      case "session_op": {
        const record = this.requireRecord(request.sessionId, client.scope as string);
        const runtime = await this.ensureRuntime(record);
        this.cancelIdleEviction(runtime);
        await runtime.ready;
        await this.workerOperation(runtime, request.op);
        write(client.socket, { type: "ok", id: request.id });
        return;
      }
      case "resize": {
        const record = this.requireRecord(request.sessionId, client.scope as string);
        const runtime = await this.ensureRuntime(record);
        await runtime.ready;
        await this.workerOperation(runtime, {
          type: "resize",
          cols: request.cols,
          rows: request.rows,
        });
        write(client.socket, { type: "ok", id: request.id });
        return;
      }
      case "stop": {
        const record = this.requireRecord(request.sessionId, client.scope as string);
        const runtime = this.runtimes.get(request.sessionId);
        if (runtime) {
          const wasEvicting = runtime.lifecycle === "evicting";
          runtime.lifecycle = "stopping";
          if (!wasEvicting) {
            await this.workerOperation(runtime, { type: "abort" }).catch(() => {});
            requestWorkerShutdown(runtime);
          }
          this.scheduleForceStop(runtime);
        } else {
          this.records.set(
            request.sessionId,
            reduceManagedSession(record, { type: "stopped" }, this.now()),
          );
          await this.persistAndBroadcast(
            this.records.get(request.sessionId) as ManagedSessionRecord,
          );
        }
        write(client.socket, { type: "ok", id: request.id });
        return;
      }
      case "remove": {
        const record = this.requireRecord(request.sessionId, client.scope as string);
        if (this.runtimes.has(request.sessionId))
          throw new Error("stop the runtime before removing its row");
        if (!["stopped", "completed", "failed"].includes(record.state))
          throw new Error("only inactive rows can be removed");
        this.records.delete(request.sessionId);
        await this.persist();
        this.broadcast(record.scope, { type: "removed", sessionId: request.sessionId });
        write(client.socket, { type: "ok", id: request.id });
        return;
      }
    }
  }

  private requireRecord(sessionId: string, scope: string): ManagedSessionRecord {
    const record = this.records.get(sessionId);
    if (!record || record.scope !== scope) throw new Error(`unknown managed session: ${sessionId}`);
    return record;
  }

  private async ensureRuntime(record: ManagedSessionRecord): Promise<WorkerRuntime> {
    if (this.closing) throw new Error("agent supervisor is shutting down");
    const current = this.runtimes.get(record.sessionId);
    if (current && (current.lifecycle === "starting" || current.lifecycle === "ready")) {
      return current;
    }

    const existing = this.runtimeTransitions.get(record.sessionId);
    if (existing) return existing;

    const transition = (async () => {
      const active = this.runtimes.get(record.sessionId);
      if (active && (active.lifecycle === "evicting" || active.lifecycle === "stopping")) {
        await (active.exitHandled ?? active.process.exited.then(() => {}));
      }
      if (this.closing) throw new Error("agent supervisor is shutting down");
      const replacement = this.runtimes.get(record.sessionId);
      if (replacement) return replacement;
      const latest = this.records.get(record.sessionId) ?? record;
      return this.spawnWorker(latest, { resume: true });
    })();
    this.runtimeTransitions.set(record.sessionId, transition);
    try {
      return await transition;
    } finally {
      if (this.runtimeTransitions.get(record.sessionId) === transition) {
        this.runtimeTransitions.delete(record.sessionId);
      }
    }
  }

  private workerOperation(runtime: WorkerRuntime, op: Record<string, unknown>): Promise<void> {
    if (runtime.process.exitCode !== null) {
      return Promise.reject(
        new Error(`session runtime already exited with ${runtime.process.exitCode}`),
      );
    }
    const operationId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.pendingOperations.delete(operationId);
        reject(new Error(`session runtime did not acknowledge ${String(op.type)} within 20s`));
      }, WORKER_OPERATION_TIMEOUT_MS);
      runtime.pendingOperations.set(operationId, { resolve, reject, timer });
      try {
        workerWrite(runtime, { ...op, operationId });
      } catch (error) {
        clearTimeout(timer);
        runtime.pendingOperations.delete(operationId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendSnapshot(client: ClientConnection): void {
    write(client.socket, {
      type: "snapshot",
      records: [...this.records.values()]
        .filter((record) => record.scope === client.scope)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    });
  }

  private broadcast(scope: string, response: AgentViewResponse): void {
    for (const client of this.clients) {
      if (client.scope === scope && !client.socket.destroyed) write(client.socket, response);
    }
  }

  private async persist(): Promise<void> {
    this.saveChain = this.saveChain.then(() => this.rosterStore.save([...this.records.values()]));
    await this.saveChain;
  }

  private async persistAndBroadcast(record: ManagedSessionRecord): Promise<void> {
    await this.persist();
    this.broadcast(record.scope, { type: "record", record });
  }

  private async setAttached(sessionId: string, attached: boolean): Promise<void> {
    const record = this.records.get(sessionId);
    if (!record || record.attached === attached) return;
    const next = reduceManagedSession(record, { type: "attached", attached }, this.now());
    this.records.set(sessionId, next);
    await this.persistAndBroadcast(next);
    const runtime = this.runtimes.get(sessionId);
    if (runtime && !attached && next.state === "completed") this.scheduleIdleEviction(runtime);
  }

  private async spawnWorker(
    record: ManagedSessionRecord,
    options: {
      resume?: boolean;
      permissionMode?: string;
      noInstructions?: boolean;
      environment?: Record<string, string>;
    },
  ): Promise<WorkerRuntime> {
    if (this.closing) throw new Error("agent supervisor is shutting down");
    if (this.runtimes.has(record.sessionId))
      throw new Error(`session ${record.sessionId} already has a runtime`);
    let ownership = await acquireSessionOwnership(this.paths, record.sessionId, {
      endpoint: this.paths.endpoint,
      recoverStale: true,
      recoverWorker: (pid) => this.stopStaleWorker(pid),
    });
    if (this.closing) {
      await releaseSessionOwnership(this.paths, ownership).catch(() => false);
      throw new Error("agent supervisor is shutting down");
    }
    const args = [
      "__agents-worker",
      ...(options.resume ? ["--resume", record.sessionId] : ["--session-id", record.sessionId]),
      "--ownership-token",
      ownership.token,
      "--profile",
      record.profile,
      ...(record.model ? ["--model", record.model] : []),
      ...(options.permissionMode ? ["--permission-mode", options.permissionMode] : []),
      ...(options.noInstructions ? ["--no-instructions"] : []),
    ];
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      child = this.spawnProcess(this.command(args), {
        cwd: record.workingCwd,
        env: { ...process.env, ...(options.environment ?? {}) },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      await releaseSessionOwnership(this.paths, ownership).catch(() => false);
      throw error;
    }
    try {
      ownership = await updateSessionOwnershipWorker(this.paths, ownership, child.pid);
    } catch (error) {
      try {
        await this.terminateChild(child);
      } finally {
        await releaseSessionOwnership(this.paths, ownership).catch(() => false);
      }
      throw error;
    }
    if (this.closing) {
      try {
        await this.terminateChild(child);
      } finally {
        await releaseSessionOwnership(this.paths, ownership).catch(() => false);
      }
      throw new Error("agent supervisor is shutting down");
    }
    let resolveReady = () => {};
    let rejectReady = (_error: Error) => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const runtime: WorkerRuntime = {
      process: child,
      ownership,
      ready,
      resolveReady,
      rejectReady,
      lifecycle: "starting",
      pendingOperations: new Map(),
    };
    this.runtimes.set(record.sessionId, runtime);
    runtime.startupTimer = setTimeout(() => {
      const error = new Error(
        `session runtime did not become ready within ${this.workerStartupMs}ms`,
      );
      runtime.rejectReady(error);
      void this.markWorkerFailed(record.sessionId, error.message);
      void this.terminateRuntime(runtime, "SIGTERM");
    }, this.workerStartupMs);
    void this.consumeWorker(record.sessionId, runtime);
    void this.consumeWorkerErrors(record.sessionId, child.stderr);
    const exitHandled = child.exited.then((code) =>
      this.finalizeWorkerExit(record.sessionId, runtime, code),
    );
    runtime.exitHandled = exitHandled;
    this.exitHandlers.add(exitHandled);
    void exitHandled.then(
      () => this.exitHandlers.delete(exitHandled),
      () => this.exitHandlers.delete(exitHandled),
    );
    return runtime;
  }

  private async consumeWorker(sessionId: string, runtime: WorkerRuntime): Promise<void> {
    try {
      for await (const line of streamLines(runtime.process.stdout)) {
        const out = workerOutSchema.parse(JSON.parse(line) as unknown);
        if (out.ownershipToken !== runtime.ownership.token) {
          throw new Error("worker output used a stale ownership generation");
        }
        if (this.runtimes.get(sessionId) !== runtime) return;
        if (out.type === "ready") {
          if (out.sessionId !== sessionId)
            throw new Error("worker reported a different session id");
          if (runtime.startupTimer) clearTimeout(runtime.startupTimer);
          delete runtime.startupTimer;
          runtime.lifecycle = "ready";
          const record = this.records.get(sessionId);
          if (record) {
            const next = reduceManagedSession(
              record,
              {
                type: "runtime_ready",
                pid: runtime.process.pid,
                model: out.model,
              },
              this.now(),
            );
            this.records.set(sessionId, next);
            await this.persistAndBroadcast(next);
          }
          runtime.resolveReady();
        } else if (out.type === "snapshot") {
          runtime.snapshot = out.snapshot as unknown as WorkerSnapshot;
        } else if (out.type === "event") {
          await this.consumeAgentEvent(sessionId, out.event as AgentEvent, runtime);
        } else if (out.type === "command_result") {
          const record = this.records.get(sessionId);
          if (record) {
            this.broadcast(record.scope, {
              type: "command_result",
              sessionId,
              ...(out.message ? { message: out.message } : {}),
              ...(out.data !== undefined ? { data: out.data } : {}),
              ...(out.runtime ? { runtime: out.runtime } : {}),
            });
          }
        } else if (out.type === "op_result") {
          const pending = runtime.pendingOperations.get(out.operationId);
          if (pending) {
            runtime.pendingOperations.delete(out.operationId);
            clearTimeout(pending.timer);
            if (out.ok) pending.resolve();
            else pending.reject(new Error(out.message ?? "session runtime rejected the operation"));
          }
        } else if (out.type === "error") {
          const record = this.records.get(sessionId);
          if (record) {
            const next = {
              ...record,
              lastError: out.message.slice(0, MAX_AGENT_VIEW_ERROR_CHARS),
              summary: displaySummary(out.message),
              updatedAt: this.now(),
            };
            this.records.set(sessionId, next);
            await this.persistAndBroadcast(next);
          }
        }
      }
    } catch (error) {
      runtime.rejectReady(error instanceof Error ? error : new Error(String(error)));
      void this.terminateRuntime(runtime, "SIGTERM");
    }
  }

  private async consumeWorkerErrors(
    sessionId: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    let diagnostic = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      diagnostic = `${diagnostic}${decoder.decode(chunk, { stream: true })}`.slice(-20_000);
    }
    diagnostic += decoder.decode();
    if (!diagnostic.trim()) return;
    const record = this.records.get(sessionId);
    if (record && record.state === "starting") {
      const next = {
        ...record,
        lastError: diagnostic.trim().slice(0, MAX_AGENT_VIEW_ERROR_CHARS),
        summary: displaySummary(diagnostic),
        updatedAt: this.now(),
      };
      this.records.set(sessionId, next);
      await this.persistAndBroadcast(next);
    }
  }

  private async consumeAgentEvent(
    sessionId: string,
    event: AgentEvent,
    runtime: WorkerRuntime,
  ): Promise<void> {
    const record = this.records.get(sessionId);
    if (!record) return;
    if (runtime.snapshot && event.type === "message_end")
      runtime.snapshot.messages.push(event.message);
    if (runtime.snapshot && event.type === "usage_updated") {
      runtime.snapshot.usage = event.sessionTotals;
      runtime.snapshot.contextPercent = event.contextPercent;
    }
    const next = reduceManagedSession(record, { type: "agent_event", event }, this.now());
    this.records.set(sessionId, next);
    await this.persistAndBroadcast(next);
    this.broadcast(record.scope, { type: "event", sessionId, event });
    if (event.type === "agent_end" && next.state === "completed" && !next.attached) {
      this.scheduleIdleEviction(runtime);
    }
  }

  private async workerExited(
    sessionId: string,
    runtime: WorkerRuntime,
    code: number,
  ): Promise<void> {
    if (this.runtimes.get(sessionId) !== runtime) return;
    if (runtime.startupTimer) clearTimeout(runtime.startupTimer);
    if (runtime.stopTimer) clearTimeout(runtime.stopTimer);
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    this.runtimes.delete(sessionId);
    const exitError = new Error(`worker exited with code ${code}`);
    runtime.rejectReady(exitError);
    for (const pending of runtime.pendingOperations.values()) {
      clearTimeout(pending.timer);
      pending.reject(exitError);
    }
    runtime.pendingOperations.clear();
    await releaseSessionOwnership(this.paths, runtime.ownership).catch(() => false);
    const record = this.records.get(sessionId);
    if (!record) return;
    const next =
      runtime.lifecycle === "evicting"
        ? {
            ...record,
            attached: false,
            ownerPid: undefined,
            pendingRequest: undefined,
            updatedAt: this.now(),
          }
        : record.state === "failed"
          ? { ...record, ownerPid: undefined, attached: false, updatedAt: this.now() }
          : runtime.lifecycle === "stopping"
            ? reduceManagedSession(record, { type: "stopped" }, this.now())
            : reduceManagedSession(
                record,
                { type: "worker_failed", message: `session runtime exited with code ${code}` },
                this.now(),
              );
    this.records.set(sessionId, next);
    await this.persistAndBroadcast(next);
  }

  private finalizeWorkerExit(
    sessionId: string,
    runtime: WorkerRuntime,
    code: number,
  ): Promise<void> {
    if (!runtime.exitFinalization) {
      runtime.exitFinalization = this.workerExited(sessionId, runtime, code);
    }
    return runtime.exitFinalization;
  }

  private terminateRuntime(runtime: WorkerRuntime, signal: NodeJS.Signals): Promise<void> {
    const force = signal === "SIGKILL";
    if (force) {
      if (runtime.forceTerminationAttempted) return runtime.termination ?? Promise.resolve();
      runtime.forceTerminationAttempted = true;
    } else {
      if (runtime.gracefulTerminationAttempted || runtime.forceTerminationAttempted) {
        return runtime.termination ?? Promise.resolve();
      }
      runtime.gracefulTerminationAttempted = true;
    }

    const termination = (runtime.termination ?? Promise.resolve()).then(async () => {
      if (runtime.process.exitCode !== null || !isProcessAlive(runtime.process.pid)) return;
      await this.terminateProcess(runtime.process, signal);
    });
    const tracked = termination.finally(() => {
      if (runtime.termination === tracked) delete runtime.termination;
    });
    runtime.termination = tracked;
    return tracked;
  }

  private async terminateChild(child: Bun.Subprocess): Promise<void> {
    await this.terminateProcess(child, "SIGTERM");
    if (!(await waitForProcessExit(child, this.forceStopMs)) && child.exitCode === null) {
      await this.terminateProcess(child, "SIGKILL");
    }
    if (await waitForProcessExit(child, Math.max(1_000, this.forceStopMs))) return;
    if (isProcessAlive(child.pid)) {
      throw new Error(`worker ${child.pid} did not exit after SIGKILL`);
    }
  }

  private async shutdownRuntime(sessionId: string, runtime: WorkerRuntime): Promise<void> {
    runtime.lifecycle = "stopping";
    if (runtime.stopTimer) clearTimeout(runtime.stopTimer);
    delete runtime.stopTimer;
    await runtime.termination;
    if (runtime.process.exitCode === null && isProcessAlive(runtime.process.pid)) {
      requestWorkerShutdown(runtime);
    }
    if (!(await waitForProcessExit(runtime.process, this.forceStopMs))) {
      await this.terminateRuntime(runtime, "SIGKILL");
      await waitForProcessExit(runtime.process, Math.max(1_000, this.forceStopMs));
    }
    if (isProcessAlive(runtime.process.pid)) {
      throw new Error(`worker ${runtime.process.pid} did not exit after SIGKILL`);
    }

    const exitHandled = runtime.exitHandled;
    if (exitHandled && (await waitForCompletion(exitHandled, Math.max(1_000, this.forceStopMs)))) {
      return;
    }
    if (exitHandled) this.exitHandlers.delete(exitHandled);
    await this.finalizeWorkerExit(sessionId, runtime, runtime.process.exitCode ?? 1);
  }

  private scheduleForceStop(runtime: WorkerRuntime): void {
    if (runtime.stopTimer) return;
    runtime.stopTimer = setTimeout(() => {
      if (runtime.process.exitCode === null) void this.terminateRuntime(runtime, "SIGKILL");
    }, this.forceStopMs);
  }

  private async stopStaleWorker(pid: number): Promise<void> {
    if (pid === process.pid)
      throw new Error("refusing to recover a worker using the supervisor pid");
    const target = {
      pid,
      exitCode: null,
      kill: (signal?: NodeJS.Signals | number) => process.kill(pid, signal),
    };
    await this.terminateProcess(target, "SIGTERM");
    const deadline = Date.now() + this.forceStopMs;
    while (isProcessAlive(pid) && Date.now() <= deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (isProcessAlive(pid)) await this.terminateProcess(target, "SIGKILL");
    const killDeadline = Date.now() + Math.max(1_000, this.forceStopMs);
    while (isProcessAlive(pid) && Date.now() <= killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (isProcessAlive(pid)) throw new Error(`stale worker ${pid} did not exit after SIGKILL`);
  }

  private async markWorkerFailed(sessionId: string, message: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (!record) return;
    const next = reduceManagedSession(record, { type: "worker_failed", message }, this.now());
    this.records.set(sessionId, next);
    await this.persistAndBroadcast(next);
  }

  private cancelIdleEviction(runtime: WorkerRuntime): void {
    if (!runtime.idleTimer) return;
    clearTimeout(runtime.idleTimer);
    delete runtime.idleTimer;
  }

  private scheduleIdleEviction(runtime: WorkerRuntime): void {
    this.cancelIdleEviction(runtime);
    if (this.completedIdleMs < 0) return;
    runtime.idleTimer = setTimeout(() => {
      delete runtime.idleTimer;
      if (runtime.process.exitCode !== null || runtime.lifecycle !== "ready") return;
      runtime.lifecycle = "evicting";
      requestWorkerShutdown(runtime);
      this.scheduleForceStop(runtime);
    }, this.completedIdleMs);
  }
}

export async function runAgentSupervisor(_args: ParsedArgs): Promise<number> {
  const supervisor = new AgentSupervisor();
  await supervisor.start();
  const close = () => void supervisor.close();
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  await supervisor.wait();
  return 0;
}

export function dispatchEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        typeof value === "string" &&
        (MANAGED_ENVIRONMENT_KEYS.includes(name) || name.startsWith(MANAGED_PROFILE_ENV_PREFIX)),
    ) as [string, string][],
  );
}

export function scopeForCurrentProject(cwd = process.cwd()): string {
  return projectScope(cwd);
}
