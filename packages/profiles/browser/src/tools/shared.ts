import type { ToolResult } from "@mu/core";
import type { ActionOutcome, OutcomeKind } from "../actions/types.ts";
import { Stopwatch } from "../actions/types.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { Tab } from "../browser/tabs.ts";
import { isCdpError } from "../cdp/connection.ts";
import type { ResolvedBrowserOptions } from "../config.ts";
import { observe } from "../page/observe.ts";

export interface BrowserToolDeps {
  browser: BrowserManager;
  config: ResolvedBrowserOptions;
}

export const OBSERVATION_KEY = "browser:observation";

export interface ActResult {
  ok?: boolean;
  summary: string;
  kind?: OutcomeKind;
  settle?: string;
  tab?: Tab;
  extra?: string;
}

export interface PageActionOptions {
  // Interactions cannot proceed while a JS dialog blocks the page.
  blockedByDialog?: boolean;
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
      result = {
        ok: false,
        kind: isCdpError(error, "timeout") ? "timeout" : "error",
        summary: error instanceof Error ? error.message : String(error),
      };
      tab = await stopwatch.time("cdpMs", () => deps.browser.activeTab(signal));
    }
  }
  const notices = deps.browser.drainNotices();
  const observation = await observe(deps.browser, tab, stopwatch, signal);
  const outcome: ActionOutcome = {
    ok: result.ok !== false,
    summary: result.summary,
    ...(result.kind ? { kind: result.kind } : {}),
    details: {
      timings: stopwatch.finish(),
      url: observation.url,
      tabId: tab.tabId,
      fingerprint: observation.fingerprint,
      snapshotTokens: observation.tokens,
      ...(result.settle ? { settle: result.settle } : {}),
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
    content: [{ type: "text", text }],
    details: outcome,
    ...(outcome.ok ? {} : { isError: true }),
    retention: {
      key: OBSERVATION_KEY,
      summary: `${outcome.summary} (page: ${JSON.stringify(observation.title)} ${observation.url})`,
    },
  };
}
