// PLACEHOLDER TOOLSET — B2 ONLY.
//
// B2's job is the product skeleton, not the model-facing browser surface. The
// observation, navigation, action, upload, submit and takeover tools that TOOLS.md
// specifies are B3 work and are deliberately absent. What is here is the single
// read-only status tool a session needs in order to prove that a browser session
// actually runs end to end: it opens the connection through the real runtime and
// reports the real connection state. It changes nothing and observes no page.
import { type AnyTool, textResult } from "@mu/core";
import { connectionSummary } from "../contracts/connection.ts";
import { isBrowserDriverError } from "../contracts/driver.ts";
import type { BrowserRuntime } from "../runtime/runtime.ts";
import { phaseSummary } from "../runtime/state.ts";
import { BROWSER_PERMISSION_SCOPES } from "./permissions.ts";

export const BROWSER_STATUS_TOOL = "browser_status";

export function browserStatusTool(runtime: BrowserRuntime): AnyTool {
  return {
    name: BROWSER_STATUS_TOOL,
    description:
      "Report the browser connection: mode, browser, phase and active tab. Opens the connection if it is not open yet. Reads no page content and changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        connect: {
          type: "boolean",
          description: "Open the connection if it is not already open. Defaults to true.",
        },
      },
    },
    isConcurrencySafe: () => true,
    changesState: false,
    permissionScope: () => BROWSER_PERMISSION_SCOPES.observe,
    permissionPattern: () => "status",
    execute: async (_id, args: { connect?: boolean }, signal: AbortSignal) => {
      if (args.connect !== false) {
        try {
          await runtime.connect(signal);
        } catch (error) {
          const detail = isBrowserDriverError(error)
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error);
          return textResult(
            `The browser is not connected (${detail}). ${phaseSummary(runtime.status().phase)}.`,
          );
        }
      }
      const state = runtime.status();
      return textResult(
        [
          connectionSummary(state),
          phaseSummary(state.phase),
          runtime.ownership === "owned"
            ? "Mu owns this browser and will close it on shutdown."
            : "Mu is attached to your browser and will detach without closing it.",
          ...(state.message ? [state.message] : []),
        ].join("\n"),
      );
    },
  };
}

export function browserPlaceholderToolset(runtime: BrowserRuntime): AnyTool[] {
  return [browserStatusTool(runtime)];
}
