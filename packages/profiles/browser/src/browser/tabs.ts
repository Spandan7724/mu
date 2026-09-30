import type { CdpConnection } from "../cdp/connection.ts";
import { attachToTarget, type CdpSession } from "../cdp/session.ts";
import { NetworkTracker } from "../page/network.ts";
import { RefTable } from "../page/refs.ts";
import { FrameRegistry } from "./frames.ts";

export interface TabInfo {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
  openedByAgent: boolean;
  // A finished sub-task left this tab open for the user.
  leftBy?: string;
}

export interface JsDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
}

// One browser tab the agent can operate: its flattened session, frame tree,
// and the page-level state that must survive between tool calls.
export class Tab {
  dialog: JsDialog | undefined;
  crashed = false;
  readonly refs = new RefTable();
  // Link targets captured since the last tool result drained them.
  readonly links = new Set<string>();
  readonly network = new NetworkTracker();
  // What the previous observation showed, for `*` change markers.
  previous: { documentId: string; refs: Set<string>; texts: Set<string> } | undefined;
  // Fingerprint of the latest observation, to tell whether an action changed anything visible.
  lastFingerprint: string | undefined;
  // Consecutive interactions that left the page exactly as it was.
  unchangedStreak = 0;
  private readonly offs: (() => void)[] = [];

  private constructor(
    readonly tabId: string,
    readonly targetId: string,
    readonly session: CdpSession,
    readonly frames: FrameRegistry,
    public url: string,
    public title: string,
    readonly openedByAgent: boolean,
  ) {}

  static async attach(
    connection: CdpConnection,
    target: { targetId: string; url: string; title: string },
    tabId: string,
    openedByAgent: boolean,
    signal?: AbortSignal,
    emulateViewport?: { width: number; height: number },
  ): Promise<Tab> {
    const session = await attachToTarget(connection, target.targetId, { signal });
    const frames = new FrameRegistry(connection, session);
    const tab = new Tab(
      tabId,
      target.targetId,
      session,
      frames,
      target.url,
      target.title,
      openedByAgent,
    );
    frames.onSession((target) => tab.network.attach(target));
    tab.offs.push(
      session.on("Page.javascriptDialogOpening", (event) => {
        tab.dialog = {
          type: event.type,
          message: event.message,
          ...(event.type === "prompt" ? { defaultPrompt: event.defaultPrompt ?? "" } : {}),
        };
      }),
      session.on("Page.javascriptDialogClosed", () => {
        tab.dialog = undefined;
      }),
      session.on("Inspector.targetCrashed", () => {
        tab.crashed = true;
      }),
      session.on("Page.frameNavigated", (event) => {
        if (!event.frame.parentId) tab.url = event.frame.url + (event.frame.urlFragment ?? "");
      }),
      session.on("Page.navigatedWithinDocument", (event) => {
        if (event.frameId === frames.mainFrameId) tab.url = event.url;
      }),
    );
    try {
      await Promise.all([
        frames.start(signal),
        session.send("Inspector.enable", undefined, { signal, timeoutMs: 5_000 }),
        ...(emulateViewport
          ? [
              session.send(
                "Emulation.setDeviceMetricsOverride",
                { ...emulateViewport, deviceScaleFactor: 0, mobile: false },
                { signal, timeoutMs: 5_000 },
              ),
            ]
          : []),
      ]);
    } catch (error) {
      tab.dispose();
      await session.detach();
      throw error;
    }
    return tab;
  }

  get detached(): boolean {
    return this.session.detached;
  }

  info(active: boolean): TabInfo {
    return {
      tabId: this.tabId,
      url: this.url,
      title: this.title,
      active,
      openedByAgent: this.openedByAgent,
    };
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.frames.dispose();
  }
}
