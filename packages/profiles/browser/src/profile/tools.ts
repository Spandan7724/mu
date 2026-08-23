// The browser profile's toolset.
//
// `browserToolset` is the B3 surface from TOOLS.md: observe, navigate, tabs, act, wait and
// takeover, built around one `BrowserToolSession` so every reference the model holds is
// minted, revised and invalidated in a single place. `browser_status` remains beside them
// because a session has to be able to say what it is connected to without touching a page.
import { type AnyTool, textResult } from "@mu/core";
import type { AuthorizedDocumentStore } from "../artifacts/documents.ts";
import { connectionSummary } from "../contracts/connection.ts";
import { isBrowserDriverError } from "../contracts/driver.ts";
import type { FactLookup } from "../data/facts.ts";
import { taskAuthority } from "../policy/authority.ts";
import type { BrowserPolicyState } from "../policy/decide.ts";
import type { BrowserPermissionMode } from "../policy/modes.ts";
import { createOriginPolicy } from "../policy/origin.ts";
import type { BrowserRuntime } from "../runtime/runtime.ts";
import { phaseSummary } from "../runtime/state.ts";
import type { BrowserReceiptSink } from "../tools/context.ts";
import { browserToolset as buildBrowserToolset } from "../tools/index.ts";
import { BrowserToolSession } from "../tools/session.ts";
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

export interface BrowserToolsetOptions {
  runtime: BrowserRuntime;
  /** Origins the task and explicit configuration made reachable. */
  allowedOrigins?: readonly string[] | undefined;
  mode?: BrowserPermissionMode | undefined;
  facts?: FactLookup | undefined;
  /** Present only when the user authorized documents; without it there is no upload tool. */
  documents?: AuthorizedDocumentStore | undefined;
  /** Set when the user has approved plaintext disclosure for this task. */
  allowInsecureDisclosure?: boolean | undefined;
  /** Where a commitment's receipt is written. Without it, nothing durable is kept. */
  receipts?: BrowserReceiptSink | undefined;
}

export interface BrowserToolset {
  tools: AnyTool[];
  session: BrowserToolSession;
}

/**
 * Builds the session and the tools that share it. The origin policy is minted with a task
 * authority because that is exactly what it is: origins the user's task named. Nothing
 * page-derived can widen it, by construction — `createOriginPolicy` demands the authority.
 */
export function browserToolset(options: BrowserToolsetOptions): BrowserToolset {
  const policy: BrowserPolicyState = {
    origins: createOriginPolicy(
      {
        configuredOrigins: options.allowedOrigins ?? [],
        ...(options.allowInsecureDisclosure === undefined
          ? {}
          : { allowInsecureDisclosure: options.allowInsecureDisclosure }),
      },
      taskAuthority({ reason: "origins configured for this task" }),
    ),
    mode: options.mode ?? "confirm-submission",
  };
  const session = new BrowserToolSession({ runtime: options.runtime, policy });
  const context = {
    session,
    ...(options.facts === undefined ? {} : { facts: options.facts }),
    ...(options.documents === undefined ? {} : { documents: options.documents }),
    ...(options.receipts === undefined ? {} : { receipts: options.receipts }),
  };
  return {
    tools: [browserStatusTool(options.runtime), ...buildBrowserToolset(context)],
    session,
  };
}

// B2's single status tool. `browserProfile` still wires this one; replacing it with
// `browserToolset` needs `profile/profile.ts`, which belongs to the integration gate
// rather than to this lane.
export function browserPlaceholderToolset(runtime: BrowserRuntime): AnyTool[] {
  return [browserStatusTool(runtime)];
}
