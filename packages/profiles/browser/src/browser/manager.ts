import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataFlowGuard } from "../agent/dataflow.ts";
import { type CdpConnection, CdpError, isCdpError } from "../cdp/connection.ts";
import type { Protocol } from "../cdp/types.ts";
import { SecretRegistry } from "../page/secrets.ts";
import {
  type BrowserLauncher,
  type ConnectedBrowser,
  connectManaged,
  connectToEndpoint,
} from "./connect.ts";
import { DownloadTracker } from "./downloads.ts";
import type { Size } from "./launch.ts";
import { Tab, type TabInfo } from "./tabs.ts";

export interface BrowserManagerOptions {
  connect: "managed" | "cdp";
  profileName: string;
  userDataDir: string;
  cdpUrl?: string | undefined;
  executable?: string | undefined;
  channel?: string | undefined;
  headless: boolean;
  viewport: Size;
  args?: string[] | undefined;
  keepOpen: boolean;
  launcher?: BrowserLauncher | undefined;
  // Downloads of this manager's lifetime land in a fresh subdirectory here.
  downloadsDir?: string | undefined;
}

export interface BrowserStatus {
  mode: "managed" | "cdp";
  profile: string;
  userDataDir?: string;
  endpoint?: string;
  connected: boolean;
  launched: boolean;
  pid?: number;
  product?: string;
  version?: string;
  executable?: string;
  headless: boolean;
  tabs: number;
  activeTab?: TabInfo;
}

interface PageTarget {
  targetId: string;
  tabId: string;
  url: string;
  title: string;
  openerId?: string | undefined;
  openedByAgent: boolean;
  createdAt: number;
  lastUsed: number;
  // The lane whose agent may use this tab.
  owner: string;
  // A finished sub-task left this tab open for the user.
  leftBy?: string | undefined;
}

const MAX_LIVE_TABS = 3;
const MAX_AGENT_TABS = 4;
// Sub-tasks with a browser lane at once; more wait for one to finish.
export const MAX_LANES = 3;
const MAIN = "main";
// A lane's new tab starts on this URL, so its owner is known from its first event.
const LANE_MARK = /^about:blank#mu-(lane-\d+)$/;

const BLANK_URLS = new Set(["about:blank", "chrome://newtab/", "chrome://new-tab-page/", ""]);

// Everything the lanes of one browser session share: the connection, every tab,
// downloads, secrets and the cross-site data record.
class SharedBrowser {
  connected: ConnectedBrowser | undefined;
  connecting: Promise<ConnectedBrowser> | undefined;
  readonly pages = new Map<string, PageTarget>();
  readonly attached = new Map<string, Tab>();
  readonly attaching = new Map<string, Promise<Tab>>();
  readonly tabIds = new Map<string, string>();
  nextTab = 1;
  nextLane = 1;
  closingIntentionally = false;
  product: { product: string; version: string; executable?: string } | undefined;
  abort = new AbortController();
  readonly lanes = new Set<BrowserManager>();
  readonly waiting = new Set<() => void>();
  readonly downloads: DownloadTracker;
  readonly secrets = new SecretRegistry();
  readonly dataflow = new DataFlowGuard();

  constructor(downloadsDir: string | undefined) {
    const run = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
    this.downloads = new DownloadTracker(
      join(downloadsDir ?? join(tmpdir(), "mu-browser-downloads"), run),
    );
  }
}

// One agent's view of the session's browser: the tabs it owns, the active tab it
// operates on, and its observation bookkeeping. The main agent's manager owns the
// connection; each parallel sub-task gets a lane (openLane) whose tabs open in
// their own windows, so every lane's active tab stays visible and receives input.
export class BrowserManager {
  private readonly shared: SharedBrowser;
  readonly laneId: string;
  // The sub-task this lane runs, shown in approvals; undefined for the main agent.
  readonly label: string | undefined;
  private activeTargetId: string | undefined;
  private notices: string[] = [];
  // Observations since one last carried a screenshot.
  withoutScreenshot = 0;
  // Tab switches in a row with no other browser action in between.
  switchStreak = 0;
  // An approved consequential action that was blocked before any input reached the page.
  approvedRetry: { key: string; url: string; remaining: number } | undefined;
  // Which tab owns each live-observation slot, least recently observed first.
  private slots: { slot: number; tabId: string }[] = [];

