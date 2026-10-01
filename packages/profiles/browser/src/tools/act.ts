import { evaluate } from "@mu/core";
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
});

export function actTool(deps: BrowserToolDeps, jev: JevClient) {
  const hosts = hostRules(deps.config.allowedHosts, deps.config.blockedHosts);
  return tool({
    name: "act",
    description:
      "Run a sequence of steps you have decided, fast, across page changes: click, type, select, fill (values into a whole form step), press, scroll, wait. You decide every step and every text and option; a fast matching model only finds the element each step names on the page as it is by then (refs and exact labels resolve instantly) and checks for errors and sign-in walls. It stops and hands back when a step's element cannot be found confidently (with the closest candidates), the page shows an error or a sign-in wall, a step would submit, send, buy or delete (click that yourself with commit: true), or a password or code field is next. Returns each step's outcome and the final page state.",
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
