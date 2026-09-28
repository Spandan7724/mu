import type { CdpConnection } from "./connection.ts";
import type {
  CommandName,
  CommandParams,
  CommandResult,
  EventName,
  EventParams,
  SendOptions,
} from "./types.ts";

// A flattened target session: every message travels over the browser socket
// tagged with this session id.
export class CdpSession {
  private detachedFlag = false;
  private readonly offDetach: () => void;

  constructor(
    readonly connection: CdpConnection,
    readonly sessionId: string,
    readonly targetId: string,
  ) {
    this.offDetach = connection.on("Target.detachedFromTarget", (params) => {
      if (params.sessionId !== sessionId) return;
      this.detachedFlag = true;
      this.offDetach();
    });
  }

  get detached(): boolean {
    return this.detachedFlag || this.connection.isClosed;
  }

  send<M extends CommandName>(
    method: M,
    params?: CommandParams<M>,
    options: Omit<SendOptions, "sessionId"> = {},
  ): Promise<CommandResult<M>> {
    return this.connection.send(method, params, { ...options, sessionId: this.sessionId });
  }

  on<E extends EventName>(event: E, handler: (params: EventParams<E>) => void): () => void {
    return this.connection.on(event, (params) => handler(params), { sessionId: this.sessionId });
  }

  waitFor<E extends EventName>(
    event: E,
    options: {
      predicate?: (params: EventParams<E>) => boolean;
      signal?: AbortSignal | undefined;
      timeoutMs?: number | undefined;
    } = {},
  ): Promise<EventParams<E>> {
    return this.connection.waitFor(event, { ...options, sessionId: this.sessionId });
  }

  async detach(): Promise<void> {
    if (this.detached) return;
    await this.connection
      .send("Target.detachFromTarget", { sessionId: this.sessionId }, { timeoutMs: 2_000 })
      .catch(() => {});
  }
}

export async function attachToTarget(
  connection: CdpConnection,
  targetId: string,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
): Promise<CdpSession> {
  const { sessionId } = await connection.send(
    "Target.attachToTarget",
    { targetId, flatten: true },
    options,
  );
  return new CdpSession(connection, sessionId, targetId);
}
