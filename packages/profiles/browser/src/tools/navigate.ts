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
      if (decision.kind === "allow" || decision.kind === "ask") {
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
      const request = toRequest(args);
      try {
        const before = session.record(args.tabId);
        // Origin, scheme and redirect rules all live in policy; this asks and obeys.
        const decision = decideNavigateRequest(session.policy, request, before?.observation.url);
        if (decision.kind === "deny") {
          session.note({
            tool: BROWSER_NAVIGATE_TOOL,
            action: args.action,
            outcome: "denied",
            detail: decision.message,
          });
          return { content: [{ type: "text", text: decision.message }], isError: true };
        }

        if (!acceptsModelActions(session.runtime.status().phase)) {
          // Connecting is lazy, so make the attempt before judging the phase.
          await session.runtime.connect(signal);
        }
        const phase = session.runtime.status().phase;
        if (!acceptsModelActions(phase)) {
          return {
            content: [{ type: "text", text: `The browser is not ready: ${phaseSummary(phase)}.` }],
            isError: true,
          };
        }

        const outcome = await session.use((driver) => driver.navigate(request, signal), signal);
        // Navigation always invalidates: ARCHITECTURE §8 lists it first.
        session.invalidate(outcome.after?.tabId ?? before?.tabId);

        const after = await session.observe(
          args.tabId === undefined ? {} : { tabId: args.tabId },
          signal,
        );
        const scope =
          decision.kind === "allow" || decision.kind === "ask"
            ? (decision.scopes[0] ?? "browser:navigate")
            : "browser:navigate";
        const pattern = navigatePattern(after.observation.origin);
        session.note({
          tool: BROWSER_NAVIGATE_TOOL,
          action: args.action,
          tabId: after.tabId,
          url: after.observation.url,
          ...(after.observation.origin === undefined ? {} : { origin: after.observation.origin }),
          revision: after.revision,
          outcome: outcome.status,
          scope,
          pattern,
        });

        const details: BrowserToolDetails = {
          kind: "action",
          tool: BROWSER_NAVIGATE_TOOL,
          action: args.action,
          status: outcome.status,
          tabId: after.tabId,
          url: after.observation.url,
          navigated: outcome.navigation !== undefined,
          scope,
          pattern,
        };

        return {
          content: [
            {
              type: "text",
              text: [
                outcomeText(outcome),
                "",
                observationHeadline(after),
                ...observationFacts(after),
                "",
                observationText(after),
              ].join("\n"),
            },
          ],
          details,
          ...(outcome.status === "failed" ? { isError: true } : {}),
        };
      } catch (error) {
        session.note({ tool: BROWSER_NAVIGATE_TOOL, action: args.action, outcome: "error" });
        return { content: [{ type: "text", text: toolErrorText(error) }], isError: true };
      }
    },
  });
}
