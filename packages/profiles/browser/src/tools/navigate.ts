import type { ToolPermissionDetails, ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import type { NavigateRequest } from "../contracts/actions.ts";
import { acceptsModelActions } from "../contracts/connection.ts";
import { decideNavigateRequest } from "../policy/decide.ts";
import { describeOrigin } from "../policy/origin.ts";
import { navigatePattern } from "../policy/scopes.ts";
import { phaseSummary } from "../runtime/state.ts";
import type { BrowserToolContext, BrowserToolDetails } from "./context.ts";
import { toolErrorText } from "./errors.ts";
import { runBrowserOperation, stage, stop } from "./operation.ts";
import { observationFacts, observationHeadline, observationText, outcomeText } from "./render.ts";

export const BROWSER_NAVIGATE_TOOL = "browser_navigate";

const schema = z
  .object({
    action: z.enum(["open", "back", "forward", "reload"]),
    url: z.string().max(4096).optional().describe("Required for open. http(s) only."),
    tabId: z.string().optional(),
  })
  .superRefine((args, ctx) => {
    if (args.action === "open" && args.url === undefined) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "open needs a url" });
    }
    if (args.action !== "open" && args.url !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: `${args.action} moves through this tab's history and takes no url`,
      });
    }
  });

type Args = z.infer<typeof schema>;

function toRequest(args: Args): NavigateRequest {
  const tab = args.tabId === undefined ? {} : { tabId: args.tabId };
  switch (args.action) {
    case "open":
      return { kind: "url", url: args.url as string, ...tab };
    case "back":
      return { kind: "back", ...tab };
    case "forward":
      return { kind: "forward", ...tab };
    case "reload":
      return { kind: "reload", ...tab };
  }
}

export function browserNavigateTool(context: BrowserToolContext) {
  const { session } = context;

  const destinationOrigin = (args: Args): string | undefined => {
    if (args.action !== "open" || args.url === undefined) {
      return session.record(args.tabId)?.observation.origin;
    }
    try {
      return new URL(args.url).origin;
    } catch {
      return undefined;
    }
  };

  return tool({
    name: BROWSER_NAVIGATE_TOOL,
    description:
      "Open a URL, or move this tab back, forward or reload it. http(s) only. Every reference from before the navigation is dead: observe the page you land on.",
    inputSchema: schema,
    executionMode: "sequential",
    isConcurrencySafe: () => false,
    changesState: true,
    permissionScope: (args) => {
      const decision = decideNavigateRequest(
        session.policy,
        toRequest(args),
        session.record(args.tabId)?.observation.url,
      );
      if (decision.kind === "permission") {
        return decision.scopes[0] ?? "browser:navigate";
      }
      return "browser:navigate";
    },
    permissionPattern: (args) => navigatePattern(destinationOrigin(args)),
    permissionDetails: (args): ToolPermissionDetails => {
      const from = session.record(args.tabId)?.observation.url;
      const origin = destinationOrigin(args);
      const display = origin === undefined ? undefined : describeOrigin(origin);
      return {
        description:
          args.action === "open"
            ? `open ${args.url} in the browser`
            : `move this tab ${args.action}`,
        preview: {
          kind: "text",
          lines: [
            `from: ${from ?? "nothing observed yet"}`,
            `to: ${args.action === "open" ? (args.url as string) : `history ${args.action}`}`,
            ...(display === undefined ? [] : display.warnings),
          ],
        },
      };
    },
    execute: async (args, { signal }): Promise<ToolResult> => {
      return runBrowserOperation({
        session,
        signal,
        validate: () => stage(toRequest(args)),
        refresh: async (request) => {
          if (!acceptsModelActions(session.runtime.status().phase)) {
            await session.runtime.connect(signal);
          }
          const phase = session.runtime.status().phase;
          if (!acceptsModelActions(phase)) {
            return stop({
              content: [
                { type: "text", text: `The browser is not ready: ${phaseSummary(phase)}.` },
              ],
              isError: true,
            });
          }
          const current = session.record(args.tabId);
          const before =
            current === undefined
              ? undefined
              : await session.observe(
                  args.tabId === undefined ? {} : { tabId: args.tabId },
                  signal,
                );
          return stage({ request, before });
        },
        classify: ({ request, before }) =>
          stage(decideNavigateRequest(session.policy, request, before?.observation.url)),
        project: (decision) => {
          if (decision.kind === "deny") {
            session.note({
              tool: BROWSER_NAVIGATE_TOOL,
              action: args.action,
              outcome: "denied",
              detail: decision.message,
            });
            return stop({
              content: [{ type: "text", text: decision.message }],
              isError: true,
            });
          }
          if (decision.kind !== "permission") {
            return stop({
              content: [{ type: "text", text: "This navigation could not be classified." }],
              isError: true,
            });
          }
          return stage({
            scope: decision.scopes[0] ?? ("browser:navigate" as const),
            pattern: decision.pattern,
          });
        },
        drive: (driver, _projection, _decision, refreshed) =>
          driver.navigate(refreshed.request, signal),
        settle: async (outcome, _projection, _decision, refreshed) => {
          session.invalidate(outcome.after?.tabId ?? refreshed.before?.tabId);
          const after = await session.observe(
            args.tabId === undefined ? {} : { tabId: args.tabId },
            signal,
          );
          return { outcome, after };
        },
        update: ({ outcome, after }, _driven, projection) => {
          session.note({
            tool: BROWSER_NAVIGATE_TOOL,
            action: args.action,
            tabId: after.tabId,
            url: after.observation.url,
            ...(after.observation.origin === undefined ? {} : { origin: after.observation.origin }),
            revision: after.revision,
            outcome: outcome.status,
            scope: projection.scope,
            pattern: projection.pattern,
          });
        },
        render: ({ outcome, after }, _driven, projection) => {
          const landed = decideNavigateRequest(
            session.policy,
            { kind: "url", url: after.observation.url },
            undefined,
          );
          const redirectedOutOfScope =
            outcome.navigation !== undefined &&
            landed.kind === "permission" &&
            landed.scopes.includes("browser:new-origin");
          const details: BrowserToolDetails = {
            kind: "action",
            tool: BROWSER_NAVIGATE_TOOL,
            action: args.action,
            status: outcome.status,
            tabId: after.tabId,
            url: after.observation.url,
            navigated: outcome.navigation !== undefined,
            scope: redirectedOutOfScope ? "browser:new-origin" : projection.scope,
            pattern: navigatePattern(after.observation.origin),
          };
          return {
            content: [
              {
                type: "text",
                text: [
                  outcomeText(outcome),
                  ...(redirectedOutOfScope
                    ? [
                        "The page redirected to an origin this task has not approved. Do not interact with it until Mu grants browser:new-origin for that origin.",
                      ]
                    : []),
                  "",
                  observationHeadline(after),
                  ...observationFacts(after),
                  "",
                  observationText(after),
                ].join("\n"),
              },
            ],
            details,
            ...(outcome.status === "failed" || redirectedOutOfScope ? { isError: true } : {}),
          };
        },
        renderError: (error) => {
          session.note({ tool: BROWSER_NAVIGATE_TOOL, action: args.action, outcome: "error" });
          return { content: [{ type: "text", text: toolErrorText(error) }], isError: true };
        },
      });
    },
  });
}
