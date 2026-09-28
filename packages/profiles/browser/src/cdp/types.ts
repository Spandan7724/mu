import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";

export type { Protocol, ProtocolMapping };

export type CommandName = keyof ProtocolMapping.Commands;
export type EventName = keyof ProtocolMapping.Events;

export type CommandParams<M extends CommandName> =
  ProtocolMapping.Commands[M]["paramsType"] extends []
    ? undefined
    : ProtocolMapping.Commands[M]["paramsType"] extends [(infer P)?]
      ? P
      : undefined;

export type CommandResult<M extends CommandName> = ProtocolMapping.Commands[M]["returnType"];

export type EventParams<E extends EventName> = ProtocolMapping.Events[E] extends [infer P]
  ? P
  : undefined;

export interface SendOptions {
  sessionId?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}
