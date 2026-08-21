// The session-owned browser connection. It is the only thing that holds a driver,
// the only thing that moves the connection phase, and the only thing that decides
// whether shutdown detaches from a browser or closes one.
import type { ProfileRuntime, ProfileRuntimeHost } from "@mu/core";
import type {
  BrowserConnectionMode,
  BrowserConnectionState,
  BrowserFamily,
} from "../contracts/connection.ts";
import type { BrowserDriver } from "../contracts/driver.ts";
import { BrowserDriverError, isBrowserDriverError } from "../contracts/driver.ts";
import type { BrowserObservation } from "../contracts/observation.ts";
import type { BrowserSecret } from "../contracts/secret.ts";
import type { TakeoverReason } from "../contracts/takeover.ts";
import type {
  BrowserDriverFactory,
  BrowserDriverHandle,
  BrowserDriverOwnership,
} from "../drivers/factory.ts";
import { type BrowserRuntimeTrigger, nextPhase, phaseSummary } from "./state.ts";

// Bounded so a flapping connection cannot grow without limit inside a session.
const MAX_JOURNAL_ENTRIES = 50;

export interface BrowserRuntimeOptions {
  factory: BrowserDriverFactory;
  connection: BrowserConnectionMode;
  browser: BrowserFamily;
  dataRoot: string;
  headless?: boolean | undefined;
  userDataDir?: string | undefined;
  extensionToken?: BrowserSecret | undefined;
  now?: (() => number) | undefined;
}

export interface BrowserRuntimeJournalEntry {
  phase: BrowserConnectionState["phase"];
  at: number;
  message?: string;
}

export type BrowserRuntimeListener = (state: BrowserConnectionState) => void;

export class BrowserRuntime implements ProfileRuntime {
  private handle: BrowserDriverHandle | undefined;
  private phase: BrowserConnectionState["phase"] = "disconnected";
  private note: string | undefined;
  private host: ProfileRuntimeHost | undefined;
  private controller: AbortController | undefined;
  private connecting: Promise<BrowserDriver> | undefined;
  private readonly listeners = new Set<BrowserRuntimeListener>();
  private readonly entries: BrowserRuntimeJournalEntry[] = [];
  private readonly now: () => number;

  constructor(private readonly options: BrowserRuntimeOptions) {
    this.now = options.now ?? (() => Date.now());
    this.record();
  }

  attach(host: ProfileRuntimeHost): void {
    this.host = host;
  }

