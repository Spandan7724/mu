import { tool } from "mu";
import { z } from "zod";
import { navigateTo, normalizeUrl } from "../actions/navigate.ts";
import type { TabInfo } from "../browser/tabs.ts";
import { fencePageContent } from "../page/render.ts";
import { navigationLeak, shareDetails } from "./gate.ts";
import { type BrowserToolDeps, pageAction } from "./shared.ts";

// Tab titles are page-written, so the list the model sees is fenced.
function fencedTabs(tabs: TabInfo[]): string {
  return fencePageContent([formatTabs(tabs)]);
}

export function formatTabs(tabs: TabInfo[]): string {
  if (tabs.length === 0) return "(no tabs)";
  return tabs
    .map(
      (tab) =>
        `${tab.active ? "*" : " "} ${tab.tabId} ${JSON.stringify(tab.title || "(untitled)")} ${tab.url}${tab.leftBy ? ` (left open by sub-task ${JSON.stringify(tab.leftBy)})` : tab.openedByAgent ? "" : " (user tab)"}`,
    )
    .join("\n");
}

export function tabsTool(deps: BrowserToolDeps) {
  return tool({
    name: "tabs",
    description:
      "List, open, switch to, or close browser tabs. The active tab (marked *) is the one every other tool acts on. Close only tabs you opened unless the user asks.",
    inputSchema: z.object({
      action: z.enum(["list", "open", "switch", "close"]),
      url: z.string().optional().describe("For open: page to load in the new tab"),
      tabId: z.string().optional().describe("For switch/close: a tab id such as t2"),
    }),
    executionMode: "sequential",
    changesState: ({ action }) => action !== "list",
    permissionScope: ({ action, url }) =>
      action === "list"
        ? "browser:observe"
        : action === "open" && url && navigationLeak(deps, url)
          ? "browser:share"
          : "browser:navigate",
    permissionDetails: ({ action, url }) => {
      const leak = action === "open" && url ? navigationLeak(deps, url) : undefined;
      return leak && url ? shareDetails(url, leak) : undefined;
    },
    permissionPattern: ({ action, url, tabId }) => {
      if (action === "open" && url) {
        try {
          return new URL(normalizeUrl(url)).host;
        } catch {
          return url;
        }
      }
      return tabId ?? "*";
    },
    execute: ({ action, url, tabId }, { signal }) =>
      pageAction(
        deps,
        signal,
        async (tab, stopwatch, actionSignal) => {
          if (action === "list") {
            return { summary: "listed tabs", extra: fencedTabs(deps.browser.tabs()) };
          }
          if (action === "open") {
            const target = url ? normalizeUrl(url) : undefined;
            const opened = await stopwatch.time("cdpMs", () =>
              deps.browser.openTab(undefined, actionSignal),
            );
            const settle = target
              ? (await stopwatch.time("settleMs", () => navigateTo(opened, target, actionSignal)))
                  .settle
              : undefined;
            return {
              summary: `opened tab ${opened.tabId}${url ? ` at ${url}` : ""}`,
              kind: "new-tab",
              tab: opened,
              ...(settle ? { settle } : {}),
            };
          }
          if (!tabId) return { ok: false, kind: "error", summary: `tabs ${action} needs a tabId` };
          if (action === "switch" && deps.browser.switchStreak >= 3) {
            deps.browser.switchStreak++;
            return {
              ok: false,
              kind: "no-change",
              summary: `did not switch to ${tabId}: you have switched tabs ${deps.browser.switchStreak - 1} times in a row without doing anything else`,
              extra: `Pages you leave are collapsed, so switching back and forth cannot show both at once. What you have recorded so far:\n${deps.notes?.() ?? "(no notes)"}\nIf that is enough, answer now; otherwise record what you need from this page with notes before moving on.`,
            };
          }
          if (action === "switch") {
            const switched = await stopwatch.time("cdpMs", () =>
              deps.browser.switchTab(tabId, actionSignal),
            );
            const streak = ++deps.browser.switchStreak;
            return {
              summary: `switched to tab ${switched.tabId}`,
              tab: switched,
              ...(streak >= 3
                ? {
                    extra: `note: that is ${streak} tab switches in a row. Pages you switch away from are collapsed, so switching back does not keep them in view — record the values you need with notes (or state them in your reply) and then continue.`,
                  }
                : {}),
            };
          }
          await stopwatch.time("cdpMs", () => deps.browser.closeTab(tabId, actionSignal));
          const next = await stopwatch.time("cdpMs", () => deps.browser.activeTab(actionSignal));
          return {
            summary: `closed tab ${tabId}${tabId === tab.tabId ? `; now on ${next.tabId}` : ""}`,
            tab: next,
            extra: fencedTabs(deps.browser.tabs()),
          };
        },
        { blockedByDialog: action !== "list", tabSwitch: action === "switch" },
      ),
  });
}