  constructor(
    readonly options: BrowserManagerOptions,
    shared?: SharedBrowser,
    lane?: { id: string; label: string },
  ) {
    this.shared = shared ?? new SharedBrowser(options.downloadsDir);
    this.laneId = lane?.id ?? MAIN;
    this.label = lane?.label;
    this.shared.lanes.add(this);
  }

  get downloads(): DownloadTracker {
    return this.shared.downloads;
  }

  get secrets(): SecretRegistry {
    return this.shared.secrets;
  }

  get dataflow(): DataFlowGuard {
    return this.shared.dataflow;
  }

  private get pages(): Map<string, PageTarget> {
    return this.shared.pages;
  }

  private get attached(): Map<string, Tab> {
    return this.shared.attached;
  }

  get isConnected(): boolean {
    const connected = this.shared.connected;
    return connected !== undefined && !connected.connection.isClosed;
  }

  get connection(): CdpConnection | undefined {
    return this.shared.connected?.connection;
  }

  // Combines a tool's signal with the session's stop signal.
  actionSignal(signal?: AbortSignal): AbortSignal {
    const stop = this.shared.abort.signal;
    return signal ? AbortSignal.any([signal, stop]) : stop;
  }

  stop(): void {
    this.shared.abort.abort();
    this.shared.abort = new AbortController();
  }

  drainNotices(): string[] {
    const notices = this.notices;
    this.notices = [];
    return notices;
  }

  async ensureConnected(signal?: AbortSignal): Promise<CdpConnection> {
    const shared = this.shared;
    if (this.isConnected && shared.connected) return shared.connected.connection;
    if (!shared.connecting) {
      shared.connecting = this.connect(signal).finally(() => {
        shared.connecting = undefined;
      });
    }
    return (await shared.connecting).connection;
  }

  private async connect(signal?: AbortSignal): Promise<ConnectedBrowser> {
    const shared = this.shared;
    const connected =
      this.options.connect === "cdp"
        ? await connectToEndpoint(this.requireCdpUrl(), { signal })
        : await connectManaged({
            userDataDir: this.options.userDataDir,
            headless: this.options.headless,
            viewport: this.options.viewport,
            executable: this.options.executable,
            channel: this.options.channel,
            args: this.options.args,
            launcher: this.options.launcher,
            signal,
          });
    const { connection } = connected;
    shared.closingIntentionally = false;
    shared.pages.clear();
    shared.attached.clear();
    for (const lane of shared.lanes) lane.activeTargetId = undefined;
    connection.on("Target.targetCreated", (event) => this.trackTarget(event.targetInfo));
    connection.on("Target.targetInfoChanged", (event) => this.trackTarget(event.targetInfo));
    connection.on("Target.targetDestroyed", (event) => this.forgetTarget(event.targetId));
    void connection.closed.then(({ reason }) => this.onDisconnect(connection, reason));
    try {
      const [version, { targetInfos }] = await Promise.all([
        connection.send("Browser.getVersion", undefined, { signal }),
        connection.send("Target.getTargets", undefined, { signal }),
        connection.send("Target.setDiscoverTargets", { discover: true }, { signal }),
        shared.downloads.attach(connection, signal),
      ]);
      for (const info of targetInfos) this.trackTarget(info);
      const [product, number] = version.product.split("/");
      shared.product = {
        product: connected.browser?.product ?? product ?? version.product,
        version: number ?? connected.browser?.version ?? "unknown",
        ...(connected.browser ? { executable: connected.browser.path } : {}),
      };
    } catch (error) {
      await connection.close();
      throw error;
    }
    shared.connected = connected;
    return connected;
  }

