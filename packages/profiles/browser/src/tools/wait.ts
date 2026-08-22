import type { ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { MAX_WAIT_MS, type WaitRequest } from "../contracts/actions.ts";
import { acceptsModelActions } from "../contracts/connection.ts";
import { BROWSER_LIMITS } from "../contracts/json.ts";
import { browserElementRefSchema } from "../contracts/observation.ts";
import { observePattern } from "../policy/scopes.ts";
import { phaseSummary } from "../runtime/state.ts";
import type { BrowserToolContext, BrowserToolDetails } from "./context.ts";
import { toolErrorText } from "./errors.ts";
import { observationFacts, observationHeadline, observationText, outcomeText } from "./render.ts";

export const BROWSER_WAIT_TOOL = "browser_wait";

export const DEFAULT_WAIT_MS = 10_000;

const schema = z
  .object({
    condition: z.enum(["time", "text", "url", "element", "network-idle"]),
    value: z
      .union([
        z.string().max(BROWSER_LIMITS.maxElementTextChars),
        z.number(),
        browserElementRefSchema,
      ])
      .optional()
      .describe(
        "Milliseconds for time, the text to appear for text, a URL fragment for url, a reference for element.",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_WAIT_MS)
      .optional()
      .describe(`How long to wait before giving up. Defaults to ${DEFAULT_WAIT_MS}ms.`),
  })
  .superRefine((args, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["value"], message });
    switch (args.condition) {
      case "time":
        if (typeof args.value !== "number" || args.value < 0) {
          issue("waiting for time needs a non-negative number of milliseconds");
        }
        break;
      case "text":
      case "url":
        if (typeof args.value !== "string" || args.value.length === 0) {
          issue(`waiting for ${args.condition} needs a non-empty string`);
        }
        break;
      case "element":
        if (typeof args.value !== "object" || args.value === null) {
          issue("waiting for an element needs a reference from the latest observation");
        }
        break;
      case "network-idle":
        if (args.value !== undefined) issue("network-idle takes no value");
        break;
    }
  });

type Args = z.infer<typeof schema>;

export function browserWaitTool(context: BrowserToolContext) {
  const { session } = context;
  return tool({
    name: BROWSER_WAIT_TOOL,
    description:
      "Wait for the page to catch up: a delay, some text to appear, the URL to change, an element to be present, or the network to go quiet. Bounded by a timeout and stopped immediately on cancellation. This is for pages that load late, not a substitute for observing.",
    inputSchema: schema,
    // Waiting reads a moving page, so it never runs beside another browser call.
    isConcurrencySafe: () => false,
    changesState: false,
    permissionScope: () => "browser:observe",
    permissionPattern: () => observePattern(session.record()?.observation.origin),
    execute: async (args: Args, { signal }): Promise<ToolResult> => {
      const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
      try {
        if (!acceptsModelActions(session.runtime.status().phase)) {
          await session.runtime.connect(signal);
        }
        const phase = session.runtime.status().phase;
        if (!acceptsModelActions(phase)) {
          return {
            content: [{ type: "text", text: `The browser is not ready: ${phaseSummary(phase)}.` }],
            isError: true,
          };
        }

        let value = args.value;
        if (args.condition === "element" && typeof value === "object" && value !== null) {
          // The reference is translated the same way an action's is: no model-supplied
          // reference ever reaches the driver unchecked.
          const record = session.record(value.tabId);
          const driverRef = record === undefined ? undefined : session.driverRef(value, record);
          if (driverRef === undefined) {
            return {
              content: [
                {
                  type: "text",
                  text: "That reference is not from the current observation of this tab, so there is nothing to wait for. Observe again and wait on a reference from that observation.",
                },
              ],
              isError: true,
            };
          }
          value = driverRef;
        }

        const request: WaitRequest = {
          condition: args.condition,
          timeoutMs,
          ...(value === undefined ? {} : { value }),
        };
        const outcome = await session.use((driver) => driver.wait(request, signal), signal);
        const after = await session.observe({}, signal);

        session.note({
          tool: BROWSER_WAIT_TOOL,
          action: args.condition,
          tabId: after.tabId,
          url: after.observation.url,
          revision: after.revision,
          outcome: outcome.status,
        });

        const details: BrowserToolDetails = {
          kind: "action",
          tool: BROWSER_WAIT_TOOL,
          action: args.condition,
          status: outcome.status,
          tabId: after.tabId,
          url: after.observation.url,
        };

        const guidance =
          outcome.status === "failed"
            ? [
                `Nothing satisfied "${args.condition}" within ${timeoutMs}ms. The page below is what is actually there — decide from it rather than waiting again.`,
              ]
            : [];

        return {
          content: [
            {
              type: "text",
              text: [
                outcomeText(outcome),
                ...guidance,
                "",
                observationHeadline(after),
                ...observationFacts(after),
                "",
                observationText(after),
              ].join("\n"),
            },
          ],
          details,
        };
      } catch (error) {
        session.note({ tool: BROWSER_WAIT_TOOL, action: args.condition, outcome: "error" });
        return { content: [{ type: "text", text: toolErrorText(error) }], isError: true };
      }
    },
  });
}
