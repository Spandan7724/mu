import type { Tab } from "../browser/tabs.ts";
import { CdpError } from "../cdp/connection.ts";

export const NAVIGATION_CAP_MS = 10_000;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT = /^[\w.-]+:\d+(?:[/?#]|$)/;
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

export function normalizeUrl(input: string): string {
  const url = input.trim();
  if (!url) throw new Error("navigate needs a URL");
  if (LOCAL.test(url)) return `http://${url}`;
  if (HOST_PORT.test(url)) return `http://${url}`;
  if (SCHEME.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  const host = url.split(/[/?#]/, 1)[0] ?? "";
  if (/\s/.test(url) || !host.includes(".")) {
    throw new Error(
      `"${input}" is not a URL. Pass a full URL or a domain such as example.com; to search, navigate to a search engine URL.`,
    );
  }
  return `https://${url}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export interface NavigationResult {
  settle: string;
  sameDocument: boolean;
}

interface Trigger {
  loaderId?: string | undefined;
  errorText?: string | undefined;
}

// Runs a navigation trigger and waits, event-driven, until the main frame's new
// document reaches DOMContentLoaded (capped; a cap is reported, not thrown).
export async function runNavigation(
  tab: Tab,
  trigger: () => Promise<Trigger | undefined>,
  signal?: AbortSignal,
  capMs = NAVIGATION_CAP_MS,
): Promise<NavigationResult> {
  const started = performance.now();
  const loaded = new Set<string>();
  let navigatedLoader: string | undefined;
  let sameDocument = false;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  const isMain = (frameId: string) => frameId === tab.frames.mainFrameId;
  const offs = [
    tab.session.on("Page.lifecycleEvent", (event) => {
      if (event.name === "DOMContentLoaded" && isMain(event.frameId)) {
        loaded.add(event.loaderId);
        notify();
      }
    }),
    tab.session.on("Page.frameNavigated", (event) => {
      if (event.frame.parentId) return;
      navigatedLoader = event.frame.loaderId;
      if (event.type === "BackForwardCacheRestore") loaded.add(event.frame.loaderId);
      notify();
    }),
    tab.session.on("Page.navigatedWithinDocument", (event) => {
      if (!isMain(event.frameId)) return;
      sameDocument = true;
      notify();
    }),
  ];
  try {
    const result = await trigger();
    if (result?.errorText && result.errorText !== "net::ERR_ABORTED") {
      throw new Error(`Navigation failed: ${result.errorText}`);
    }
    const expected = () => result?.loaderId ?? navigatedLoader;
    const done = () => {
      const loader = expected();
      if (loader) return loaded.has(loader);
      return sameDocument;
    };
    if (!result?.loaderId && result !== undefined && !result.errorText) sameDocument = true;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        wake = undefined;
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new CdpError("aborted", "navigate", "aborted"));
      const remaining = Math.max(0, capMs - (performance.now() - started));
      const timer = setTimeout(() => finish(), remaining);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      wake = () => {
        if (done()) finish();
      };
      wake();
    });
    const elapsed = Math.round(performance.now() - started);
    if (!done()) {
      return { settle: `navigation not finished after ${capMs} ms; observed anyway`, sameDocument };
    }
    return {
      settle:
        sameDocument && !expected()
          ? "same-document navigation"
          : `DOMContentLoaded in ${elapsed} ms`,
      sameDocument: sameDocument && !expected(),
    };
  } finally {
    for (const off of offs) off();
  }
}

export async function navigateTo(tab: Tab, url: string, signal?: AbortSignal) {
  return runNavigation(
    tab,
    async () => {
      const result = await tab.session.send("Page.navigate", { url }, { signal });
      return { loaderId: result.loaderId, errorText: result.errorText };
    },
    signal,
  );
}

export async function goHistory(
  tab: Tab,
  delta: -1 | 1,
  signal?: AbortSignal,
): Promise<NavigationResult | undefined> {
  const history = await tab.session.send("Page.getNavigationHistory", undefined, { signal });
  const entry = history.entries[history.currentIndex + delta];
  if (!entry) return undefined;
  return runNavigation(
    tab,
    async () => {
      await tab.session.send("Page.navigateToHistoryEntry", { entryId: entry.id }, { signal });
      return undefined;
    },
    signal,
  );
}

export async function reload(tab: Tab, signal?: AbortSignal): Promise<NavigationResult> {
  return runNavigation(
    tab,
    async () => {
      await tab.session.send("Page.reload", {}, { signal });
      return undefined;
    },
    signal,
  );
}