  subscribe(listener: BrowserRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get journal(): readonly BrowserRuntimeJournalEntry[] {
    return this.entries;
  }

  get ownership(): BrowserDriverOwnership | undefined {
    return this.handle?.ownership;
  }

  get description(): string {
    return this.handle?.description ?? `${this.options.browser} (${this.options.connection})`;
  }

  status(): BrowserConnectionState {
    const reported = this.handle?.driver.status();
    return {
      phase: this.phase,
      mode: this.options.connection,
      browser: this.options.browser,
      ...(reported?.connectionId === undefined ? {} : { connectionId: reported.connectionId }),
      ...(reported?.activeTabId === undefined ? {} : { activeTabId: reported.activeTabId }),
      ...(this.note === undefined ? {} : { message: this.note }),
      ...(reported?.approvalRequired === true ? { approvalRequired: true } : {}),
      updatedAt: this.now(),
    };
  }

  // The connection is lazy: starting the product without a browser must not fail
  // (ARCHITECTURE §13). Concurrent callers share one attempt.
  async connect(signal: AbortSignal): Promise<BrowserDriver> {
    // An open connection is never re-opened. Reconnecting after a drop is
    // `reconnect()`; re-entering `connect()` here would silently discard a
    // takeover, a live tab set and every reference minted against it.
    if (this.handle && (this.phase === "ready" || this.phase === "takeover")) {
      return this.handle.driver;
    }
    if (this.connecting) return this.connecting;
    this.connecting = this.openConnection(signal).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openConnection(signal: AbortSignal): Promise<BrowserDriver> {
    this.transition("connect");
    this.controller = new AbortController();
    const linked = this.controller;
    const forward = () => linked.abort(signal.reason);
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
    try {
      const handle =
        this.handle ??
        (await this.options.factory(
          {
            connection: this.options.connection,
            browser: this.options.browser,
            dataRoot: this.options.dataRoot,
            ...(this.options.headless === undefined ? {} : { headless: this.options.headless }),
            ...(this.options.userDataDir === undefined
              ? {}
              : { userDataDir: this.options.userDataDir }),
            ...(this.options.extensionToken === undefined
              ? {}
              : { extensionToken: this.options.extensionToken }),
          },
          linked.signal,
        ));
      this.handle = handle;
      await handle.driver.connect(
        {
          mode: this.options.connection,
          browser: this.options.browser,
          ...(this.options.headless === undefined ? {} : { headless: this.options.headless }),
          ...(this.options.userDataDir === undefined
            ? {}
            : { userDataDir: this.options.userDataDir }),
          ...(this.options.extensionToken === undefined
            ? {}
            : { extensionToken: this.options.extensionToken }),
        },
        linked.signal,
      );
      this.transition("approved", `connected to ${handle.description}`);
      return handle.driver;
    } catch (error) {
      const code = isBrowserDriverError(error) ? error.code : undefined;
      const detail = error instanceof Error ? error.message : String(error);
      if (code === "approval-required") this.transition("rejected", detail);
      else if (code === "aborted") this.transition("rejected", "the connection was cancelled");
      else this.transition("failed", detail);
      throw error;
    } finally {
      signal.removeEventListener("abort", forward);
      this.controller = undefined;
    }
  }

  // Every driver call the profile makes goes through here so a lost connection,
  // a takeover and a cancelled operation are classified in exactly one place.
  async use<T>(operation: (driver: BrowserDriver) => Promise<T>, signal: AbortSignal): Promise<T> {
    const driver = await this.connect(signal);
    if (this.phase !== "ready") {
      throw new BrowserDriverError(
        "unsupported",
        `the browser is ${this.phase}: ${phaseSummary(this.phase)}`,
      );
    }
    try {
      return await operation(driver);
    } catch (error) {
      if (isBrowserDriverError(error) && error.reconnectable) {
        this.transition("bridge-lost", error.message);
        this.host?.followUp(
          `The browser connection was lost (${error.message}). Reconnect before acting again.`,
        );
      }
      throw error;
    }
  }

  async takeover(reason: TakeoverReason, instructions: string): Promise<void> {
    if (!this.handle) throw new BrowserDriverError("not-connected", "no browser is connected");
    await this.handle.driver.takeover(reason);
    this.transition("takeover", instructions);
  }

  // Resuming always re-observes; the fresh observation carries a new revision, so
  // every reference minted before the user took over is already invalid.
  async resume(signal: AbortSignal): Promise<BrowserObservation> {
    if (!this.handle) throw new BrowserDriverError("not-connected", "no browser is connected");
    const observation = await this.handle.driver.resumeFromTakeover(signal);
    this.transition("resumed", `re-observed at revision ${observation.revision}`);
    return observation;
  }

  async reconnect(signal: AbortSignal): Promise<BrowserDriver> {
    if (this.phase === "ready") this.transition("bridge-lost", "reconnecting on request");
    if (!this.handle) return this.connect(signal);
    try {
      await this.handle.driver.connect(
        { mode: this.options.connection, browser: this.options.browser },
        signal,
      );
      this.transition("reconnected", "the browser connection was re-established");
      return this.handle.driver;
    } catch (error) {
      const code = isBrowserDriverError(error) ? error.code : undefined;
      this.transition(
        code === "approval-required" ? "approval-required" : "timed-out",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  // Synchronous: cancels the operation in flight and leaves the connection reusable.
  stop(): void {
    this.controller?.abort(new Error("cancelled"));
  }

  // BD29: detach from a browser Mu attached to, close one Mu owns — and in both
  // cases await the release before returning.
  async shutdown(): Promise<void> {
    const handle = this.handle;
    if (!handle) {
      this.phase = "disconnected";
      return;
    }
    this.transition("shutdown");
    this.handle = undefined;
    try {
      await handle.driver.disconnect();
    } finally {
      await handle.dispose();
      this.transition(
        "closed",
        handle.ownership === "owned"
          ? "closed the browser Mu owns"
          : "detached without closing your browser",
      );
    }
  }

  private transition(trigger: BrowserRuntimeTrigger, message?: string): void {
    const next = nextPhase(this.phase, trigger);
    if (next === undefined) return;
    this.phase = next;
    this.note = message;
    this.record(message);
  }

  private record(message?: string): void {
    this.entries.push({
      phase: this.phase,
      at: this.now(),
      ...(message === undefined ? {} : { message }),
    });
    if (this.entries.length > MAX_JOURNAL_ENTRIES) this.entries.shift();
    const state = this.status();
    for (const listener of this.listeners) listener(state);
  }
}
