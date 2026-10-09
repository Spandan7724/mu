import type { ToolResult } from "@mu/core";
import type { ActionResult } from "../actions/click.ts";
import { hostOf, navigateTo } from "../actions/navigate.ts";
import type { ActionOutcome } from "../actions/types.ts";
import { Stopwatch } from "../actions/types.ts";
import { hostAllowed } from "../agent/permissions.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { Tab } from "../browser/tabs.ts";
import { isCdpError } from "../cdp/connection.ts";
import type { ResolvedBrowserOptions } from "../config.ts";
import { INJECTION_NOTE, looksLikeInjection } from "../page/injection.ts";
import type { PageModel } from "../page/model.ts";
import { observe } from "../page/observe.ts";
import { StaleRefError } from "../page/resolve.ts";

export interface BrowserToolDeps {
  browser: BrowserManager;
  config: ResolvedBrowserOptions;
  // Whether observations carry a screenshot for the active model.
  vision: () => boolean;
  // The agent's notes, shown when it loops between tabs.
  notes?: () => string;
}

// One live observation per tab, for the few most recently observed tabs (BD4, BD17).
export const observationKey = (slot: number) => `browser:observation:${slot}`;
const LOOP_THRESHOLD = 3;
// Outcomes worth seeing: something failed, did nothing, or the page is new.
const VISUAL_KINDS = new Set([
  "navigated",
  "new-tab",
  "no-change",
  "occluded",
  "value-mismatch",
  "timeout",
  "error",
  "not-interactable",
  "stale-ref",
]);
const NEW_ELEMENTS = 8;
const REFRESH_EVERY = 5;

function screenshotWorthIt(
  result: ActResult,
  before: string | undefined,
  detectChange: boolean,
  model: PageModel,
  rendered: string,
  fingerprint: string,
  withoutScreenshot: number,
): boolean {
  if (result.ok === false || (result.kind && VISUAL_KINDS.has(result.kind))) return true;
  if (detectChange && before !== undefined && before === fingerprint) return true;
  const fresh = rendered.split("\n").filter((line) => /^\s*\*-/.test(line)).length;
  if (model.newDocument || (model.modal && fresh > 0) || fresh >= NEW_ELEMENTS) return true;
  return withoutScreenshot + 1 >= REFRESH_EVERY;
}

// The same result coming back again and again means observing is not making progress,
// even with scrolls or no-op actions in between.
export function repeatNudge(
  tab: Tab,
  documentId: string,
  tool: string,
  key: string,
): string | undefined {
  const count = tab.countRepeat(documentId, `${tool}:${Bun.hash(key).toString(36)}`);
  if (count < LOOP_THRESHOLD) return undefined;
  return `note: ${tool} has returned exactly the same result ${count} times on this page. If you are waiting for something to load, use wait; if something you expect is missing, look for it with find, snapshot an element's ref or take a screenshot; otherwise act on what you have.`;
}

export type ActResult = ActionResult;

export interface HostBlock {
  result: ActResult;
  // The tab is the user's own, so it is left where it is and its content is not shown.
  withhold: boolean;
}

// Keeps the agent's view inside allowedHosts/blockedHosts whatever took the tab
// elsewhere (a redirect, a link, a script, a popup): the network block stops what it
// can; a tab that got there anyway is sent to about:blank before anything is read.
export async function enforceHosts(
  deps: BrowserToolDeps,
  tab: Tab,
  signal: AbortSignal,
): Promise<HostBlock | undefined> {
  const stopped = tab.blockedNavigation;
  tab.blockedNavigation = undefined;
  const why = "it is outside the hosts this run may visit (allowedHosts/blockedHosts)";
  if (tab.errorPage || hostAllowed(tab.url, deps.config)) {
    if (!stopped) return undefined;
    return {
      withhold: false,
      result: {
        ok: false,
        kind: "blocked-host",
        summary: `blocked loading ${stopped}: ${why}. A link or redirect led there; stay on the allowed hosts.`,
      },
    };
  }
  const offHost = tab.url;
  if (deps.browser.userTab(tab)) {
    return {
      withhold: true,
      result: {
        ok: false,
        kind: "blocked-host",
        summary: `not showing tab ${tab.tabId}: ${hostOf(offHost)} — ${why}. Switch to another tab.`,
      },
    };
  }
  await navigateTo(tab, "about:blank", signal).catch(() => {});
  return {
    withhold: false,
    result: {
      ok: false,
      kind: "blocked-host",
      summary: `left ${offHost} unread and opened about:blank: ${why}. A link, redirect or script led there; stay on the allowed hosts.`,
    },
  };
}

