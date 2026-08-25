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
  cursor: z
    .string()
    .max(100)
    .optional()
    .describe("Opaque nextCursor from the preceding observation. Omit to start a new window."),
});

export function observationDetails(
  record: ObservationRecord,
  plan?: { fills: readonly unknown[]; questions: readonly unknown[] },
): BrowserToolDetails {
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
      observation.screenshotOmitted === "credential"
        ? "suppressed"
        : observation.screenshotOmitted !== undefined
          ? "unavailable"
          : observation.screenshot === undefined
            ? "none"
            : screenshotSuppressed(observation)
              ? "suppressed"
              : "attached",
    ...(observation.coverage === undefined ? {} : { coverage: observation.coverage }),
    ...(observation.truncated === undefined ? {} : { truncated: observation.truncated }),
    ...(plan === undefined
      ? {}
      : { plannedFills: plan.fills.length, unresolvedQuestions: plan.questions.length }),
  };
}

export function browserObserveTool(context: BrowserToolContext) {
  const { session } = context;
  return tool({
    name: BROWSER_OBSERVE_TOOL,
    description:
      "Look at the page through a bounded semantic window: URL, title, frames and actionable controls with references. Follow nextCursor to continue through an oversized page, or use focus to search the complete indexed source. References remain usable across windows of the same revision; after the page changes, observe again. Reads the page and changes nothing.",
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
            ...(args.focus === undefined ? {} : { focus: args.focus }),
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
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
          record.observation.screenshotOmitted === "credential" ||
          (record.observation.screenshot !== undefined && screenshotSuppressed(record.observation));
        const screenshotNotice = (() => {
          if (suppressed) {
            return "no screenshot: this page holds a credential-entry control and is never captured";
          }
          switch (record.observation.screenshotOmitted) {
            case "too-large":
              return "no screenshot: the captured image exceeded Mu's size limit";
            case "unsupported-format":
              return "no screenshot: the browser returned an unsupported image format";
            case "unavailable":
              return "no screenshot: the browser did not return an image";
            default:
              return undefined;
          }
        })();
        const plan = session.plan(record.tabId);
        const applicantGuidance =
          plan === undefined || (plan.fills.length === 0 && plan.questions.length === 0)
            ? []
            : [
                "",
                "Applicant grounding:",
                ...plan.fills.map(
                  (fill) =>
                    `- ${fill.label}: use ${fill.factId === undefined ? fill.grounding : `fact ${fill.factId}`} (${fill.reason})`,
                ),
                ...plan.questions.map((question) => `- ask the user: ${question.prompt}`),
              ];
        return {
          content: [
            {
              type: "text",
              text: [
                observationHeadline(record),
                ...observationFacts(record),
                ...(screenshotNotice === undefined ? [] : [screenshotNotice]),
                "",
                observationText(record, {
                  // The session already searched the complete source before projecting.
                }),
                ...applicantGuidance,
              ].join("\n"),
            },
            ...screenshotContent(record),
          ],
          details: observationDetails(record, plan),
        };
      } catch (error) {
        return { content: [{ type: "text", text: toolErrorText(error) }], isError: true };
      }
    },
  });
}
