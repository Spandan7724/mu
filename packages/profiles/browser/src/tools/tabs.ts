import { tool } from "mu";
import { z } from "zod";
import { navigateTo, normalizeUrl } from "../actions/navigate.ts";
import type { TabInfo } from "../browser/tabs.ts";
import { type BrowserToolDeps, pageAction } from "./shared.ts";

export function formatTabs(tabs: TabInfo[]): string {
  if (tabs.length === 0) return "(no tabs)";
  return tabs
    .map(
      (tab) =>
        `${tab.active ? "*" : " "} ${tab.tabId} ${JSON.stringify(tab.title || "(untitled)")} ${tab.url}${tab.openedByAgent ? "" : " (user tab)"}`,
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
    permissionScope: ({ action }) => (action === "list" ? "browser:observe" : "browser:navigate"),
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
            return { summary: "listed tabs", extra: formatTabs(deps.browser.tabs()) };
          }
          if (action === "open") {
            const opened = await stopwatch.time("cdpMs", () =>
              deps.browser.openTab(undefined, actionSignal),
            );
            const settle = url
              ? (
                  await stopwatch.time("settleMs", () =>
                    navigateTo(opened, normalizeUrl(url), actionSignal),
                  )
                ).settle
              : undefined;
            return {
              summary: `opened tab ${opened.tabId}${url ? ` at ${url}` : ""}`,
              kind: "new-tab",
              tab: opened,
              ...(settle ? { settle } : {}),
            };
          }
          if (!tabId) return { ok: false, kind: "error", summary: `tabs ${action} needs a tabId` };
          if (action === "switch") {
            const switched = await stopwatch.time("cdpMs", () =>
              deps.browser.switchTab(tabId, actionSignal),
            );
            return { summary: `switched to tab ${switched.tabId}`, tab: switched };
          }
          await stopwatch.time("cdpMs", () => deps.browser.closeTab(tabId, actionSignal));
          const next = await stopwatch.time("cdpMs", () => deps.browser.activeTab(actionSignal));
          return {
            summary: `closed tab ${tabId}${tabId === tab.tabId ? `; now on ${next.tabId}` : ""}`,
            tab: next,
            extra: formatTabs(deps.browser.tabs()),
          };
        },
        { blockedByDialog: action !== "list" },
      ),
  });
}
