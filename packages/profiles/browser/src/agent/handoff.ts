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
  private waiting: { reason: string; done: Promise<void>; settle: () => void } | undefined;

  constructor(private readonly pollMs = POLL_MS) {}

  attach(host: ProfileRuntimeHost): void {
    this.host = host;
  }

  get pending(): { reason: string; done: Promise<void> } | undefined {
    return this.waiting && { reason: this.waiting.reason, done: this.waiting.done };
  }

  start(tab: Tab, reason: string): void {
    this.cancel();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiting = { reason, done: promise, settle: resolve };
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
      const settle = this.waiting?.settle;
      this.cancel(false);
      this.host?.followUp(
        customMessage(
          "browser-handoff",
          `The user finished the hand-off (${reason}): tab ${tab.tabId} is now at ${JSON.stringify(url)}. Continue the task.`,
        ),
      );
      // After the follow-up is queued, so a waiter sees the run it starts.
      settle?.();
    }, this.pollMs);
  }

  cancel(settle = true): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (settle) this.waiting?.settle();
    this.waiting = undefined;
  }
}

export function handoffTool(browser: BrowserManager, handoffs: Handoffs) {
  return tool({
    name: "handoff",
    description:
      "Hand the browser window to the user for something only they can do: signing in, a two-factor code, a CAPTCHA, payment details. Brings the window forward and ends your turn; you are woken when the page moves past the sign-in or check, or when the user replies.",
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
      if (browser.status().headless) {
        return {
          content: [
            {
              type: "text",
              text: `The browser is running headless, so there is no window to hand to the user. Stop and tell the user what they need to do (${reason}): sign in once with \`mu browser login\`, or rerun without --headless.`,
            },
          ],
          isError: true,
        };
      }
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
            text: `Handed the browser to the user: ${reason}. Your turn ends here; you are woken when the page moves on or the user replies.`,
          },
        ],
        details: { handoff },
        // Waiting is the user's move: no further model call until the page moves on
        // or they reply.
        terminate: true,
      };
    },
  });
}
