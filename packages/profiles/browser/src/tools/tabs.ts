import type { ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { acceptsModelActions } from "../contracts/connection.ts";
import type { TabRequest } from "../contracts/tabs.ts";
import { decideNavigateRequest } from "../policy/decide.ts";
import { navigatePattern } from "../policy/scopes.ts";
import { phaseSummary } from "../runtime/state.ts";
import type { BrowserToolContext, BrowserToolDetails } from "./context.ts";
import { toolErrorText } from "./errors.ts";

export const BROWSER_TABS_TOOL = "browser_tabs";

const schema = z
  .object({
    action: z.enum(["list", "open", "select", "close"]),
    tabId: z.string().optional().describe("Required for select and close."),
    url: z.string().max(4096).optional().describe("Where a newly opened tab should start."),
  })
  .superRefine((args, ctx) => {
    if ((args.action === "select" || args.action === "close") && args.tabId === undefined) {
      ctx.addIssue({ code: "custom", path: ["tabId"], message: `${args.action} needs a tabId` });
    }
    if (args.action !== "open" && args.url !== undefined) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "only open takes a url" });
    }
    if (args.action === "list" && args.tabId !== undefined) {
      ctx.addIssue({ code: "custom", path: ["tabId"], message: "list takes no tabId" });
    }
  });

type Args = z.infer<typeof schema>;

function toRequest(args: Args): TabRequest {
  switch (args.action) {
    case "list":
      return { kind: "list" };
    case "open":
      return { kind: "open", ...(args.url === undefined ? {} : { url: args.url }) };
    case "select":
      return { kind: "select", tabId: args.tabId as string };
    case "close":
      return { kind: "close", tabId: args.tabId as string };
  }
}

export function browserTabsTool(context: BrowserToolContext) {
  const { session } = context;
  return tool({
    name: BROWSER_TABS_TOOL,
    description:
      "List the tabs Mu controls, open a new controlled tab, switch to one Mu already controls, or close one. Switching or opening invalidates every reference from the tab you were on; observe after either.",
    inputSchema: schema,
    executionMode: "sequential",
    isConcurrencySafe: () => false,
    changesState: (args) => args.action !== "list",
    permissionScope: (args) => {
      if (args.action === "list") return "browser:observe";
      if (args.action !== "open" || args.url === undefined) return "browser:navigate";
      const decision = decideNavigateRequest(
        session.policy,
        { kind: "url", url: args.url },
        session.record()?.observation.url,
      );
      return decision.kind === "permission"
        ? (decision.scopes[0] ?? "browser:navigate")
        : "browser:navigate";
    },
    permissionPattern: (args) => {
      if (args.action === "open" && args.url !== undefined) {
        try {
          return navigatePattern(new URL(args.url).origin);
        } catch {
          return navigatePattern(undefined);
        }
      }
      return args.tabId ?? navigatePattern(session.record()?.observation.origin);
    },
    execute: async (args, { signal }): Promise<ToolResult> => {
      try {
        // A new controlled tab is a navigation: new-origin rules still apply (TOOLS.md).
        if (args.action === "open" && args.url !== undefined) {
          const decision = decideNavigateRequest(
            session.policy,
            { kind: "url", url: args.url },
            session.record()?.observation.url,
          );
          if (decision.kind === "deny") {
            return { content: [{ type: "text", text: decision.message }], isError: true };
          }
        }

        if (!acceptsModelActions(session.runtime.status().phase)) {
          await session.runtime.connect(signal);
        }

        const outcome = await session.use((driver) => driver.tabs(toRequest(args), signal), signal);

        // Selecting, opening or closing changes which page the next reference means.
        if (args.action !== "list") {
          session.invalidate();
          session.setActiveTab(outcome.activeTabId);
        }

        session.note({
          tool: BROWSER_TABS_TOOL,
          action: args.action,
          ...(outcome.activeTabId === undefined ? {} : { tabId: outcome.activeTabId }),
          outcome: outcome.ok ? "completed" : "failed",
          detail: outcome.message,
        });

        const listing = outcome.tabs.map(
          (tab) =>
            `${tab.active ? "*" : " "} ${tab.id} · ${tab.title} · ${tab.url}${
              tab.attached ? "" : " (detached)"
            }`,
        );
        const next =
          args.action === "list"
            ? []
            : ["", "Observe before acting: references from the previous tab are no longer valid."];

        const details: BrowserToolDetails = {
          kind: "tabs",
          action: args.action,
          tabs: outcome.tabs.map((tab) => ({
            id: tab.id,
            title: tab.title,
            url: tab.url,
            active: tab.active,
            attached: tab.attached,
          })),
          ...(outcome.activeTabId === undefined ? {} : { activeTabId: outcome.activeTabId }),
        };

        return {
          content: [{ type: "text", text: [outcome.message, ...listing, ...next].join("\n") }],
          details,
          ...(outcome.ok ? {} : { isError: true }),
        };
      } catch (error) {
        session.note({ tool: BROWSER_TABS_TOOL, action: args.action, outcome: "error" });
        const phase = session.runtime.status().phase;
        return {
          content: [{ type: "text", text: `${toolErrorText(error)}\n${phaseSummary(phase)}.` }],
          isError: true,
        };
      }
    },
  });
}
