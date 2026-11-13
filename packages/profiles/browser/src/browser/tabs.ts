import type { CdpConnection } from "../cdp/connection.ts";
import { attachToTarget, type CdpSession } from "../cdp/session.ts";
import { NetworkTracker } from "../page/network.ts";
import { RefTable } from "../page/refs.ts";
import { FrameRegistry } from "./frames.ts";

// How long a drawn page may take to deliver an animation frame (6 fps is still drawn).
const FRAME_WAIT_MS = 150;
// Editors save once typing pauses (debounced autosave); leaving the page sooner loses the
// edit. Before mu leaves a page it typed into, it allows this long for a save to start.
const SAVE_DELAY_MS = 2_000;
const SAVE_CAP_MS = 15_000;

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

// Fails a page's main-frame document requests to hosts the host lists exclude, redirect
// hops included, before they leave the browser. Needs enableLoadBlocking on the session.
export function blockOffHostLoads(
  session: CdpSession,
  mainFrameId: () => string,
  hostAllowed: (url: string) => boolean,
  onBlocked: (url: string) => void,
): () => void {
  return session.on("Fetch.requestPaused", (event) => {
    const options = { timeoutMs: 5_000 };
    if (event.frameId === mainFrameId() && !hostAllowed(event.request.url)) {
      onBlocked(event.request.url);
      void session
        .send(
          "Fetch.failRequest",
          { requestId: event.requestId, errorReason: "BlockedByClient" },
          options,
        )
        .catch(() => {});
      return;
    }
    void session
      .send("Fetch.continueRequest", { requestId: event.requestId }, options)
      .catch(() => {});
  });
}

export function enableLoadBlocking(session: CdpSession, signal?: AbortSignal): Promise<unknown> {
  return session.send(
    "Fetch.enable",
    { patterns: [{ resourceType: "Document", requestStage: "Request" }] },
    { signal, timeoutMs: 5_000 },
  );
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
  // When mu last typed or pressed keys, and in which document; cleared once awaited.
  private lastInput: { at: number; loaderId: string | undefined } | undefined;
  // mu asked the page to close; a beforeunload dialog then answers whether it may.
  closing = false;
  // What the last settle saw still unfinished; shown to the model once.
  unfinished: string[] = [];
  // A main-frame navigation the host lists stopped before it left the browser.
  blockedNavigation: string | undefined;
  // The main frame shows Chrome's error page; tab.url (from target info) then names the
  // URL that failed, though nothing from it loaded.
  errorPage = false;
  // How many times each observation result was returned on the current document;
  // interleaving scrolls breaks streaks, so repeats are counted, not streaks.
  private repeats = { documentId: "", counts: new Map<string, number>() };
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
    // Set when allowedHosts/blockedHosts are configured: main-frame documents on other
    // hosts are failed before they are requested, which also stops redirects to them.
    hostAllowed?: (url: string) => boolean,
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
        if (event.frame.parentId) return;
        tab.url = event.frame.url + (event.frame.urlFragment ?? "");
        tab.errorPage = event.frame.unreachableUrl !== undefined;
      }),
      session.on("Page.navigatedWithinDocument", (event) => {
        if (event.frameId === frames.mainFrameId) tab.url = event.url;
      }),
    );
    if (hostAllowed) {
      tab.offs.push(
        blockOffHostLoads(
          session,
          () => frames.mainFrameId ?? target.targetId,
          hostAllowed,
          (url) => {
            tab.blockedNavigation = url;
          },
        ),
      );
    }
    try {
      await Promise.all([
        frames.start(signal),
        session.send("Inspector.enable", undefined, { signal, timeoutMs: 5_000 }),
        ...(hostAllowed ? [enableLoadBlocking(session, signal)] : []),
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
    // A page that showed an error before mu attached (a popup whose load was blocked).
    const mainFrame = frames.mainFrameId ? frames.get(frames.mainFrameId) : undefined;
    if (mainFrame?.url.startsWith("chrome-error:")) tab.errorPage = true;
    return tab;
  }

  countRepeat(documentId: string, key: string): number {
    if (this.repeats.documentId !== documentId) {
      this.repeats = { documentId, counts: new Map() };
    }
    const count = (this.repeats.counts.get(key) ?? 0) + 1;
    this.repeats.counts.set(key, count);
    return count;
  }

  // A window the compositor is not drawing (on Wayland, one on a hidden workspace) gets no
  // animation frames while visibilityState stays "visible", so pages that render on a frame
  // (Gmail's message rows, lazy lists) never fill in. A screenshot rendered without the
  // compositor starts frames again (~130 ms); they keep running while the page asks for
  // them. Measured on Hyprland 0.57 / Chrome 154: no frames for 8 s+ without it, 60 fps after.
  // Returns whether frames had stopped (and were restarted).
  async ensureRendering(signal?: AbortSignal): Promise<boolean> {
    if (this.dialog) return false;
    const contextId = await this.frames
      .isolatedWorld(this.frames.mainFrameId ?? "", signal)
      .catch(() => undefined);
    if (contextId === undefined) return false;
    const framed = await this.session
      .send(
        "Runtime.evaluate",
        {
          expression: `new Promise(function (resolve) { requestAnimationFrame(function () { resolve(true); }); setTimeout(function () { resolve(false); }, ${FRAME_WAIT_MS}); })`,
          contextId,
          awaitPromise: true,
          returnByValue: true,
        },
        { signal, timeoutMs: 2_000 },
      )
      .catch(() => undefined);
    if (framed === undefined || framed.result.value === true) return false;
    await this.session
      .send(
        "Page.captureScreenshot",
        {
          format: "jpeg",
          quality: 1,
          clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
          fromSurface: false,
        },
        { signal, timeoutMs: 3_000 },
      )
      .catch(() => {});
    return true;
  }

  noteInput(): void {
    this.lastInput = { at: performance.now(), loaderId: this.documentLoader() };
  }

  private documentLoader(): string | undefined {
    return this.frames.get(this.frames.mainFrameId ?? "")?.loaderId;
  }

  // Before mu leaves a page it typed into: waits until a save has started (or
  // SAVE_DELAY_MS passed without one) and no write is in flight. Returns the ms waited.
  async awaitSaves(signal?: AbortSignal): Promise<number> {
    const input = this.lastInput;
    this.lastInput = undefined;
    // Typing that submitted the page left that document already.
    if (!input || input.loaderId !== this.documentLoader()) return 0;
    const since = input.at;
    const started = performance.now();
    const settled = () => {
      const now = performance.now();
      if (now - started >= SAVE_CAP_MS) return true;
      if (this.network.pendingWrites(since) > 0) return false;
      return this.network.lastWriteAt >= since || now >= since + SAVE_DELAY_MS;
    };
    while (!settled() && !this.detached) {
      if (signal?.aborted) break;
      await new Promise<void>((resolve) => {
        const wake = () => {
          off();
          clearTimeout(timer);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        const off = this.network.onChange(wake);
        const timer = setTimeout(wake, Math.max(10, since + SAVE_DELAY_MS - performance.now()));
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
    return Math.round(performance.now() - started);
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
