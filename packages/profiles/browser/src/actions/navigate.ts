import type { Tab } from "../browser/tabs.ts";
import { type SettleWatcher, watchSettle } from "../page/settle.ts";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT = /^[\w.-]+:\d+(?:[/?#]|$)/;
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
// file:, view-source:, chrome: and the like would expose local files and browser
// internals that the file tools and upload checks keep out of the agent's reach.
const WEB_SCHEMES = new Set(["http:", "https:"]);

export function normalizeUrl(input: string): string {
  const url = input.trim();
  if (!url) throw new Error("navigate needs a URL");
  if (LOCAL.test(url)) return `http://${url}`;
  if (HOST_PORT.test(url)) return `http://${url}`;
  if (SCHEME.test(url)) {
    if (url.toLowerCase() === "about:blank") return url;
    const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase();
    if (!WEB_SCHEMES.has(scheme)) {
      throw new Error(
        `"${input}" is not a web page: the browser only opens http and https URLs (and about:blank). Read files in your folder with read.`,
      );
    }
    return url;
  }
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
  ms: number;
}

async function settleAfter(
  tab: Tab,
  trigger: (watcher: SettleWatcher) => Promise<"same-document" | undefined>,
  signal?: AbortSignal,
): Promise<NavigationResult> {
  const watcher = watchSettle(tab, "navigation");
  try {
    if ((await trigger(watcher)) === "same-document") {
      watcher.dispose();
      return { settle: "same-document navigation", sameDocument: true, ms: 0 };
    }
  } catch (error) {
    watcher.dispose();
    throw error;
  }
  const result = await watcher.settle(signal);
  return {
    settle: `${result.reason} (${result.ms} ms)`,
    sameDocument: result.reason === "same-document navigation",
    ms: result.ms,
  };
}

export async function navigateTo(
  tab: Tab,
  url: string,
  signal?: AbortSignal,
): Promise<NavigationResult> {
  return settleAfter(
    tab,
    async () => {
      const result = await tab.session.send("Page.navigate", { url }, { signal });
      if (result.errorText && result.errorText !== "net::ERR_ABORTED") {
        throw new Error(`Navigation failed: ${result.errorText}`);
      }
      return result.loaderId ? undefined : "same-document";
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
  return settleAfter(
    tab,
    async () => {
      await tab.session.send("Page.navigateToHistoryEntry", { entryId: entry.id }, { signal });
      return undefined;
    },
    signal,
  );
}

export async function reload(tab: Tab, signal?: AbortSignal): Promise<NavigationResult> {
  return settleAfter(
    tab,
    async () => {
      await tab.session.send("Page.reload", {}, { signal });
      return undefined;
    },
    signal,
  );
}
