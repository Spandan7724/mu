import type { Tab } from "../browser/tabs.ts";
import { CdpError, isCdpError } from "../cdp/connection.ts";

export type SettleMode = "in-page" | "typing" | "navigation";

interface Profile {
  // Time allowed for a triggered request or navigation to start.
  graceMs: number;
  domQuietMs: number;
  networkQuietMs: number;
  capMs: number;
}

const PROFILES: Record<SettleMode, Profile> = {
  "in-page": { graceMs: 100, domQuietMs: 150, networkQuietMs: 150, capMs: 2_500 },
  // Autocomplete widgets debounce before fetching suggestions.
  typing: { graceMs: 350, domQuietMs: 250, networkQuietMs: 150, capMs: 2_500 },
  navigation: { graceMs: 100, domQuietMs: 200, networkQuietMs: 300, capMs: 10_000 },
};

const LONG_POLL_MS = 1_500;

export interface SettleResult {
  ms: number;
  reason: string;
  navigated: boolean;
  changed: boolean;
}

// In the page: resolves once no structural mutation happened for `quiet` ms.
// Style-attribute churn (animations, carousels) does not count.
const DOM_QUIET = `(function (quiet, cap) {
  return new Promise(function (resolve) {
    var changed = false, timer, capTimer, observer;
    function done(reason) {
      if (observer) observer.disconnect();
      clearTimeout(timer); clearTimeout(capTimer);
      resolve({ changed: changed, reason: reason });
    }
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].type !== "attributes" || records[i].attributeName !== "style") {
          changed = true; clearTimeout(timer); timer = setTimeout(function () { done("quiet"); }, quiet);
          return;
        }
      }
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    timer = setTimeout(function () { done("quiet"); }, quiet);
    capTimer = setTimeout(function () { done("cap"); }, cap);
  });
})`;

export interface SettleWatcher {
  settle(signal?: AbortSignal): Promise<SettleResult>;
  dispose(): void;
}

