import type { Tab } from "../browser/tabs.ts";
import { CdpError, isCdpError } from "../cdp/connection.ts";
import { renderSnapshot } from "./render.ts";
import { capturePage } from "./snapshot.ts";

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
// How long a save or submission the action started may take.
const WRITE_CAP_MS = 15_000;
// A write is the action's own when it started before the new page committed or, when
// nothing navigated, within this long of the action. Later writes are the page's own
// traffic (analytics, sync) and never mean the action is still being carried out.
const ACTION_WRITE_WINDOW_MS = 1_000;
// Pages whose network never goes quiet (ads, trackers, sync) count as ready once what the
// viewport shows has not changed for this long. Measured with scripts/settle-probe: pages
// mid-render held still for up to 2 s (Google Maps before its controls), so 3 s.
const STABLE_MS = 3_000;
const PROBE_MS = 250;
// The steady exit is taken only on a reading this recent, never on one that predates
// whatever woke the check.
const PROBE_FRESH_MS = 50;
// A busy reading older than this is checked again before settling.
const BUSY_FRESH_MS = 300;

// A visible loading indicator: aria-busy, or a progress bar with no value. A progress bar
// with a value is a meter (wizard steps, playback) and says nothing about loading.
const PAGE_BUSY = `(function () {
  var els = document.querySelectorAll('[aria-busy="true"],[role="progressbar"]:not([aria-valuenow]),progress:not([value])');
  for (var i = 0; i < els.length; i++) {
    var r = els[i].getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
  }
  return false;
})()`;

async function pageBusy(tab: Tab, signal: AbortSignal): Promise<boolean> {
  const contextId = await tab.frames.isolatedWorld(tab.frames.mainFrameId ?? "", signal);
  const result = await tab.session.send(
    "Runtime.evaluate",
    { expression: PAGE_BUSY, contextId, returnByValue: true },
    { signal, timeoutMs: 2_000 },
  );
  return result.result.value === true;
}

// What the viewport shows, digits folded so clocks and counters do not count as change.
// undefined when there is next to nothing to show yet.
async function viewportKey(tab: Tab, signal: AbortSignal): Promise<string | undefined> {
  const model = await capturePage(tab, { scope: "viewport", signal, peek: true });
  const lines = renderSnapshot(model, { scope: "viewport" }).canonical.split("\n");
  if (lines.length <= 2) return undefined;
  return lines.map((line) => line.replace(/\d+/g, "#").trim()).join("\n");
}

export interface SettleTrace {
  mode: SettleMode;
  // Epoch ms.
  watchedFrom: number;
  actionEnd: number;
  finishedAt: number;
  reason: string;
}

