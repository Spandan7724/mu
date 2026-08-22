// ARCHITECTURE §3. Async because it validates configuration, prepares private
// storage and constructs the runtime that owns the connection.
import { homedir } from "node:os";
import type { AgentMessage, Profile, SessionEnvironment } from "@mu/core";
import { browserCommands } from "../commands/index.ts";
import type { BrowserCarryover } from "../contracts/carryover.ts";
import type { BrowserDriverFactory } from "../drivers/factory.ts";
import { browserRenderers } from "../renderers/index.ts";
import { BrowserRuntime } from "../runtime/runtime.ts";
import { browserDataDir, ensureBrowserDataRoot } from "./data.ts";
import { browserEnvironment, connectionMessage, environmentMessage } from "./environment.ts";
import {
  type BrowserProfileOptions,
  type ResolvedBrowserProfileOptions,
  resolveBrowserProfileOptions,
} from "./options.ts";
import {
  BROWSER_PERMISSION_DEFAULTS,
  BROWSER_PERMISSION_MODES,
  DEFAULT_BROWSER_PERMISSION_MODE,
} from "./permissions.ts";
import { browserPrompt } from "./prompt.ts";
import { browserToolset } from "./tools.ts";

export const BROWSER_PROFILE_NAME = "browser";

export interface BrowserProfile extends Profile {
  runtime: BrowserRuntime;
  options: ResolvedBrowserProfileOptions;
  dataRoot: string;
}

// Only used when a caller supplies no factory. It fails with an actionable
// message instead of silently doing nothing, because a driver that connects to
// nothing is worse than one that says why it cannot.
const unconfiguredFactory: BrowserDriverFactory = async (options) => {
  throw new Error(
    `No browser driver is configured for ${options.connection} mode. Pass a driver factory, or use the fake driver for a deterministic session.`,
  );
};

export async function browserProfile(options: BrowserProfileOptions = {}): Promise<BrowserProfile> {
  const resolved = resolveBrowserProfileOptions(options);
  const home = options.home ?? homedir();
  const diagnostics: string[] = [];
  let dataRoot = options.dataRoot ?? browserDataDir(home);
  if (options.dataRoot === undefined) {
    try {
      dataRoot = await ensureBrowserDataRoot(home);
    } catch (error) {
      diagnostics.push(
        `could not prepare ${dataRoot}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const runtime = new BrowserRuntime({
    factory: options.factory ?? unconfiguredFactory,
    connection: resolved.connection,
    browser: resolved.browser,
    dataRoot,
    headless: resolved.headless,
    ...(resolved.userDataDir === undefined ? {} : { userDataDir: resolved.userDataDir }),
    ...(resolved.extensionToken === undefined ? {} : { extensionToken: resolved.extensionToken }),
  });

  const environment: SessionEnvironment = browserEnvironment({ options: resolved, dataRoot });

  const { tools } = browserToolset({
    runtime,
    allowedOrigins: resolved.allowedOrigins ?? [],
    mode: DEFAULT_BROWSER_PERMISSION_MODE,
  });

  return {
    name: BROWSER_PROFILE_NAME,
    toolset: tools,
    promptFor: browserPrompt,
    permissionDefaults: BROWSER_PERMISSION_DEFAULTS,
    permissionModes: BROWSER_PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_BROWSER_PERMISSION_MODE,
    renderers: browserRenderers,
    commands: browserCommands({ runtime, options: resolved, dataRoot }),
    environment: () => environment,
    contextMessages: (): AgentMessage[] => [
      environmentMessage(environment),
      connectionMessage(runtime.description, resolved.connection),
    ],
    diagnostics,
    // What compaction must not lose: where the browser is, what was already done
    // to the page, and what is still owed. Labels, ids and origins only — no
    // values, so the carryover is safe to persist (BD22).
    carryoverExtractor: (): BrowserCarryover => {
      const state = runtime.status();
      return {
        connection: { mode: state.mode, browser: state.browser, phase: state.phase },
        allowedOrigins: [...resolved.allowedOrigins],
        completedSteps: [],
        outstandingSteps: [],
        filledFields: [],
        unresolvedQuestions: [],
        uploadedDocumentIds: [],
      };
    },
    // Sessions group under the connection they were run against, inside the
    // browser product's own session root.
    scope: () => `${resolved.connection}-${resolved.browser}`,
    // No checkpoint provider, deliberately. A submitted form, a sent message or a
    // deleted record cannot be rolled back, and claiming otherwise would make
    // /undo a lie (BD17).
    runtime,
    options: resolved,
    dataRoot,
  };
}
