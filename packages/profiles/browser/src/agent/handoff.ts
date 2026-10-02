import { customMessage, type ProfileRuntimeHost } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { hostOf } from "../actions/navigate.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { Tab } from "../browser/tabs.ts";

// Pages still inside a sign-in, verification or payment flow. Leaving them is
// what the user was asked to do, so only a page outside them wakes the agent.
const STILL_HANDING_OFF =
  /log-?in|sign-?in|signon|auth|challenge|verif|2fa|mfa|otp|captcha|checkpoint|identifier|password|sso|consent|checkout|payment/i;
const POLL_MS = 1_000;
// Redirect chains pass through ordinary-looking pages; wait until the address holds.
const STABLE_POLLS = 2;

function stillHandingOff(url: string): boolean {
  try {
    const parsed = new URL(url);
    return STILL_HANDING_OFF.test(`${parsed.host}${parsed.pathname}`);
  } catch {
    return true;
  }
}

// Wakes the agent once the page the user was handed moves on, unless the agent
// has resumed by other means first.
export class Handoffs {
  private host: ProfileRuntimeHost | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly pollMs = POLL_MS) {}

  attach(host: ProfileRuntimeHost): void {
    this.host = host;
  }

  start(tab: Tab, reason: string): void {
    this.cancel();
    const from = tab.url;
    let stable = 0;
    let candidate = "";
    this.timer = setInterval(() => {
      if (tab.detached) return this.cancel();
      const url = tab.url;
      if (url === from || stillHandingOff(url)) {
        stable = 0;
        return;
      }
      stable = url === candidate ? stable + 1 : 1;
      candidate = url;
      if (stable < STABLE_POLLS) return;
      this.cancel();
      this.host?.followUp(
        customMessage(
          "browser-handoff",
          `The user finished the hand-off (${reason}): tab ${tab.tabId} is now at ${JSON.stringify(tab.title || "(untitled)")} ${url}. Continue the task.`,
        ),
      );
    }, this.pollMs);
  }

  cancel(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function handoffTool(browser: BrowserManager, handoffs: Handoffs) {
  return tool({
    name: "handoff",
    description:
      "Hand the browser window to the user for something only they can do: signing in, a two-factor code, a CAPTCHA, payment details. Brings the window forward. Then end your turn with one short line; you are woken when the page moves on or the user replies.",
    inputSchema: z.object({
      reason: z
        .string()
        .min(1)
        .max(200)
        .describe('What the user should do, e.g. "sign in to linkedin.com"'),
    }),
    executionMode: "sequential",
    changesState: false,
    permissionScope: () => "browser:observe",
    execute: async ({ reason }, { signal }) => {
      const tab = await browser.activeTab(signal);
      await browser.connection
        ?.send("Target.activateTarget", { targetId: tab.targetId }, { signal, timeoutMs: 3_000 })
        .catch(() => {});
      handoffs.start(tab, reason);
      const handoff = {
        reason,
        url: tab.url,
        title: tab.title,
        host: hostOf(tab.url),
        tabId: tab.tabId,
      };
      return {
        content: [
          {
            type: "text",
            text: `Handed the browser to the user: ${reason}. End your turn now with one short line telling the user what to do; you will be woken when the page moves on or the user replies.`,
          },
        ],
        details: { handoff },
      };
    },
  });
}