// Diagnostics (scripts/settle-probe): hears every settle that finishes.
export const settleTraces: { listener?: ((trace: SettleTrace) => void) | undefined } = {};

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
  const watchedFrom = performance.now();
  let profile = PROFILES[mode];
  let navigationStarted = mode === "navigation";
  let navigatedLoader: string | undefined;
  let committedAt: number | undefined;
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
      committedAt ??= performance.now();
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
        let writeSeen = false;
        let writesBefore = 0;
        let phaseStart = actionEnd;
        const probes = new AbortController();
        const probeSignal = signal ? AbortSignal.any([signal, probes.signal]) : probes.signal;
        let probeGeneration = 0;
        let steady: { key: string; since: number; seenAt: number } | undefined;
        let busy: { at: number; value: boolean } | undefined;
        let busyChecking = false;
        const track = (key: string | undefined, started: number, at: number) => {
          if (key === undefined) steady = undefined;
          else if (steady?.key === key) steady.seenAt = at;
          else steady = { key, since: started, seenAt: at };
        };
        // Reads the viewport every PROBE_MS while settling: how long it has looked the
        // same, and whether it shows a loading indicator.
        const startProbes = () => {
          const generation = ++probeGeneration;
          steady = undefined;
          void (async () => {
            while (generation === probeGeneration) {
              await new Promise((done) => setTimeout(done, PROBE_MS));
              if (generation !== probeGeneration) return;
              await ensureRendering();
              if (generation !== probeGeneration) return;
              const started = performance.now();
              const read = await Promise.all([
                viewportKey(tab, probeSignal),
                pageBusy(tab, probeSignal),
              ]).catch(() => undefined);
              if (generation !== probeGeneration) return;
              const at = performance.now();
              if (!read) {
                steady = undefined;
                continue;
              }
              const [key, value] = read;
              busy = { at, value };
              track(key, started, at);
              notify();
            }
          })();
        };
        const stopProbes = () => {
          probeGeneration++;
          probes.abort();
        };
        // A page that could not render looks quiet and steady only because it is stalled,
        // so once frames are restarted both have to be seen again.
        const ensureRendering = async () => {
          if (!(await tab.ensureRendering(probeSignal).catch(() => false))) return;
          steady = undefined;
          runDomQuiet(profile.domQuietMs, profile.capMs);
        };
        const refreshBusy = () => {
          if (busyChecking) return;
          busyChecking = true;
          void (async () => {
            await ensureRendering();
            const value = await pageBusy(tab, probeSignal).catch(() => false);
            busy = { at: performance.now(), value };
            busyChecking = false;
            notify();
          })();
        };
        const finish = (reason: string) => {
          if (timer) clearTimeout(timer);
          stopProbes();
          wake = undefined;
          signal?.removeEventListener("abort", onAbort);
          domGeneration++;
          settleTraces.listener?.({
            mode,
            watchedFrom: performance.timeOrigin + watchedFrom,
            actionEnd: performance.timeOrigin + actionEnd,
            finishedAt: performance.timeOrigin + performance.now(),
            reason,
          });
          resolve({
            ms: Math.round(performance.now() - actionEnd),
            reason,
            navigated,
            changed: navigated || domChanged || networkChanged,
          });
        };
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          stopProbes();
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
            probeGeneration++;
            steady = undefined;
          }
          const writes = tab.network.pendingWrites(
            watchedFrom,
            committedAt ?? actionEnd + ACTION_WRITE_WINDOW_MS,
          );
          if (writes > 0) writeSeen = true;
          // While the action's own save runs, the page is expected to change when it ends.
          if (writes > 0) steady = undefined;
          // The page renders the save's result only once it completes.
          if (writesBefore > 0 && writes === 0 && phase === "in-page" && !navigationStarted)
            runDomQuiet(profile.domQuietMs, WRITE_CAP_MS);
          writesBefore = writes;
          const capMs = writeSeen ? Math.max(profile.capMs, WRITE_CAP_MS) : profile.capMs;
          if (now - actionEnd >= capMs) {
            return finish(
              writes > 0
                ? `a save or submission was still in progress after ${capMs} ms; observed anyway`
                : phase === "navigation"
                  ? `navigation still loading after ${capMs} ms; observed anyway`
                  : `page still changing after ${capMs} ms; observed anyway`,
            );
          }
          const deadlines: number[] = [actionEnd + capMs];
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
              timer = setTimeout(check, Math.max(1, actionEnd + capMs - now));
              return;
            }
            if (!navigationDomStarted) {
              navigationDomStarted = true;
              runDomQuiet(profile.domQuietMs, profile.capMs);
              startProbes();
              void ensureRendering();
            }
          }
          if (
            steady &&
            writes === 0 &&
            busy?.value === false &&
            now - steady.seenAt < PROBE_FRESH_MS &&
            steady.seenAt - steady.since >= STABLE_MS
          ) {
            return finish(
              `page content unchanged for ${STABLE_MS / 1_000} s while the network stayed busy`,
            );
          }
          const pageUrl = tab.frames.get(tab.frames.mainFrameId ?? "")?.url;
          const pending = tab.network.pending(LONG_POLL_MS, pageUrl);
          const networkIdleAt =
            Math.max(tab.network.lastActivity, phaseStart) + profile.networkQuietMs;
          const graceAt = actionEnd + profile.graceMs;
          const networkQuiet = pending === 0 && writes === 0 && now >= networkIdleAt;
          if (domQuiet && networkQuiet && now >= graceAt) {
            if (!busy || now - busy.at > BUSY_FRESH_MS) {
              refreshBusy();
              wake = check;
              timer = setTimeout(check, Math.max(1, actionEnd + capMs - now));
              return;
            }
            if (!busy.value) {
              if (phase === "navigation") return finish("page loaded and quiet after navigation");
              return finish(
                domChanged || networkChanged ? "page changed, then settled" : "no change",
              );
            }
            // A loading indicator is showing; the probes report when it goes.
          }
          if (pending === 0 && writes === 0) deadlines.push(networkIdleAt);
          const expiry = tab.network.nextExpiry(LONG_POLL_MS, pageUrl);
          if (expiry !== undefined) deadlines.push(expiry);
          deadlines.push(graceAt);
          const next = Math.min(...deadlines.filter((deadline) => deadline > now));
          wake = check;
          timer = setTimeout(check, Number.isFinite(next) ? Math.max(1, next - now) : 50);
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (!navigationStarted && !dialog) {
          runDomQuiet(profile.domQuietMs, profile.capMs);
          startProbes();
        }
        check();
      });
    } finally {
      dispose();
    }
  };

  return { settle, dispose };
}
