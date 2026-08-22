import type { ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { BROWSER_LIMITS } from "../contracts/json.ts";
import { takeoverReasonSchema } from "../contracts/takeover.ts";
import type { BrowserToolContext, BrowserToolDetails } from "./context.ts";
import { toolErrorText } from "./errors.ts";

export const BROWSER_TAKEOVER_TOOL = "browser_takeover";

const schema = z.object({
  reason: takeoverReasonSchema,
  instructions: z
    .string()
    .min(1)
    .max(BROWSER_LIMITS.maxSummaryChars)
    .describe("What the user has to do in the browser, in plain words."),
});

export function browserTakeoverTool(context: BrowserToolContext) {
  const { session } = context;
  return tool({
    name: BROWSER_TAKEOVER_TOOL,
    description:
      "Hand the browser back to the user and wait. Use it for sign-in, passwords, passkeys, one-time codes, MFA and CAPTCHAs, and whenever the right action is genuinely ambiguous. Pausing for a person is cooperation, not failure — and it does not complete the task.",
    inputSchema: schema,
    executionMode: "sequential",
    isConcurrencySafe: () => false,
    changesState: true,
    // TOOLS.md: always allow. Takeover narrows the agent's authority and cannot
    // create a side effect by itself.
    permissionScope: () => "browser:takeover",
    permissionPattern: () => "*",
    execute: async (args, _ctx): Promise<ToolResult> => {
      const record = session.record();
      try {
        await session.runtime.takeover(args.reason, args.instructions);
        // Every reference dies here: the user is about to change the page by hand.
        session.beginTakeover({
          reason: args.reason,
          instructions: args.instructions,
          startedAt: Date.now(),
          tabId: record?.tabId ?? "unknown",
          url: record?.observation.url ?? "unknown",
        });
        session.note({
          tool: BROWSER_TAKEOVER_TOOL,
          action: args.reason,
          ...(record === undefined
            ? {}
            : { tabId: record.tabId, url: record.observation.url, revision: record.revision }),
          outcome: "takeover",
          detail: args.instructions,
        });

        const details: BrowserToolDetails = {
          kind: "takeover",
          reason: args.reason,
          ...(record === undefined ? {} : { tabId: record.tabId, url: record.observation.url }),
        };

        return {
          content: [
            {
              type: "text",
              text: [
                `Waiting for you in the browser (${args.reason}).`,
                args.instructions,
                record === undefined
                  ? ""
                  : `The browser is on ${record.observation.url} in tab ${record.tabId}.`,
                "Automation is paused until the user resumes. The task is not complete, and every element reference taken so far is now invalid — resuming re-observes the page.",
              ]
                .filter((line) => line.length > 0)
                .join("\n"),
            },
          ],
          details,
          // Nothing further should be attempted in this turn: the user has the browser.
          terminate: true,
        };
      } catch (error) {
        session.note({ tool: BROWSER_TAKEOVER_TOOL, action: args.reason, outcome: "error" });
        return { content: [{ type: "text", text: toolErrorText(error) }], isError: true };
      }
    },
  });
}
