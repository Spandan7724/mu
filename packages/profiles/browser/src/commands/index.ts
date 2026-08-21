// The browser product's own commands (DESIGN §Commands). Connection state has no
// dedicated core event, so these — together with the status tool's result — are
// how it reaches the user on demand rather than only when the model mentions it.
//
// `/documents`, `/profile` and `/receipt` belong to lanes that own task data and
// receipts; they are not stubbed here, because a command that answers nothing is
// worse than a command that does not exist yet.
import type { Command } from "@mu/core";
import { connectionSummary } from "../contracts/connection.ts";
import { isBrowserDriverError } from "../contracts/driver.ts";
import type { ResolvedBrowserProfileOptions } from "../profile/options.ts";
import type { BrowserRuntime } from "../runtime/runtime.ts";
import { phaseSummary } from "../runtime/state.ts";

function describe(error: unknown): string {
  if (isBrowserDriverError(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export interface BrowserCommandsOptions {
  runtime: BrowserRuntime;
  options: ResolvedBrowserProfileOptions;
  dataRoot: string;
}

export function browserCommands(context: BrowserCommandsOptions): Command[] {
  const { runtime, options, dataRoot } = context;

  const report = (): string => {
    const state = runtime.status();
    const lines = [
      connectionSummary(state),
      phaseSummary(state.phase),
      `connection: ${runtime.description}`,
      `shutdown: ${
        runtime.ownership === "owned"
          ? "closes the browser Mu owns"
          : "detaches without closing your browser"
      }`,
      `data root: ${dataRoot}`,
      `allowed origins: ${
        options.allowedOrigins.length === 0
          ? "none beyond the task's own origin"
          : options.allowedOrigins.join(", ")
      }`,
    ];
    if (state.message) lines.push(state.message);
    return lines.join("\n");
  };

  return [
    {
      name: "browser",
      description: "Show the browser connection, or connect / reconnect",
      run: async (ctx) => {
        const action = ctx.args.trim();
        const controller = new AbortController();
        try {
          if (action === "connect") await runtime.connect(controller.signal);
          else if (action === "reconnect") await runtime.reconnect(controller.signal);
          else if (action.length > 0) {
            return { handled: true, message: "Usage: /browser [connect|reconnect]" };
          }
        } catch (error) {
          return {
            handled: true,
            message: `${report()}\n\ncould not connect — ${describe(error)}`,
          };
        }
        return { handled: true, message: report() };
      },
    },
    {
      name: "tabs",
      description: "List the tabs Mu controls, or select one",
      run: async (ctx) => {
        const wanted = ctx.args.trim();
        const controller = new AbortController();
        try {
          const outcome = await runtime.use(
            (driver) =>
              wanted.length > 0
                ? driver.tabs({ kind: "select", tabId: wanted }, controller.signal)
                : driver.tabs({ kind: "list" }, controller.signal),
            controller.signal,
          );
          const lines = outcome.tabs.map(
            (tab) => `${tab.active ? "*" : " "} ${tab.id}  ${tab.title}  ${tab.url}`,
          );
          return {
            handled: true,
            message: lines.length > 0 ? lines.join("\n") : "No tabs are attached.",
          };
        } catch (error) {
          return { handled: true, message: `could not list tabs — ${describe(error)}` };
        }
      },
    },
    {
      name: "takeover",
      description: "Pause automation and take manual control of the browser",
      run: async (ctx) => {
        const instructions = ctx.args.trim() || "Do what you need to in the browser, then /resume.";
        try {
          await runtime.takeover("user-requested", instructions);
          return { handled: true, message: `${phaseSummary("takeover")}\n${instructions}` };
        } catch (error) {
          return { handled: true, message: `could not pause — ${describe(error)}` };
        }
      },
    },
    {
      name: "resume-browser",
      description: "Re-observe the page and hand control back to the agent after a takeover",
      run: async () => {
        const controller = new AbortController();
        try {
          const observation = await runtime.resume(controller.signal);
          return {
            handled: true,
            message: `Resumed at ${observation.url} (revision ${observation.revision}). Every earlier page reference is now stale.`,
          };
        } catch (error) {
          return { handled: true, message: `could not resume — ${describe(error)}` };
        }
      },
    },
    {
      name: "disconnect",
      description: "End browser access without deleting any browser data",
      run: async () => {
        const owned = runtime.ownership === "owned";
        try {
          await runtime.shutdown();
        } catch (error) {
          return { handled: true, message: `could not disconnect cleanly — ${describe(error)}` };
        }
        return {
          handled: true,
          message: owned
            ? "Closed the browser Mu owns. Its profile directory is untouched."
            : "Detached from your browser. Nothing was closed and no browser data was removed.",
        };
      },
    },
  ];
}
