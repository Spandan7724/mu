import type { Tab } from "../browser/tabs.ts";
import { isCdpError } from "../cdp/connection.ts";
import type { CdpSession } from "../cdp/session.ts";
import type { Ref } from "./refs.ts";

export class StaleRefError extends Error {
  constructor(
    readonly ref: Ref,
    reason: string,
  ) {
    super(`ref ${ref} ${reason}`);
    this.name = "StaleRefError";
  }
}

export interface ResolvedRef {
  ref: Ref;
  frameId: string;
  backendNodeId: number;
  session: CdpSession;
  objectId: string;
}

// Resolves a ref to a live node, or throws StaleRefError — never a different element.
export async function resolveRef(tab: Tab, ref: Ref, signal?: AbortSignal): Promise<ResolvedRef> {
  const target = tab.refs.resolve(ref);
  if (!target) {
    throw new StaleRefError(ref, "is not on this page (refs come from the latest observation)");
  }
  const frame = tab.frames.get(target.frameId);
  if (!frame || frame.session.detached) throw new StaleRefError(ref, "was in a frame that is gone");
  let objectId: string | undefined;
  try {
    const resolved = await frame.session.send(
      "DOM.resolveNode",
      { backendNodeId: target.backendNodeId, objectGroup: "mu-action" },
      { signal, timeoutMs: 3_000 },
    );
    objectId = resolved.object.objectId;
  } catch (error) {
    if (isCdpError(error, "stale-node", "context-gone", "target-closed", "protocol")) {
      throw new StaleRefError(ref, "no longer exists on the page");
    }
    throw error;
  }
  if (!objectId) throw new StaleRefError(ref, "no longer exists on the page");
  const connected = await frame.session.send(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: "function () { return this.isConnected; }",
      returnByValue: true,
    },
    { signal, timeoutMs: 3_000 },
  );
  if (connected.result.value !== true) throw new StaleRefError(ref, "was removed from the page");
  return { ref, ...target, session: frame.session, objectId };
}
