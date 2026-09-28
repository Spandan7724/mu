import type {
  CommandName,
  CommandParams,
  CommandResult,
  EventName,
  EventParams,
  SendOptions,
} from "./types.ts";

export const DEFAULT_CDP_TIMEOUT_MS = 10_000;

export type CdpErrorKind =
  | "stale-node"
  | "context-gone"
  | "target-closed"
  | "timeout"
  | "aborted"
  | "protocol";

const STALE_NODE = [
  /no node with given id/i,
  /could not find node with given id/i,
  /no node found for given backend id/i,
  /node with given id does not belong to the document/i,
  /node is detached from document/i,
  /cannot find object with id/i,
];
const CONTEXT_GONE = [
  /cannot find context with specified id/i,
  /execution context was destroyed/i,
  /inspected target navigated or closed/i,
  /cannot find default execution context/i,
];
const TARGET_CLOSED = [
  /target closed/i,
  /session with given id not found/i,
  /no target with given id/i,
  /session closed/i,
];

export function classifyProtocolError(message: string): CdpErrorKind {
  if (STALE_NODE.some((pattern) => pattern.test(message))) return "stale-node";
  if (CONTEXT_GONE.some((pattern) => pattern.test(message))) return "context-gone";
  if (TARGET_CLOSED.some((pattern) => pattern.test(message))) return "target-closed";
  return "protocol";
}

export class CdpError extends Error {
  constructor(
    readonly kind: CdpErrorKind,
    readonly method: string,
    message: string,
    readonly code = 0,
  ) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
  }
}

export function isCdpError(error: unknown, ...kinds: CdpErrorKind[]): error is CdpError {
  return error instanceof CdpError && (kinds.length === 0 || kinds.includes(error.kind));
}

// The wire, abstracted so tests can drive the connection with a fake socket.
export interface CdpTransport {
  send(message: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (reason: string) => void): void;
}

interface Pending {
  method: string;
  sessionId: string | undefined;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Listener {
  sessionId: string | undefined;
  handler: (params: unknown, sessionId: string | undefined) => void;
}

interface WireMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
  sessionId?: string;
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly closeWatchers = new Set<(reason: string) => void>();
  private closeReason: string | undefined;
  private resolveClosed!: (value: { reason: string }) => void;
  readonly closed: Promise<{ reason: string }>;

