import { tool } from "mu";
import { z } from "zod";
import { BROWSER_LIMITS } from "../contracts/json.ts";
import { observePattern } from "../policy/scopes.ts";
import type { BrowserToolContext, BrowserToolDetails } from "./context.ts";
import { toolErrorText } from "./errors.ts";
import { OBSERVATION_BUDGET } from "./observation.ts";
import {
  observationFacts,
  observationHeadline,
  observationText,
  screenshotContent,
  screenshotSuppressed,
} from "./render.ts";
import type { ObservationRecord } from "./session.ts";

export const BROWSER_OBSERVE_TOOL = "browser_observe";

const schema = z.object({
  tabId: z.string().optional().describe("Controlled tab to observe. Defaults to the active tab."),
  screenshot: z
    .enum(["none", "viewport", "full-page"])
    .optional()
    .describe("Attach a screenshot when the layout matters. Defaults to none."),
  focus: z
    .string()
    .max(BROWSER_LIMITS.maxElementTextChars)
    .optional()
    .describe(
      "What you are looking for, in words — a section heading, a field label, a role. A hint for ordering, never a selector.",
    ),
});

export function observationDetails(record: ObservationRecord): BrowserToolDetails {
  const observation = record.observation;
  return {
    kind: "observation",
    tabId: observation.tab.id,
    revision: observation.revision,
    url: observation.url,
    ...(observation.origin === undefined ? {} : { origin: observation.origin }),
    title: observation.title,
    controls: observation.elements.length,
    frames: observation.frames.length,
    risks: [...observation.risks],
    injections: record.injections.length,
    screenshot:
      observation.screenshot === undefined
        ? "none"
        : screenshotSuppressed(observation)
          ? "suppressed"
          : "attached",
    ...(observation.truncated === undefined ? {} : { truncated: observation.truncated }),
  };
}

export function browserObserveTool(context: BrowserToolContext) {
  const { session } = context;
  return tool({
    name: BROWSER_OBSERVE_TOOL,
    description:
      "Look at the page: its URL, title, frames and every control you can act on, each with a reference you pass to the other browser tools. References belong to the observation that produced them — after anything changes the page, observe again. Reads the page and changes nothing.",
    inputSchema: schema,
    // TOOLS.md: observing races with page mutation and establishes revision state.
    isConcurrencySafe: () => false,
    changesState: false,
    permissionScope: () => "browser:observe",
    permissionPattern: () => observePattern(session.record()?.observation.origin),
    execute: async (args, { signal }) => {
      try {
        const record = await session.observe(
          {
            ...(args.tabId === undefined ? {} : { tabId: args.tabId }),
            ...(args.screenshot === undefined ? {} : { screenshot: args.screenshot }),
            maxNodes: OBSERVATION_BUDGET.maxElements,
            maxTextChars: OBSERVATION_BUDGET.maxTextChars,
          },
          signal,
        );
        session.note({
          tool: BROWSER_OBSERVE_TOOL,
          action: "observe",
          tabId: record.tabId,
          url: record.observation.url,
          ...(record.observation.origin === undefined ? {} : { origin: record.observation.origin }),
          revision: record.revision,
          outcome: "observed",
        });
        const suppressed =
          record.observation.screenshot !== undefined && screenshotSuppressed(record.observation);
        return {
          content: [
            {
              type: "text",
              text: [
                observationHeadline(record),
                ...observationFacts(record),
                ...(suppressed
                  ? ["no screenshot: this page holds a credential control and is never captured"]
                  : []),
                "",
                observationText(record, {
                  ...(args.focus === undefined ? {} : { focus: args.focus }),
                }),
              ].join("\n"),
            },
            ...screenshotContent(record),
          ],
          details: observationDetails(record),
        };
      } catch (error) {
        return { content: [{ type: "text", text: toolErrorText(error) }], isError: true };
      }
    },
  });
}
