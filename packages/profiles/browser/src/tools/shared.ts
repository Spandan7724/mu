import type { ToolResult } from "@mu/core";
import type { ActionResult } from "../actions/click.ts";
import type { ActionOutcome } from "../actions/types.ts";
import { Stopwatch } from "../actions/types.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { Tab } from "../browser/tabs.ts";
import { isCdpError } from "../cdp/connection.ts";
import type { ResolvedBrowserOptions } from "../config.ts";
import { observe } from "../page/observe.ts";
import { StaleRefError } from "../page/resolve.ts";

export interface BrowserToolDeps {
  browser: BrowserManager;
  config: ResolvedBrowserOptions;
  // Whether observations carry a screenshot for the active model.
  vision: () => boolean;
}

export const OBSERVATION_KEY = "browser:observation";

export type ActResult = ActionResult;

export interface PageActionOptions {
  // Interactions cannot proceed while a JS dialog blocks the page.
  blockedByDialog?: boolean;
  // Page-changing actions attach a screenshot when vision is on.
  screenshot?: boolean;
  scope?: "viewport" | "full";
  subtreeRef?: string;
  // Interactions compare the page before and after to report "no visible change".
  detectChange?: boolean;
}

// Every browser tool runs through here: resolve the active tab, act, observe,
// and return one outcome line plus the observation, with timings and retention.
export async function pageAction(
  deps: BrowserToolDeps,
  toolSignal: AbortSignal,
  act: (tab: Tab, stopwatch: Stopwatch, signal: AbortSignal) => Promise<ActResult>,
  options: PageActionOptions = {},
): Promise<ToolResult> {
  const signal = deps.browser.actionSignal(toolSignal);
  const stopwatch = new Stopwatch();
  let tab = await stopwatch.time("cdpMs", () => deps.browser.activeTab(signal));
  let result: ActResult;
  if (options.blockedByDialog !== false && tab.dialog) {
    result = {
      ok: false,
      kind: "blocked-by-dialog",
      summary: `A ${tab.dialog.type} dialog is open; accept or dismiss it with the dialog tool first.`,
    };
  } else {
    try {
      result = await act(tab, stopwatch, signal);
      if (result.tab) tab = result.tab;
    } catch (error) {
      if (signal.aborted) throw error;
      result =
        error instanceof StaleRefError
          ? {
              ok: false,
              kind: "stale-ref",
              summary: `${error.message}; use a ref from the page state below`,
            }
          : {
              ok: false,
              kind: isCdpError(error, "timeout") ? "timeout" : "error",
              summary: error instanceof Error ? error.message : String(error),
            };
      tab = await stopwatch.time("cdpMs", () => deps.browser.activeTab(signal));
    }
  }
  const before = tab.lastFingerprint;
  const notices = deps.browser.drainNotices();
  const observeOptions = {
    screenshot: options.screenshot !== false && deps.vision(),
    ...(options.scope ? { scope: options.scope } : {}),
  };
  let observation: Awaited<ReturnType<typeof observe>>;
  try {
    observation = await observe(deps.browser, tab, stopwatch, signal, {
      ...observeOptions,
      ...(options.subtreeRef ? { subtreeRef: options.subtreeRef } : {}),
    });
  } catch (error) {
    if (!(error instanceof StaleRefError)) throw error;
    result = {
      ok: false,
      kind: "stale-ref",
      summary: `${error.message}; use a ref from the page state below`,
    };
    observation = await observe(deps.browser, tab, stopwatch, signal, observeOptions);
  }
  if (!options.subtreeRef && options.scope !== "full")
    tab.lastFingerprint = observation.fingerprint;
  if (options.detectChange && result.ok !== false && before !== undefined) {
    const unchanged = before === observation.fingerprint;
    if (unchanged && !result.kind) {
      result = { ...result, kind: "no-change", summary: `${result.summary} (no visible change)` };
    } else if (!unchanged && result.kind === "no-change") {
      const { kind: _kind, ...rest } = result;
      result = rest;
    }
  }
  const outcome: ActionOutcome = {
    ok: result.ok !== false,
    summary: result.summary,
    ...(result.kind ? { kind: result.kind } : {}),
    ...(result.occludedBy ? { occludedBy: result.occludedBy } : {}),
    ...(result.newTab ? { newTab: result.newTab } : {}),
    details: {
      timings: stopwatch.finish(),
      url: observation.url,
      tabId: tab.tabId,
      fingerprint: observation.fingerprint,
      snapshotTokens: observation.tokens,
      ...(result.settle ? { settle: result.settle } : {}),
      ...(result.path ? { path: result.path } : {}),
    },
  };
  const text = [
    outcome.summary,
    ...notices.map((notice) => `note: ${notice}`),
    ...(result.extra ? [result.extra] : []),
    "",
    observation.text,
  ].join("\n");
  return {
    content: [
      { type: "text", text },
      ...(observation.screenshot
        ? [
            {
              type: "image" as const,
              mimeType: observation.screenshot.mimeType,
              data: observation.screenshot.data,
            },
          ]
        : []),
    ],
    details: outcome,
    ...(outcome.ok ? {} : { isError: true }),
    retention: {
      key: OBSERVATION_KEY,
      summary: `${outcome.summary} (page: ${JSON.stringify(observation.title)} ${observation.url})`,
    },
  };
}