  private requireCdpUrl(): string {
    if (!this.options.cdpUrl) throw new Error("connect: cdp requires a cdpUrl");
    return this.options.cdpUrl;
  }

  private onDisconnect(connection: CdpConnection, reason: string): void {
    const shared = this.shared;
    if (shared.connected?.connection !== connection) return;
    shared.connected = undefined;
    for (const tab of shared.attached.values()) tab.dispose();
    shared.attached.clear();
    for (const lane of shared.lanes) {
      lane.activeTargetId = undefined;
      if (!shared.closingIntentionally) {
        lane.notices.push(
          `The browser disconnected (${reason}); it was reconnected for this action. Open tabs may have changed — check the page before continuing.`,
        );
      }
    }
  }

  private tabIdFor(targetId: string): string {
    let tabId = this.shared.tabIds.get(targetId);
    if (!tabId) {
      tabId = `t${this.shared.nextTab++}`;
      this.shared.tabIds.set(targetId, tabId);
    }
    return tabId;
  }

  private trackTarget(info: Protocol.Target.TargetInfo): void {
    if (info.type !== "page") return;
    const existing = this.pages.get(info.targetId);
    const openerId = info.openerId ?? existing?.openerId;
    // A popup belongs to the lane whose tab opened it; tabs the user opens, to the main agent.
    const owner =
      existing?.owner ??
      LANE_MARK.exec(info.url)?.[1] ??
      (openerId ? this.pages.get(openerId)?.owner : undefined) ??
      MAIN;
    const page: PageTarget = {
      targetId: info.targetId,
      tabId: this.tabIdFor(info.targetId),
      url: info.url,
      title: info.title,
      openerId,
      openedByAgent: existing?.openedByAgent ?? false,
      createdAt: existing?.createdAt ?? Date.now(),
      lastUsed: existing?.lastUsed ?? Date.now(),
      owner,
      leftBy: existing?.leftBy,
    };
    this.pages.set(info.targetId, page);
    const tab = this.attached.get(info.targetId);
    if (tab) {
      tab.url = info.url;
      tab.title = info.title;
    }
  }

  // Only MAX_LIVE_TABS tabs keep a full observation in context: a tab reuses its own
  // slot, else a free one, else the least recently observed tab's (whose old
  // observation then collapses, since it shares the retention key).
  observationSlot(tabId: string): number {
    const index = this.slots.findIndex((entry) => entry.tabId === tabId);
    const closed = this.slots.findIndex((entry) => entry.tabId.startsWith("closed:"));
    let slot: number;
    if (index >= 0 || closed >= 0) {
      const at = index >= 0 ? index : closed;
      slot = (this.slots[at] as { slot: number }).slot;
      this.slots.splice(at, 1);
    } else if (this.slots.length < MAX_LIVE_TABS) {
      const used = new Set(this.slots.map((entry) => entry.slot));
      slot = [...Array(MAX_LIVE_TABS).keys()].find((candidate) => !used.has(candidate)) ?? 0;
    } else {
      slot = (this.slots.shift() as { slot: number }).slot;
    }
    this.slots.push({ slot, tabId });
    return slot;
  }

  private forgetTarget(targetId: string): void {
    const closedTab = this.pages.get(targetId)?.tabId;
    for (const lane of this.shared.lanes) lane.targetGone(targetId, closedTab);
    this.pages.delete(targetId);
    this.attached.get(targetId)?.dispose();
    this.attached.delete(targetId);
  }

  private targetGone(targetId: string, closedTab: string | undefined): void {
    // A closed tab's slot goes to the front, so the next new tab reuses it and its
    // last observation collapses.
    const freed = this.slots.findIndex((entry) => entry.tabId === closedTab);
    if (freed >= 0) {
      const [entry] = this.slots.splice(freed, 1);
      if (entry) this.slots.unshift({ ...entry, tabId: `closed:${closedTab}` });
    }
    if (this.activeTargetId === targetId) {
      this.activeTargetId = undefined;
      this.notices.push("The active tab was closed.");
    }
  }

