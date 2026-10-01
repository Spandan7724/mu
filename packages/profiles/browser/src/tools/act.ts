import { type AnyTool, evaluate, type ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { uploadRoots } from "../actions/files.ts";
import { hostOf } from "../actions/navigate.ts";
import { hostRules, SCOPES } from "../agent/permissions.ts";
import type { Tab } from "../browser/tabs.ts";
import { DEFAULT_MAX_STEPS, runAct } from "../jev/act.ts";
import type { JevClient } from "../jev/client.ts";
import { detailsFor, scopeFor } from "./gate.ts";
import { type BrowserToolDeps, pageAction } from "./shared.ts";

// Secrets are typed by the model through the gated tools, never sent to Jev.
const SECRET_KEY =
  /pass(word|code|wd)|one[- ]?time|\botp\b|2fa|verification code|security code|\bcvv\b|\bcvc\b|card number|\bpin\b/i;

// Pages act has already worked on: the manual field tools are open there.
const acted = new WeakMap<Tab, Set<string>>();
const pageKey = (tab: Tab) => `${tab.refs.documentId ?? ""}|${tab.url}`;

function markActed(tab: Tab | undefined): void {
  if (!tab) return;
  const pages = acted.get(tab) ?? new Set<string>();
  pages.add(pageKey(tab));
  acted.set(tab, pages);
}

const OPERATING_TOOLS = new Set(["click", "fill_form", "type", "select"]);

function fieldRefs(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.fields))
    return (args.fields as { ref?: unknown }[]).flatMap((field) =>
      typeof field.ref === "string" ? [field.ref] : [],
    );
  return typeof args.ref === "string" ? [args.ref] : [];
}

// Why an operating tool must wait for act on the current page, if it must. A click
// the model marks consequential (after act handed it back, with the user's approval)
// and password or code fields never wait.
function actFirst(
  deps: BrowserToolDeps,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  const tab = deps.browser.currentTab();
  if (!tab || acted.get(tab)?.has(pageKey(tab))) return undefined;
  if (tool === "click" && args.commit === true) return undefined;
  const refs = fieldRefs(args);
  const secret = refs.some((ref) => {
    const editable = tab.refs.meta(ref)?.editable;
    return editable === "secret" || editable === "otp";
  });
  if (secret) return undefined;
  return "Operate pages with act first: call act with the goal and every value you have (all pages of the flow at once). Once act has run on this page, click, fill_form, type and select are available here for what it handed back. Consequential clicks (commit: true) are always available.";
}

// With Jev available, act operates the browser: the manual operating tools refuse on
// a page act has not worked on yet (before any approval is asked).
export function actFirstTools(tools: AnyTool[], deps: BrowserToolDeps): AnyTool[] {
  return tools.map((candidate) => {
    if (!OPERATING_TOOLS.has(candidate.name)) return candidate;
    const { permissionScope, execute } = candidate;
    return {
      ...candidate,
      permissionScope: (args: Record<string, unknown>) =>
        actFirst(deps, candidate.name, args)
          ? "browser:interact"
          : (permissionScope?.(args) ?? "browser:interact"),
      execute: async (...call: Parameters<AnyTool["execute"]>): Promise<ToolResult> => {
        const refusal = actFirst(deps, candidate.name, call[1] as Record<string, unknown>);
        if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
        return execute(...call);
      },
    } as AnyTool;
  });
}

export function actTool(deps: BrowserToolDeps, jev: JevClient) {
  const hosts = hostRules(deps.config.allowedHosts, deps.config.blockedHosts);
  return tool({
    name: "act",
    description:
      "Operate the browser toward a goal with a fast decision model that takes every step itself, each in well under a second: clicking (buttons, links, tabs, menus, options, checkboxes), typing the values you give, choosing dropdown options, pressing Enter, scrolling and waiting, across pages (navigation, search, filters, menus, multi-page forms, cookie banners). It stops and hands back before anything consequential (submit, send, buy: you then click it with commit: true), at password or code fields, sign-in walls, errors, a field it has no value for, a step that needs reading, comparing, writing or deciding, or when unsure, and reports each step plus the page state.",
    inputSchema: z.object({
      goal: z
        .string()
        .min(1)
        .describe(
          "The end state to reach, as the page would show it (e.g. 'the review step of the application is showing')",
        ),
      values: z
        .record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())]))
        .optional()
        .describe(
          "What to enter, keyed by what the field asks for ('full name', 'how did you hear about us', 'authorized to work'): text, an option label, true/false for a checkbox, a date. Only facts the user or their files gave; never passwords or codes.",
        ),
      files: z
        .record(z.string(), z.array(z.string().min(1)).min(1))
        .optional()
        .describe("Files from your folder to upload, keyed by what they are ('resume')"),
      maxSteps: z.number().int().min(1).max(40).optional(),
    }),
    executionMode: "sequential",
    permissionPattern: () =>
      hostOf(deps.browser.tabs().find((tab) => tab.active)?.url ?? "") || "*",
    permissionScope: (args) => scopeFor(deps, "act", args),
    permissionDetails: (args) => detailsFor(deps, "act", args),
    execute: async (args, { signal }) => {
      const secret = Object.keys({ ...args.values, ...args.files }).find((key) =>
        SECRET_KEY.test(key),
      );
      if (secret)
        return {
          content: [
            {
              type: "text",
              text: `act does not take passwords or codes ("${secret}"): enter them with type or fill_form, which asks the user.`,
            },
          ],
          isError: true,
        };
      markActed(deps.browser.currentTab());
      const result = await pageAction(
        deps,
        signal,
        (tab, stopwatch, actSignal) =>
          runAct(
            { tab, browser: deps.browser, stopwatch, signal: actSignal },
            {
              goal: args.goal,
              ...(args.values ? { values: args.values } : {}),
              ...(args.files ? { files: args.files } : {}),
              maxSteps: args.maxSteps ?? DEFAULT_MAX_STEPS,
            },
            {
              jev,
              uploadRoots: uploadRoots(deps.config),
              hostAllowed: (host) => evaluate(hosts, SCOPES.navigate, host) !== "deny",
            },
          ),
        { detectChange: true },
      );
      markActed(deps.browser.currentTab());
      return result;
    },
  });
}
