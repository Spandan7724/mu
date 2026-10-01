import { type AnyTool, evaluate, type ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { uploadRoots } from "../actions/files.ts";
import { hostOf } from "../actions/navigate.ts";
import { hostRules, SCOPES } from "../agent/permissions.ts";
import { runAct } from "../jev/act.ts";
import type { JevClient } from "../jev/client.ts";
import { detailsFor, scopeFor } from "./gate.ts";
import { type BrowserToolDeps, pageAction } from "./shared.ts";

// Secrets are typed by the model through the gated tools, never sent to Jev.
const SECRET_KEY =
  /pass(word|code|wd)|one[- ]?time|\botp\b|2fa|verification code|security code|\bcvv\b|\bcvc\b|card number|\bpin\b/i;

export const MAX_ACT_STEPS = 30;

const INTERACTION_TOOLS = new Set(["click", "fill_form", "type", "select"]);

// With Jev available, page interactions go through act so the steps the model already
// knows run in one call. Consequential clicks (commit: true, with the user's approval)
// and password or code fields keep their own tools.
function throughAct(deps: BrowserToolDeps, tool: string, args: Record<string, unknown>) {
  if (tool === "click" && args.commit === true) return undefined;
  const tab = deps.browser.currentTab();
  const refs = Array.isArray(args.fields)
    ? (args.fields as { ref?: unknown }[]).flatMap((field) =>
        typeof field.ref === "string" ? [field.ref] : [],
      )
    : typeof args.ref === "string"
      ? [args.ref]
      : [];
  const secret = refs.some((ref) => {
    const editable = tab?.refs.meta(ref)?.editable;
    return editable === "secret" || editable === "otp";
  });
  if (secret) return undefined;
  return `Interact with pages through act: put this step and every further step you already know (on this page and the next ones) in one act call. Refs from the page state work there instantly, e.g. act({ steps: [{ action: "${tool === "fill_form" ? "fill" : tool}", target: "e12"${tool === "type" ? ', text: "…"' : tool === "select" ? ', text: "option"' : ""} }] }). Consequential clicks go through click with commit: true.`;
}

export function throughActTools(tools: AnyTool[], deps: BrowserToolDeps): AnyTool[] {
  return tools.map((candidate) => {
    if (!INTERACTION_TOOLS.has(candidate.name)) return candidate;
    const { permissionScope, execute } = candidate;
    return {
      ...candidate,
      description:
        candidate.name === "click"
          ? "Only for consequential clicks the user's request authorizes (commit: true: submit, send, buy, delete…), after act stopped before them. Every other click goes through act."
          : `Only for password or one-time-code fields (it asks the user). Everything else goes through act. ${candidate.description}`,
      permissionScope: (args: Record<string, unknown>) =>
        throughAct(deps, candidate.name, args)
          ? "browser:interact"
          : (permissionScope?.(args) ?? "browser:interact"),
      execute: async (...call: Parameters<AnyTool["execute"]>): Promise<ToolResult> => {
        const redirect = throughAct(deps, candidate.name, call[1] as Record<string, unknown>);
        if (redirect) return { content: [{ type: "text", text: redirect }], isError: true };
        return execute(...call);
      },
    } as AnyTool;
  });
}

const step = z.object({
  action: z.enum(["click", "type", "select", "fill", "press", "scroll", "wait"]),
  target: z
    .string()
    .min(1)
    .optional()
    .describe(
      "What to act on: a ref from the latest page state (e12) on the page you see, otherwise its visible label in quotes or a short description as the page would show it ('the next-page link', 'Add to cart for the Travel Mug', 'the From field')",
    ),
  text: z
    .string()
    .optional()
    .describe(
      "type: the text to enter; select: the option to choose; press: the key (default Enter); wait: text to wait for",
    ),
  submit: z.boolean().optional().describe("type: press Enter afterwards"),
  direction: z.enum(["up", "down"]).optional().describe("scroll: default down"),
  next: z
    .string()
    .optional()
    .describe(
      "fill: the control that moves the form to its next page ('Next'); the step fills each page and clicks it until it is no longer there",
    ),
  values: z
    .record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())]))
    .optional()
    .describe("fill: values for this step (same as the call's values)"),
  files: z.record(z.string(), z.array(z.string().min(1)).min(1)).optional(),
});

export function actTool(deps: BrowserToolDeps, jev: JevClient) {
  const hosts = hostRules(deps.config.allowedHosts, deps.config.blockedHosts);
  return tool({
    name: "act",
    description:
      'How you interact with pages: run every step you already know in one call, across page changes: click, type, select, fill (values into a whole form step), press, scroll, wait. You decide each step, text and option; a fast matching model finds the element each step names on the page as it is by then (refs and exact labels resolve instantly) and checks for errors and sign-in walls. Example, three pages in one call: {"steps":[{"action":"click","target":"Mystery"},{"action":"click","target":"the next-page link"},{"action":"click","target":"the first book in the list"}]}. A whole multi-page form: {"steps":[{"action":"fill","next":"Next"}],"values":{"full name":"…","start month":"2026-03","how did you hear about us":"Other"},"files":{"resume":["resume.pdf"]}} fills every page and clicks Next until there is none, stopping before the final submit. It stops and hands back when a step\'s element cannot be found confidently (with the closest candidates), the page shows an error or a sign-in wall, a step would submit, send, buy or delete (click that yourself with commit: true), or a password or code field is next. Returns each step\'s outcome and the final page state.',
    inputSchema: z.object({
      steps: z.array(step).min(1).max(MAX_ACT_STEPS),
      values: z
        .record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())]))
        .optional()
        .describe(
          "For fill steps: values keyed by what the field asks for ('full name', 'how did you hear about us', 'authorized to work'): text, an option label as the form words it, true/false for a checkbox, a date. Values a fill step cannot place on its page stay for the next fill step. Only facts the user or their files gave; never passwords or codes.",
        ),
      files: z
        .record(z.string(), z.array(z.string().min(1)).min(1))
        .optional()
        .describe("For fill steps: files from your folder to upload, keyed by what they are"),
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
      return pageAction(
        deps,
        signal,
        (tab, stopwatch, actSignal) =>
          runAct(
            { tab, browser: deps.browser, stopwatch, signal: actSignal },
            {
              steps: args.steps,
              ...(args.values ? { values: args.values } : {}),
              ...(args.files ? { files: args.files } : {}),
            },
            {
              jev,
              uploadRoots: uploadRoots(deps.config),
              hostAllowed: (host) => evaluate(hosts, SCOPES.navigate, host) !== "deny",
            },
          ),
        { detectChange: true },
      );
    },
  });
}