  constructor(private readonly transport: CdpTransport) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    transport.onMessage((data) => this.receive(data));
    transport.onClose((reason) => this.shutdown(reason));
  }

  get isClosed(): boolean {
    return this.closeReason !== undefined;
  }

  send<M extends CommandName>(
    method: M,
    params?: CommandParams<M>,
    options: SendOptions = {},
  ): Promise<CommandResult<M>> {
    const { sessionId, signal } = options;
    if (this.closeReason !== undefined) {
      return Promise.reject(
        new CdpError("target-closed", method, `connection closed (${this.closeReason})`),
      );
    }
    if (signal?.aborted) return Promise.reject(new CdpError("aborted", method, "aborted"));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    return new Promise<CommandResult<M>>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        cleanup();
        reject(new CdpError("aborted", method, "aborted"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new CdpError("timeout", method, `timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        sessionId,
        resolve: (value) => {
          cleanup();
          resolve(value as CommandResult<M>);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      try {
        this.transport.send(
          JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }),
        );
      } catch (error) {
        this.pending
          .get(id)
          ?.reject(
            new CdpError(
              "target-closed",
              method,
              error instanceof Error ? error.message : String(error),
            ),
          );
      }
    });
  }

  on<E extends EventName>(
    event: E,
    handler: (params: EventParams<E>, sessionId: string | undefined) => void,
    options: { sessionId?: string | undefined } = {},
  ): () => void {
    const listener: Listener = {
      sessionId: options.sessionId,
      handler: handler as Listener["handler"],
    };
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  // Resolves with the first matching event, rejecting on timeout, abort or close.
  waitFor<E extends EventName>(
    event: E,
    options: {
      sessionId?: string | undefined;
      predicate?: (params: EventParams<E>) => boolean;
      signal?: AbortSignal | undefined;
      timeoutMs?: number | undefined;
    } = {},
  ): Promise<EventParams<E>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new CdpError("aborted", event, "aborted"));
      if (this.closeReason !== undefined) {
        return reject(
          new CdpError("target-closed", event, `connection closed (${this.closeReason})`),
        );
      }
      let settled = false;
      const finish = (error?: Error, value?: EventParams<E>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        this.closeWatchers.delete(onClose);
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value as EventParams<E>);
      };
      const onAbort = () => finish(new CdpError("aborted", event, "aborted"));
      const timer = setTimeout(
        () => finish(new CdpError("timeout", event, `no event within ${timeoutMs} ms`)),
        timeoutMs,
      );
      const off = this.on(
        event,
        (params) => {
          if (!options.predicate || options.predicate(params)) finish(undefined, params);
        },
        { sessionId: options.sessionId },
      );
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const onClose = (reason: string) =>
        finish(new CdpError("target-closed", event, `connection closed (${reason})`));
      this.closeWatchers.add(onClose);
    });
  }

  close(): Promise<void> {
    if (this.closeReason === undefined) {
      try {
        this.transport.close();
      } catch {}
      this.shutdown("closed by client");
    }
    return this.closed.then(() => undefined);
  }

  private receive(data: string): void {
    let message: WireMessage;
    try {
      message = JSON.parse(data) as WireMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) {
        const detail = message.error.data
          ? `${message.error.message} (${message.error.data})`
          : message.error.message;
        pending.reject(
          new CdpError(classifyProtocolError(detail), pending.method, detail, message.error.code),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.method === "Target.detachedFromTarget") {
      const detached = (message.params as { sessionId?: string } | undefined)?.sessionId;
      if (detached) this.dropSession(detached);
    }
    const set = this.listeners.get(message.method);
    if (!set) return;
    for (const listener of [...set]) {
      if (listener.sessionId !== undefined && listener.sessionId !== message.sessionId) continue;
      try {
        listener.handler(message.params ?? {}, message.sessionId);
      } catch {}
    }
  }

  private dropSession(sessionId: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.sessionId === sessionId) {
        pending.reject(new CdpError("target-closed", pending.method, "target closed"));
      }
    }
    for (const [event, set] of this.listeners) {
      if (event === "Target.detachedFromTarget") continue;
      for (const listener of [...set]) if (listener.sessionId === sessionId) set.delete(listener);
    }
  }

  private shutdown(reason: string): void {
    if (this.closeReason !== undefined) return;
    this.closeReason = reason;
    for (const pending of [...this.pending.values()]) {
      pending.reject(
        new CdpError("target-closed", pending.method, `connection closed (${reason})`),
      );
    }
    this.listeners.clear();
    for (const watcher of [...this.closeWatchers]) watcher(reason);
    this.resolveClosed({ reason });
  }
}

export async function openWebSocketTransport(
  url: string,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
): Promise<CdpTransport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
  const socket = new WebSocket(url);
  const messageHandlers: ((data: string) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  let closed = false;
  const fireClose = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler(reason);
  };
  socket.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : String(event.data);
    for (const handler of messageHandlers) handler(data);
  });
  socket.addEventListener("close", (event) =>
    fireClose(event.reason || `socket closed (code ${event.code})`),
  );
  socket.addEventListener("error", () => fireClose("socket error"));

  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("close", onFail);
      socket.removeEventListener("error", onFail);
      if (error) {
        try {
          socket.close();
        } catch {}
        reject(error);
      } else resolve();
    };
    const onOpen = () => done();
    const onFail = () =>
      done(new CdpError("target-closed", "connect", `could not connect to ${url}`));
    const onAbort = () => done(new CdpError("aborted", "connect", "aborted"));
    const timer = setTimeout(
      () => done(new CdpError("timeout", "connect", `no connection within ${timeoutMs} ms`)),
      timeoutMs,
    );
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onFail);
    socket.addEventListener("error", onFail);
  });

  return {
    send: (message) => socket.send(message),
    close: () => socket.close(),
    onMessage: (handler) => {
      messageHandlers.push(handler);
    },
    onClose: (handler) => {
      closeHandlers.push(handler);
    },
  };
}

export async function connectCdp(
  wsUrl: string,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
): Promise<CdpConnection> {
  return new CdpConnection(await openWebSocketTransport(wsUrl, options));
}