export function withheldResult(block: HostBlock, tab: Tab, stopwatch: Stopwatch): ToolResult {
  return {
    content: [{ type: "text", text: block.result.summary }],
    details: {
      ok: false,
      summary: block.result.summary,
      kind: "blocked-host",
      details: {
        timings: stopwatch.finish(),
        url: tab.url,
        title: "",
        tabId: tab.tabId,
        fingerprint: "",
        snapshotTokens: 0,
      },
    } satisfies ActionOutcome,
    isError: true,
  };
}

export interface PageActionOptions {
  // Interactions cannot proceed while a JS dialog blocks the page.
  blockedByDialog?: boolean;
  // Page-changing actions attach a screenshot when vision is on.
  screenshot?: boolean;
  scope?: "viewport" | "full";
  subtreeRef?: string;
  // Interactions compare the page before and after to report "no visible change".
  detectChange?: boolean;
  tabSwitch?: boolean;
  // navigate and tabs move the agent off the page without reading it, so they run even
  // when the active tab is on an excluded host.
  leavesPage?: boolean;
  // Observation-only tools name themselves to be told when they keep returning the same result.
  repeatTool?: string;
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
  const switching = options.tabSwitch === true;
  if (!switching) deps.browser.switchStreak = 0;
  const stopwatch = new Stopwatch();
  let tab = await stopwatch.time("cdpMs", async () => {
    const active = await deps.browser.activeTab(signal);
    await deps.browser.ensureForeground(active, signal);
    return active;
  });
  // A tab can reach an excluded host between calls (a load the network block missed):
  // nothing is done on it, so no input or script reaches that site.
  const blockedFirst =
    options.leavesPage === true
      ? undefined
      : await stopwatch.time("cdpMs", () => enforceHosts(deps, tab, signal));
  if (blockedFirst?.withhold) return withheldResult(blockedFirst, tab, stopwatch);
  let result: ActResult;
  if (blockedFirst) {
    result = blockedFirst.result;
  } else if (options.blockedByDialog !== false && tab.dialog) {
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
  const block = await stopwatch.time("cdpMs", () => enforceHosts(deps, tab, signal));
  if (block?.withhold) return withheldResult(block, tab, stopwatch);
  if (block) result = block.result;
  const before = tab.lastFingerprint;
  const notices = deps.browser.drainNotices();
  const observeOptions = {
    screenshot:
      options.screenshot === false || !deps.vision()
        ? false
        : (model: PageModel, rendered: string, fingerprint: string) =>
            screenshotWorthIt(
              result,
              before,
              options.detectChange === true,
              model,
              rendered,
              fingerprint,
              deps.browser.withoutScreenshot,
            ),
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
  deps.browser.withoutScreenshot = observation.screenshot ? 0 : deps.browser.withoutScreenshot + 1;
  let nudge: string | undefined;
  if (options.detectChange) {
    tab.unchangedStreak = before === observation.fingerprint ? tab.unchangedStreak + 1 : 0;
    if (tab.unchangedStreak >= LOOP_THRESHOLD) {
      nudge = `note: the page has not changed after ${tab.unchangedStreak} actions — try a different approach, check for an overlay, a validation error or a disabled control, or ask the user.`;
    }
  }
  if (options.repeatTool && result.ok !== false) {
    nudge = repeatNudge(
      tab,
      observation.model?.documentId ?? observation.url,
      options.repeatTool,
      `${options.scope ?? "viewport"} ${options.subtreeRef ?? ""} ${observation.fingerprint}`,
    );
  }
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
      title: observation.title,
      tabId: tab.tabId,
      fingerprint: observation.fingerprint,
      snapshotTokens: observation.tokens,
      ...(result.settle ? { settle: result.settle } : {}),
      ...(result.path ? { path: result.path } : {}),
    },
  };
  const content = observation.text.slice(observation.text.indexOf("<page_content"));
  const text = [
    outcome.summary,
    ...(nudge ? [nudge] : []),
    ...(looksLikeInjection(content) ? [INJECTION_NOTE] : []),
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
      key: observationKey(deps.browser.observationSlot(tab.tabId)),
      summary: `${outcome.summary} (page: ${observation.url})`,
    },
  };
}
