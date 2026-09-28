import { type CdpConnection, CdpError, isCdpError } from "../cdp/connection.ts";
import type { Protocol } from "../cdp/types.ts";
import {
  type BrowserLauncher,
  type ConnectedBrowser,
  connectManaged,
  connectToEndpoint,
} from "./connect.ts";
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
}

const BLANK_URLS = new Set(["about:blank", "chrome://newtab/", "chrome://new-tab-page/", ""]);

// Owns the one browser connection of a session: lazy connect, tab tracking,
// the active tab the agent operates on, and recovery after disconnects.
export class BrowserManager {
  private connected: ConnectedBrowser | undefined;
  private connecting: Promise<ConnectedBrowser> | undefined;
  private readonly pages = new Map<string, PageTarget>();
  private readonly attached = new Map<string, Tab>();
  private readonly attaching = new Map<string, Promise<Tab>>();
  private readonly tabIds = new Map<string, string>();
  private nextTab = 1;
  private activeTargetId: string | undefined;
  private notices: string[] = [];
  private closingIntentionally = false;
  private product: { product: string; version: string; executable?: string } | undefined;
  private abort = new AbortController();

  constructor(readonly options: BrowserManagerOptions) {}

  get isConnected(): boolean {
    return this.connected !== undefined && !this.connected.connection.isClosed;
  }

  get connection(): CdpConnection | undefined {
    return this.connected?.connection;
  }

