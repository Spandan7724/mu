import type { Command } from "@mu/core";
import { normalizeUrl } from "./actions/navigate.ts";
import type { CommitLedger } from "./agent/state.ts";
import { formatLedger } from "./agent/state.ts";
import type { BrowserManager } from "./browser/manager.ts";
import { formatTabs } from "./tools/tabs.ts";

export function formatStatus(browser: BrowserManager, ledger: CommitLedger): string {
  const status = browser.status();
  const lines = [
    `browser: ${status.product ?? "not started yet"}${status.version ? ` ${status.version}` : ""}${status.headless ? " (headless)" : ""}`,
    `connection: ${status.mode === "cdp" ? `cdp ${status.endpoint ?? ""}` : `managed profile "${status.profile}"`}`,
    ...(status.userDataDir ? [`profile dir: ${status.userDataDir}`] : []),
    `state: ${status.connected ? `connected${status.launched ? " (launched by mu)" : " (re-attached)"}` : "not connected (starts on the first browser action)"}`,
    ...(status.activeTab
      ? [
          `active tab: ${status.activeTab.tabId} ${JSON.stringify(status.activeTab.title)} ${status.activeTab.url}`,
        ]
      : []),
    `tabs: ${status.tabs}`,
    "",
    "consequential actions this session:",
    formatLedger(ledger.records()),
  ];
  return lines.join("\n");
}

export function browserCommands(browser: BrowserManager, ledger: CommitLedger): Command[] {
  return [
    {
      name: "browser",
      description: "Show browser status, the active tab, and consequential actions taken",
      run: () => ({ handled: true, message: formatStatus(browser, ledger) }),
    },
    {
      name: "tabs",
      description: "List the browser's open tabs",
      run: async () => {
        await browser.ensureConnected();
        return { handled: true, message: formatTabs(browser.tabs()) };
      },
    },
    {
      name: "login",
      description: "Open a site in the browser window so you can sign in yourself: /login [url]",
      run: async (ctx) => {
        const target = ctx.args.trim();
        let tab = await browser.activeTab();
        if (target) {
          let url: string;
          try {
            url = normalizeUrl(target);
          } catch (error) {
            return {
              handled: true,
              message: error instanceof Error ? error.message : String(error),
            };
          }
          tab = await browser.openTab(url);
        }
        await browser.connection
          ?.send("Target.activateTarget", { targetId: tab.targetId }, { timeoutMs: 3_000 })
          .catch(() => {});
        const headless = browser.status().headless;
        return {
          handled: true,
          message: headless
            ? "The browser is running headless, so there is no window to sign in with. Restart without --headless (or run `mu browser login`) to sign in."
            : `Switched the browser window to ${tab.tabId}${target ? ` (${target})` : ""}. Sign in there, then tell me to continue.`,
        };
      },
    },
  ];
}
