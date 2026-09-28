import type { CdpConnection } from "../cdp/connection.ts";
import { CdpSession } from "../cdp/session.ts";
import type { Protocol } from "../cdp/types.ts";

export interface FrameInfo {
  frameId: string;
  parentId?: string | undefined;
  url: string;
  // Session that owns the frame's document: the tab's own session, or an OOPIF child session.
  session: CdpSession;
}

const PAGE_DOMAINS = ["Page.enable", "Runtime.enable", "DOM.enable", "Network.enable"] as const;

// Tracks the frame tree of one tab across its main session and every
// out-of-process iframe session auto-attached below it.
export class FrameRegistry {
  private readonly frames = new Map<string, FrameInfo>();
  private readonly children = new Map<string, CdpSession>();
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly connection: CdpConnection,
    readonly root: CdpSession,
  ) {}

  get mainFrameId(): string | undefined {
    for (const frame of this.frames.values()) if (!frame.parentId) return frame.frameId;
    return undefined;
  }

  list(): FrameInfo[] {
    return [...this.frames.values()];
  }

  get(frameId: string): FrameInfo | undefined {
    return this.frames.get(frameId);
  }

  childSessions(): CdpSession[] {
    return [...this.children.values()].filter((session) => !session.detached);
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.watchSession(this.root, signal);
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.frames.clear();
    this.children.clear();
  }

  private record(tree: Protocol.Page.FrameTree, session: CdpSession, parentId?: string): void {
    this.frames.set(tree.frame.id, {
      frameId: tree.frame.id,
      parentId: parentId ?? tree.frame.parentId,
      url: tree.frame.url + (tree.frame.urlFragment ?? ""),
      session,
    });
    for (const child of tree.childFrames ?? []) this.record(child, session, tree.frame.id);
  }

  private async watchSession(
    session: CdpSession,
    signal?: AbortSignal,
    oopifParent?: string,
  ): Promise<void> {
    this.offs.push(
      session.on("Page.frameAttached", (event) => {
        if (!this.frames.has(event.frameId)) {
          this.frames.set(event.frameId, {
            frameId: event.frameId,
            parentId: event.parentFrameId,
            url: "",
            session,
          });
        }
      }),
      session.on("Page.frameNavigated", (event) => {
        const existing = this.frames.get(event.frame.id);
        this.frames.set(event.frame.id, {
          frameId: event.frame.id,
          parentId: event.frame.parentId ?? existing?.parentId ?? oopifParent,
          url: event.frame.url + (event.frame.urlFragment ?? ""),
          session,
        });
      }),
      session.on("Page.navigatedWithinDocument", (event) => {
        const existing = this.frames.get(event.frameId);
        if (existing) existing.url = event.url;
      }),
      session.on("Page.frameDetached", (event) => {
        // A "swap" moves the frame into an OOPIF session that re-registers it.
        if (event.reason === "remove") this.removeFrame(event.frameId);
      }),
      session.on("Target.attachedToTarget", (event) => {
        void this.adoptChild(event);
      }),
      session.on("Target.detachedFromTarget", (event) => {
        const child = this.children.get(event.sessionId);
        if (!child) return;
        this.children.delete(event.sessionId);
        for (const frame of this.list())
          if (frame.session === child) this.frames.delete(frame.frameId);
      }),
    );
    const options = { signal, timeoutMs: 5_000 };
    await Promise.all([
      ...PAGE_DOMAINS.map((method) => session.send(method, undefined, options)),
      session.send("Page.setLifecycleEventsEnabled", { enabled: true }, options),
      session.send(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        options,
      ),
    ]);
    const { frameTree } = await session.send("Page.getFrameTree", undefined, options);
    this.record(frameTree, session, oopifParent);
  }

  private removeFrame(frameId: string): void {
    this.frames.delete(frameId);
    for (const frame of this.list())
      if (frame.parentId === frameId) this.removeFrame(frame.frameId);
  }

  private async adoptChild(event: Protocol.Target.AttachedToTargetEvent): Promise<void> {
    const child = new CdpSession(this.connection, event.sessionId, event.targetInfo.targetId);
    if (event.targetInfo.type !== "iframe") {
      await child
        .send("Runtime.runIfWaitingForDebugger", undefined, { timeoutMs: 2_000 })
        .catch(() => {});
      return;
    }
    this.children.set(event.sessionId, child);
    // The OOPIF's root frame id is its target id; its parent lives in the parent session.
    const parentFrame = this.frames.get(event.targetInfo.targetId)?.parentId;
    const watched = this.watchSession(child, undefined, parentFrame).catch(() => {});
    await child
      .send("Runtime.runIfWaitingForDebugger", undefined, { timeoutMs: 2_000 })
      .catch(() => {});
    await watched;
  }
}
