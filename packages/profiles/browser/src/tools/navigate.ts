import { tool } from "mu";
import { z } from "zod";
import { goHistory, hostOf, navigateTo, normalizeUrl, reload } from "../actions/navigate.ts";
import { type BrowserToolDeps, pageAction } from "./shared.ts";

const HISTORY = ["back", "forward", "reload"] as const;

export function navigateTool(deps: BrowserToolDeps) {
  return tool({
    name: "navigate",
    description:
      "Go to a URL in the active tab (full URL or bare domain like example.com), or pass back, forward or reload. Set newTab to open it in a new tab instead. Returns the new page state.",
    inputSchema: z.object({
      url: z.string().min(1).describe("URL, bare domain, or back | forward | reload"),
      newTab: z.boolean().optional().describe("Open in a new tab and make it active"),
    }),
    executionMode: "sequential",
    permissionScope: () => "browser:navigate",
    permissionPattern: ({ url }) =>
      (HISTORY as readonly string[]).includes(url)
        ? hostOf(deps.browser.tabs().find((tab) => tab.active)?.url ?? "")
        : hostOf(safeNormalize(url)),
    execute: ({ url, newTab }, { signal }) =>
      pageAction(deps, signal, async (tab, stopwatch, actionSignal) => {
        if (url === "back" || url === "forward") {
          const result = await stopwatch.time("settleMs", () =>
            goHistory(tab, url === "back" ? -1 : 1, actionSignal),
          );
          if (!result) return { ok: false, kind: "no-change", summary: `No page to go ${url} to.` };
          return { summary: `went ${url}`, kind: "navigated", settle: result.settle };
        }
        if (url === "reload") {
          const result = await stopwatch.time("settleMs", () => reload(tab, actionSignal));
          return { summary: "reloaded the page", kind: "navigated", settle: result.settle };
        }
        const target = normalizeUrl(url);
        const active = newTab
          ? await stopwatch.time("cdpMs", () => deps.browser.openTab(undefined, actionSignal))
          : tab;
        let result: Awaited<ReturnType<typeof navigateTo>>;
        try {
          result = await stopwatch.time("settleMs", () => navigateTo(active, target, actionSignal));
        } catch (error) {
          if (actionSignal.aborted) throw error;
          return {
            ok: false,
            kind: "error",
            summary: `could not load ${target}: ${error instanceof Error ? error.message : String(error)}`,
            tab: active,
          };
        }
        return {
          summary: `navigated${newTab ? ` in new tab ${active.tabId}` : ""} to ${target}`,
          kind: "navigated",
          settle: result.settle,
          tab: active,
        };
      }),
  });
}

function safeNormalize(url: string): string {
  try {
    return normalizeUrl(url);
  } catch {
    return url;
  }
}