  // The attached active tab, if any, for synchronous callers (permission classification).
  currentTab(): Tab | undefined {
    return this.activeTargetId ? this.attached.get(this.activeTargetId) : undefined;
  }

  private own(page: PageTarget): boolean {
    return page.owner === this.laneId;
  }

  private info(page: PageTarget): TabInfo {
    const tab = this.attached.get(page.targetId);
    return {
      tabId: page.tabId,
      url: tab?.url ?? page.url,
      title: tab?.title ?? page.title,
      active: page.targetId === this.activeTargetId,
      openedByAgent: page.openedByAgent,
      ...(page.leftBy ? { leftBy: page.leftBy } : {}),
    };
  }

  // The tabs this agent may use: its own. Other lanes' tabs are invisible to it.
  tabs(): TabInfo[] {
    return [...this.pages.values()].filter((page) => this.own(page)).map((page) => this.info(page));
  }

  // Pages opened after `since` by one of the given tabs (popups, target=_blank).
  openedSince(since: number, openerTargetIds: string[]): TabInfo[] {
    return [...this.pages.values()]
      .filter(
        (page) =>
          page.createdAt >= since && page.openerId && openerTargetIds.includes(page.openerId),
      )
      .map((page) => ({ ...this.info(page), url: page.url, title: page.title }));
  }

  private async attach(targetId: string, signal?: AbortSignal): Promise<Tab> {
    const existing = this.attached.get(targetId);
    if (existing && !existing.detached) return existing;
    const pending = this.shared.attaching.get(targetId);
    if (pending) return pending;
    const page = this.pages.get(targetId);
    if (!page) throw new Error(`No such tab (${targetId})`);
    const connection = await this.ensureConnected(signal);
    // Headed windows keep the user's size; headless pages get the configured viewport.
    const promise = Tab.attach(
      connection,
      page,
      page.tabId,
      page.openedByAgent,
      signal,
      this.options.headless ? this.options.viewport : undefined,
    )
      .then(async (tab) => {
        // Only one window has focus, and a sub-task's window rarely does; pages
        // that check focus (blur validation, focus-gated widgets) must still work.
        if (page.owner !== MAIN)
          await tab.session
            .send(
              "Emulation.setFocusEmulationEnabled",
              { enabled: true },
              { signal, timeoutMs: 3_000 },
            )
            .catch(() => {});
        this.attached.set(targetId, tab);
        return tab;
      })
      .finally(() => this.shared.attaching.delete(targetId));
    this.shared.attaching.set(targetId, promise);
    return promise;
  }

  async activeTab(signal?: AbortSignal): Promise<Tab> {
    await this.ensureConnected(signal);
    if (this.activeTargetId && this.pages.has(this.activeTargetId)) {
      this.touch(this.activeTargetId);
      const tab = await this.attach(this.activeTargetId, signal);
      if (tab.crashed) await this.recoverCrashed(tab, signal);
      return tab;
    }
    // The main agent starts in the browser's empty tab; a sub-task in a window of its own.
    const blank =
      this.laneId === MAIN
        ? [...this.pages.values()].find((page) => this.own(page) && BLANK_URLS.has(page.url))
        : undefined;
    if (blank) {
      blank.openedByAgent = true;
      this.activeTargetId = blank.targetId;
      return this.attach(blank.targetId, signal);
    }
    return this.openTab(undefined, signal);
  }

  // A background tab gets no frames, so Chrome never acks its mouse input and
  // screenshots stall; bring the agent's tab to the front before acting.
  async ensureForeground(tab: Tab, signal?: AbortSignal): Promise<void> {
    // Scripts do not run while a JS dialog is open.
    if (tab.dialog) return;
    const contextId = await tab.frames
      .isolatedWorld(tab.frames.mainFrameId ?? "", signal)
      .catch(() => undefined);
    if (contextId === undefined) return;
    const state = await tab.session
      .send(
        "Runtime.evaluate",
        { expression: "document.visibilityState", contextId, returnByValue: true },
        { signal, timeoutMs: 3_000 },
      )
      .catch(() => undefined);
    if (state?.result.value !== "hidden") return;
    await tab.session
      .send("Page.bringToFront", undefined, { signal, timeoutMs: 3_000 })
      .catch(() => {});
  }