// Start before the action so navigations and requests it triggers are seen.
export function watchSettle(tab: Tab, mode: SettleMode = "in-page"): SettleWatcher {
  let profile = PROFILES[mode];
  let navigationStarted = mode === "navigation";
  let navigatedLoader: string | undefined;
  const loaded = new Set<string>();
  let dialog = false;
  let sameDocument = false;
  let stoppedWithoutCommit = false;
  let networkChanged = false;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  const isMain = (frameId: string) => frameId === tab.frames.mainFrameId;
  const offs = [
    tab.session.on("Page.frameStartedNavigating", (event) => {
      if (!isMain(event.frameId)) return;
      if (event.navigationType === "sameDocument" || event.navigationType === "historySameDocument")
        return;
      navigationStarted = true;
      notify();
    }),
    tab.session.on("Page.frameRequestedNavigation", (event) => {
      if (!isMain(event.frameId) || event.disposition !== "currentTab") return;
      navigationStarted = true;
      notify();
    }),
    tab.session.on("Page.frameNavigated", (event) => {
      if (event.frame.parentId) return;
      navigationStarted = true;
      navigatedLoader = event.frame.loaderId;
      if (event.type === "BackForwardCacheRestore") loaded.add(event.frame.loaderId);
      notify();
    }),
    tab.session.on("Page.lifecycleEvent", (event) => {
      if (event.name === "DOMContentLoaded" && isMain(event.frameId)) {
        loaded.add(event.loaderId);
        notify();
      }
    }),
    tab.session.on("Page.navigatedWithinDocument", (event) => {
      if (!isMain(event.frameId)) return;
      sameDocument = true;
      notify();
    }),
    // A navigation that becomes a download (or is cancelled) stops without committing.
    tab.session.on("Page.frameStoppedLoading", (event) => {
      if (!isMain(event.frameId) || navigatedLoader) return;
      stoppedWithoutCommit = true;
      notify();
    }),
    tab.session.on("Page.javascriptDialogOpening", () => {
      dialog = true;
      notify();
    }),
    tab.network.onChange(() => {
      networkChanged = true;
      notify();
    }),
  ];
  const dispose = () => {
    for (const off of offs.splice(0)) off();
  };

  const settle = async (signal?: AbortSignal): Promise<SettleResult> => {
    const actionEnd = performance.now();
    let domChanged = false;
    let domQuiet = false;
    let domGeneration = 0;
    let navigated = false;
    let navigationDomStarted = false;
    const runDomQuiet = (quiet: number, cap: number) => {
      const generation = ++domGeneration;
      domQuiet = false;
      void (async () => {
        try {
          const contextId = await tab.frames.isolatedWorld(tab.frames.mainFrameId ?? "", signal);
          const result = await tab.session.send(
            "Runtime.evaluate",
            {
              expression: `${DOM_QUIET}(${quiet}, ${cap})`,
              contextId,
              awaitPromise: true,
              returnByValue: true,
            },
            { signal, timeoutMs: cap + 1_000 },
          );
          if (generation !== domGeneration) return;
          const value = result.result.value as { changed?: boolean } | undefined;
          if (value?.changed) domChanged = true;
        } catch (error) {
          if (generation !== domGeneration) return;
          // A destroyed context means the document went away: a navigation.
          if (isCdpError(error, "context-gone", "target-closed")) navigationStarted = true;
        }
        if (generation !== domGeneration) return;
        domQuiet = true;
        notify();
      })();
    };
    try {
      return await new Promise<SettleResult>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let phase: "in-page" | "navigation" = "in-page";
        let phaseStart = actionEnd;
        const finish = (reason: string) => {
          if (timer) clearTimeout(timer);
          wake = undefined;
          signal?.removeEventListener("abort", onAbort);
          domGeneration++;
          resolve({
            ms: Math.round(performance.now() - actionEnd),
            reason,
            navigated,
            changed: navigated || domChanged || networkChanged,
          });
        };
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          wake = undefined;
          domGeneration++;
          reject(new CdpError("aborted", "settle", "aborted"));
        };
        const check = () => {
          if (timer) clearTimeout(timer);
          const now = performance.now();
          if (dialog) return finish("a JavaScript dialog opened");
          if (phase === "in-page" && navigationStarted) {
            phase = "navigation";
            navigated = true;
            profile = PROFILES.navigation;
            phaseStart = now;
            domQuiet = false;
            domGeneration++;
          }
          if (now - actionEnd >= profile.capMs) {
            return finish(
              phase === "navigation"
                ? `navigation still loading after ${profile.capMs} ms; observed anyway`
                : `page still changing after ${profile.capMs} ms; observed anyway`,
            );
          }
          const deadlines: number[] = [actionEnd + profile.capMs];
          if (phase === "navigation") {
            const loader = navigatedLoader;
            if (!loader && sameDocument) {
              navigated = false;
              return finish("same-document navigation");
            }
            if (!loader && stoppedWithoutCommit) {
              navigated = false;
              return finish("navigation did not load a new page (download or cancelled)");
            }
            if (!loader || !loaded.has(loader)) {
              wake = check;
              timer = setTimeout(check, Math.max(1, actionEnd + profile.capMs - now));
              return;
            }
            if (!navigationDomStarted) {
              navigationDomStarted = true;
              runDomQuiet(profile.domQuietMs, profile.capMs);
            }
          }
          const pending = tab.network.pending(LONG_POLL_MS);
          const networkIdleAt =
            Math.max(tab.network.lastActivity, phaseStart) + profile.networkQuietMs;
          const graceAt = actionEnd + profile.graceMs;
          const networkQuiet = pending === 0 && now >= networkIdleAt;
          if (domQuiet && networkQuiet && now >= graceAt) {
            if (phase === "navigation") return finish("page loaded and quiet after navigation");
            return finish(
              domChanged || networkChanged ? "page changed, then settled" : "no change",
            );
          }
          if (pending === 0) deadlines.push(networkIdleAt);
          const expiry = tab.network.nextExpiry(LONG_POLL_MS);
          if (expiry !== undefined) deadlines.push(expiry);
          deadlines.push(graceAt);
          const next = Math.min(...deadlines.filter((deadline) => deadline > now));
          wake = check;
          timer = setTimeout(check, Number.isFinite(next) ? Math.max(1, next - now) : 50);
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (!navigationStarted && !dialog) runDomQuiet(profile.domQuietMs, profile.capMs);
        check();
      });
    } finally {
      dispose();
    }
  };

  return { settle, dispose };
}