  // Combines a tool's signal with the manager's stop signal.
  actionSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
  }

  stop(): void {
    this.abort.abort();
    this.abort = new AbortController();
  }

  drainNotices(): string[] {
    const notices = this.notices;
    this.notices = [];
    return notices;
  }

  async ensureConnected(signal?: AbortSignal): Promise<CdpConnection> {
    if (this.isConnected && this.connected) return this.connected.connection;
    if (!this.connecting) {
      this.connecting = this.connect(signal).finally(() => {
        this.connecting = undefined;
      });
    }
    return (await this.connecting).connection;
  }

  private async connect(signal?: AbortSignal): Promise<ConnectedBrowser> {
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
    this.closingIntentionally = false;
    this.pages.clear();
    this.attached.clear();
    this.activeTargetId = undefined;
    connection.on("Target.targetCreated", (event) => this.trackTarget(event.targetInfo));
    connection.on("Target.targetInfoChanged", (event) => this.trackTarget(event.targetInfo));
    connection.on("Target.targetDestroyed", (event) => this.forgetTarget(event.targetId));
    void connection.closed.then(({ reason }) => this.onDisconnect(connection, reason));
    try {
      const [version, { targetInfos }] = await Promise.all([
        connection.send("Browser.getVersion", undefined, { signal }),
        connection.send("Target.getTargets", undefined, { signal }),
        connection.send("Target.setDiscoverTargets", { discover: true }, { signal }),
      ]);
      for (const info of targetInfos) this.trackTarget(info);
      const [product, number] = version.product.split("/");
      this.product = {
        product: connected.browser?.product ?? product ?? version.product,
        version: number ?? connected.browser?.version ?? "unknown",
        ...(connected.browser ? { executable: connected.browser.path } : {}),
      };
    } catch (error) {
      await connection.close();
      throw error;
    }
    this.connected = connected;
    return connected;
  }

  private requireCdpUrl(): string {
    if (!this.options.cdpUrl) throw new Error("connect: cdp requires a cdpUrl");
    return this.options.cdpUrl;
  }

  private onDisconnect(connection: CdpConnection, reason: string): void {
    if (this.connected?.connection !== connection) return;
    this.connected = undefined;
    for (const tab of this.attached.values()) tab.dispose();
    this.attached.clear();
    this.activeTargetId = undefined;
    if (!this.closingIntentionally) {
      this.notices.push(
        `The browser disconnected (${reason}); it was reconnected for this action. Open tabs may have changed — check the page before continuing.`,
      );
    }
  }

  private tabIdFor(targetId: string): string {
    let tabId = this.tabIds.get(targetId);
    if (!tabId) {
      tabId = `t${this.nextTab++}`;
      this.tabIds.set(targetId, tabId);
    }
    return tabId;
  }

  private trackTarget(info: Protocol.Target.TargetInfo): void {
    if (info.type !== "page") return;
    const existing = this.pages.get(info.targetId);
    const page: PageTarget = {
      targetId: info.targetId,
      tabId: this.tabIdFor(info.targetId),
      url: info.url,
      title: info.title,
      openerId: info.openerId ?? existing?.openerId,
      openedByAgent: existing?.openedByAgent ?? false,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.pages.set(info.targetId, page);
    const tab = this.attached.get(info.targetId);
    if (tab) {
      tab.url = info.url;
      tab.title = info.title;
    }
  }

  private forgetTarget(targetId: string): void {
    this.pages.delete(targetId);
    this.attached.get(targetId)?.dispose();
    this.attached.delete(targetId);
    if (this.activeTargetId === targetId) {
      this.activeTargetId = undefined;
      this.notices.push("The active tab was closed.");
    }
  }

  tabs(): TabInfo[] {
    return [...this.pages.values()].map((page) => {
      const tab = this.attached.get(page.targetId);
      return {
        tabId: page.tabId,
        url: tab?.url ?? page.url,
        title: tab?.title ?? page.title,
        active: page.targetId === this.activeTargetId,
        openedByAgent: page.openedByAgent,
      };
    });
  }

  // Pages opened after `since` by one of the given tabs (popups, target=_blank).
  openedSince(since: number, openerTargetIds: string[]): TabInfo[] {
    return [...this.pages.values()]
      .filter(
        (page) =>
          page.createdAt >= since && page.openerId && openerTargetIds.includes(page.openerId),
      )
      .map((page) => ({
        tabId: page.tabId,
        url: page.url,
        title: page.title,
        active: page.targetId === this.activeTargetId,
        openedByAgent: page.openedByAgent,
      }));
  }

  private async attach(targetId: string, signal?: AbortSignal): Promise<Tab> {
    const existing = this.attached.get(targetId);
    if (existing && !existing.detached) return existing;
    const pending = this.attaching.get(targetId);
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
      .then((tab) => {
        this.attached.set(targetId, tab);
        return tab;
      })
      .finally(() => this.attaching.delete(targetId));
    this.attaching.set(targetId, promise);
    return promise;
  }

  async activeTab(signal?: AbortSignal): Promise<Tab> {
    await this.ensureConnected(signal);
    if (this.activeTargetId && this.pages.has(this.activeTargetId)) {
      const tab = await this.attach(this.activeTargetId, signal);
      if (tab.crashed) await this.recoverCrashed(tab, signal);
      return tab;
    }
    const blank = [...this.pages.values()].find((page) => BLANK_URLS.has(page.url));
    if (blank) {
      blank.openedByAgent = true;
      this.activeTargetId = blank.targetId;
      return this.attach(blank.targetId, signal);
    }
    return this.openTab(undefined, signal);
  }

  private async recoverCrashed(tab: Tab, signal?: AbortSignal): Promise<void> {
    tab.crashed = false;
    this.notices.push(`Tab ${tab.tabId} crashed and was reloaded.`);
    await tab.session.send("Page.reload", {}, { signal }).catch(() => {});
  }

  async openTab(url?: string, signal?: AbortSignal): Promise<Tab> {
    const connection = await this.ensureConnected(signal);
    const { targetId } = await connection.send(
      "Target.createTarget",
      { url: url ?? "about:blank" },
      { signal },
    );
    if (!this.pages.has(targetId)) {
      this.trackTarget({
        targetId,
        type: "page",
        url: url ?? "about:blank",
        title: "",
        attached: false,
        canAccessOpener: false,
      });
    }
    const page = this.pages.get(targetId);
    if (page) page.openedByAgent = true;
    this.activeTargetId = targetId;
    return this.attach(targetId, signal);
  }

  private targetFor(tabId: string): PageTarget {
    const page = [...this.pages.values()].find((candidate) => candidate.tabId === tabId);
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
      const remaining = [...this.pages.values()].sort(
        (a, b) => Number(b.openedByAgent) - Number(a.openedByAgent) || b.createdAt - a.createdAt,
      );
      this.activeTargetId = remaining[0]?.targetId;
    }
    this.notices = this.notices.filter((notice) => notice !== "The active tab was closed.");
  }

  status(): BrowserStatus {
    const active = this.tabs().find((tab) => tab.active);
    const endpoint = this.connected?.endpoint;
    return {
      mode: this.options.connect,
      profile: this.options.profileName,
      ...(this.options.connect === "managed" ? { userDataDir: this.options.userDataDir } : {}),
      ...(endpoint ? { endpoint: endpoint.wsUrl } : {}),
      connected: this.isConnected,
      launched: endpoint?.launched ?? false,
      ...(endpoint?.pid ? { pid: endpoint.pid } : {}),
      ...(this.product ?? {}),
      headless: this.options.headless,
      tabs: this.pages.size,
      ...(active ? { activeTab: active } : {}),
    };
  }

  async shutdown(options: { close?: boolean } = {}): Promise<void> {
    this.stop();
    const connected = this.connected;
    if (!connected) return;
    const close = options.close ?? !this.options.keepOpen;
    this.closingIntentionally = true;
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
    this.connected = undefined;
    this.attached.clear();
    this.activeTargetId = undefined;
  }
}

export function isDisconnectError(error: unknown): boolean {
  return error instanceof CdpError && error.kind === "target-closed";
}