  private async recoverCrashed(tab: Tab, signal?: AbortSignal): Promise<void> {
    tab.crashed = false;
    this.notices.push(`Tab ${tab.tabId} crashed and was reloaded.`);
    await tab.session.send("Page.reload", {}, { signal }).catch(() => {});
  }

  // Keeps the user's window tidy: past MAX_AGENT_TABS, this agent's tab used least
  // recently is closed (never a tab the user opened or another lane's) and the agent is told.
  private async closeStaleAgentTab(signal?: AbortSignal): Promise<void> {
    const agentTabs = [...this.pages.values()].filter(
      (page) => page.openedByAgent && this.own(page),
    );
    if (agentTabs.length < MAX_AGENT_TABS) return;
    const stale = agentTabs
      .filter((page) => page.targetId !== this.activeTargetId)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!stale) return;
    await this.connection
      ?.send("Target.closeTarget", { targetId: stale.targetId }, { signal, timeoutMs: 3_000 })
      .catch(() => {});
    this.forgetTarget(stale.targetId);
    this.notices.push(
      `Closed tab ${stale.tabId} (${stale.url}) to keep at most ${MAX_AGENT_TABS} agent tabs open; reopen it if you still need it.`,
    );
  }

  private touch(targetId: string): void {
    const page = this.pages.get(targetId);
    if (page) page.lastUsed = Date.now();
  }

  async openTab(url?: string, signal?: AbortSignal): Promise<Tab> {
    const connection = await this.ensureConnected(signal);
    await this.closeStaleAgentTab(signal);
    const params =
      this.laneId === MAIN
        ? { url: url ?? "about:blank" }
        : { url: url ?? `about:blank#mu-${this.laneId}`, newWindow: true };
    const { targetId } = await connection.send("Target.createTarget", params, { signal });
    if (!this.pages.has(targetId)) {
      this.trackTarget({
        targetId,
        type: "page",
        url: params.url,
        title: "",
        attached: false,
        canAccessOpener: false,
      });
    }
    const page = this.pages.get(targetId);
    if (page) {
      page.openedByAgent = true;
      page.owner = this.laneId;
    }
    this.activeTargetId = targetId;
    this.touch(targetId);
    return this.attach(targetId, signal);
  }

  private targetFor(tabId: string): PageTarget {
    const page = [...this.pages.values()].find((candidate) => candidate.tabId === tabId);
    if (page && !this.own(page)) {
      const lane = [...this.shared.lanes].find((candidate) => candidate.laneId === page.owner);
      throw new Error(
        `Tab ${tabId} belongs to ${lane?.label ? `the sub-task "${lane.label}"` : "the main agent"}; use your own tabs`,
      );
    }
    if (!page) {
      const known = this.tabs()
        .map((tab) => tab.tabId)
        .join(", ");
      throw new Error(`No tab "${tabId}". Open tabs: ${known || "none"}`);
    }
    return page;
  }

  async switchTab(tabId: string, signal?: AbortSignal): Promise<Tab> {
    const connection = await this.ensureConnected(signal);
    const page = this.targetFor(tabId);
    this.activeTargetId = page.targetId;
    this.touch(page.targetId);
    await connection
      .send("Target.activateTarget", { targetId: page.targetId }, { signal })
      .catch((error: unknown) => {
        if (!isCdpError(error, "protocol")) throw error;
      });
    return this.attach(page.targetId, signal);
  }

  async closeTab(tabId: string, signal?: AbortSignal): Promise<void> {
    const connection = await this.ensureConnected(signal);
    const page = this.targetFor(tabId);
    await connection.send("Target.closeTarget", { targetId: page.targetId }, { signal });
    const wasActive = this.activeTargetId === page.targetId;
    if (wasActive) this.activeTargetId = undefined;
    this.forgetTarget(page.targetId);
    if (wasActive) {
      const remaining = [...this.pages.values()]
        .filter((candidate) => this.own(candidate))
        .sort(
          (a, b) => Number(b.openedByAgent) - Number(a.openedByAgent) || b.createdAt - a.createdAt,
        );
      this.activeTargetId = remaining[0]?.targetId;
    }
    this.notices = this.notices.filter((notice) => notice !== "The active tab was closed.");
  }

  // A lane for one parallel sub-task, once fewer than MAX_LANES are running.
  async openLane(label: string, signal: AbortSignal): Promise<BrowserManager> {
    const running = () => [...this.shared.lanes].filter((lane) => lane.laneId !== MAIN).length;
    while (running() >= MAX_LANES) await this.laneFreed(signal);
    return new BrowserManager(this.options, this.shared, {
      id: `lane-${this.shared.nextLane++}`,
      label,
    });
  }

  private laneFreed(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.shared.waiting.delete(freed);
        reject(signal.reason ?? new Error("cancelled"));
      };
      const freed = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      if (signal.aborted) return onAbort();
      this.shared.waiting.add(freed);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // Ends a sub-task's lane: empty tabs close; tabs it left open stay for the user,
  // listed for the main agent as left by that sub-task.
  async release(): Promise<void> {
    if (this.laneId === MAIN || !this.shared.lanes.delete(this)) return;
    const empty: string[] = [];
    for (const page of this.pages.values()) {
      if (!this.own(page)) continue;
      if (LANE_MARK.test(page.url) || BLANK_URLS.has(page.url)) {
        empty.push(page.targetId);
        continue;
      }
      page.owner = MAIN;
      page.openedByAgent = false;
      page.leftBy = this.label;
    }
    await Promise.all(
      empty.map((targetId) =>
        this.connection
          ?.send("Target.closeTarget", { targetId }, { timeoutMs: 3_000 })
          .catch(() => {}),
      ),
    );
    const [next] = this.shared.waiting;
    if (next) {
      this.shared.waiting.delete(next);
      next();
    }
  }

  status(): BrowserStatus {
    const active = this.tabs().find((tab) => tab.active);
    const endpoint = this.shared.connected?.endpoint;
    return {
      mode: this.options.connect,
      profile: this.options.profileName,
      ...(this.options.connect === "managed" ? { userDataDir: this.options.userDataDir } : {}),
      ...(endpoint ? { endpoint: endpoint.wsUrl } : {}),
      connected: this.isConnected,
      launched: endpoint?.launched ?? false,
      ...(endpoint?.pid ? { pid: endpoint.pid } : {}),
      ...(this.shared.product ?? {}),
      headless: this.options.headless,
      tabs: this.tabs().length,
      ...(active ? { activeTab: active } : {}),
    };
  }

  async shutdown(options: { close?: boolean } = {}): Promise<void> {
    if (this.laneId !== MAIN) return this.release();
    this.stop();
    const shared = this.shared;
    const connected = shared.connected;
    if (!connected) return;
    const close = options.close ?? !this.options.keepOpen;
    shared.closingIntentionally = true;
    const { connection } = connected;
    const timeouts = { timeoutMs: 2_000 };
    if (close && this.options.connect === "managed") {
      await connection.send("Browser.close", undefined, timeouts).catch(() => {});
    } else if (close) {
      await Promise.all(
        [...this.pages.values()]
          .filter((page) => page.openedByAgent)
          .map((page) =>
            connection
              .send("Target.closeTarget", { targetId: page.targetId }, timeouts)
              .catch(() => {}),
          ),
      );
    } else {
      await Promise.all(
        [...this.attached.values()].map((tab) => {
          tab.dispose();
          return tab.session.detach();
        }),
      );
    }
    await connection.close();
    shared.connected = undefined;
    this.attached.clear();
    for (const lane of shared.lanes) lane.activeTargetId = undefined;
  }
}

export function isDisconnectError(error: unknown): boolean {
  return error instanceof CdpError && error.kind === "target-closed";
}
