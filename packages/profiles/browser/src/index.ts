import {
  type AgentMessage,
  type AnyTool,
  customMessage,
  type Profile,
  type ProfileRuntime,
} from "@mu/core";
import { TodoStore, todoTool } from "mu";
import { recordingCommits } from "./agent/ledger.ts";
import { notesTool } from "./agent/notes.ts";
import {
  BROWSER_PERMISSION_DEFAULTS,
  browserPermissionModes,
  hostRules,
  loadRememberedPermissions,
  rememberAllow,
} from "./agent/permissions.ts";
import { BROWSER_SIDE_BOUNDARY, browserPrompt } from "./agent/prompts.ts";
import { BrowserState, type CommitLedger, type NotesStore } from "./agent/state.ts";
import { defaultLauncher } from "./browser/connect.ts";
import { BrowserManager } from "./browser/manager.ts";
import {
  type BrowserProfileOptions,
  type ResolvedBrowserOptions,
  resolveBrowserOptions,
} from "./config.ts";
import { visionEnabled } from "./page/screenshot.ts";
import type { SecretRegistry } from "./page/secrets.ts";
import { interactionTools } from "./tools/interact.ts";
import { navigateTool } from "./tools/navigate.ts";
import { findTool, readPageTool, screenshotTool, snapshotTool } from "./tools/observe.ts";
import { tabsTool } from "./tools/tabs.ts";

export interface BrowserProfile extends Profile {
  browser: BrowserManager;
  config: ResolvedBrowserOptions;
  todos: TodoStore;
  notes: NotesStore;
  ledger: CommitLedger;
}

export async function browserEnvironment(
  config: ResolvedBrowserOptions,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
    browserProfile: config.browserProfile,
    connection:
      config.connect === "cdp" ? `cdp endpoint ${config.cdpUrl}` : "managed persistent profile",
    headless: String(config.headless),
    vision: config.vision,
  };
  if (config.connect === "managed") {
    try {
      const found = await (config.launcher ?? defaultLauncher).discover({
        executable: config.executable,
        channel: config.channel,
      });
      env.browser = `${found.product} ${found.version}`;
      env.executable = found.path;
    } catch (error) {
      env.browser = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return env;
}

export function environmentMessage(env: Record<string, string>): AgentMessage {
  const lines = Object.entries(env).map(([key, value]) => `${key}: ${value}`);
  return {
    ...customMessage("environment", `Browser session environment:\n${lines.join("\n")}`),
    retention: { key: "environment" },
  };
}

// Scrubs known secret values from everything a browser tool hands back.
function redacting(tool: AnyTool, secrets: SecretRegistry): AnyTool {
  const { permissionDetails } = tool;
  return {
    ...tool,
    execute: async (...args) => {
      const result = await tool.execute(...args);
      if (secrets.size === 0) return result;
      return {
        ...result,
        content: result.content.map((block) =>
          block.type === "text" ? { ...block, text: secrets.redact(block.text) } : block,
        ),
        ...(result.details !== undefined ? { details: secrets.redactDeep(result.details) } : {}),
        ...(result.retention
          ? {
              retention: { ...result.retention, summary: secrets.redact(result.retention.summary) },
            }
          : {}),
      };
    },
    ...(permissionDetails
      ? {
          permissionDetails: async (args: unknown) =>
            secrets.redactDeep(await permissionDetails(args)),
        }
      : {}),
  };
}

export async function browserProfile(options: BrowserProfileOptions = {}): Promise<BrowserProfile> {
  const diagnostics: string[] = [];
  const config = resolveBrowserOptions(options, (message) => diagnostics.push(message));
  const browser = new BrowserManager({
    connect: config.connect,
    profileName: config.browserProfile,
    userDataDir: config.userDataDir,
    cdpUrl: config.cdpUrl,
    executable: config.executable,
    channel: config.channel,
    headless: config.headless,
    viewport: config.viewport,
    keepOpen: config.keepOpen,
    launcher: config.launcher,
    downloadsDir: config.downloadsDir,
  });
  let activeModel: string | undefined;
  const deps = {
    browser,
    config,
    vision: () => visionEnabled(config.vision, activeModel),
  };
  const interaction = interactionTools(deps);
  const hosts = hostRules(config.allowedHosts, config.blockedHosts);
  const todos = new TodoStore();
  const state = new BrowserState();
  const rawTools: AnyTool[] = [
    navigateTool(deps),
    interaction.click,
    interaction.type,
    interaction.fill,
    interaction.select,
    interaction.press,
    interaction.scroll,
    interaction.hover,
    interaction.drag,
    interaction.upload,
    interaction.dialog,
    tabsTool(deps),
    snapshotTool(deps),
    screenshotTool(deps),
    readPageTool(deps),
    findTool(deps),
    interaction.wait,
    interaction.evaluate,
    interaction.clickXy,
    interaction.downloads,
    todoTool(todos),
    notesTool(state),
  ] as AnyTool[];
  const toolset = rawTools.map((candidate) =>
    redacting(recordingCommits(candidate, browser, state), browser.secrets),
  );
  const runtime: ProfileRuntime = {
    attach: () => {},
    stop: () => browser.stop(),
    shutdown: () => browser.shutdown(),
  };
  let environmentPromise: Promise<Record<string, string>> | undefined;
  const environment = () => {
    environmentPromise ??= browserEnvironment(config);
    return environmentPromise;
  };

  return {
    name: "browser",
    toolset,
    promptFor: (modelRef) => {
      activeModel = modelRef;
      return browserPrompt(modelRef);
    },
    refreshContext: (messages, context) => {
      // The model can change mid-session; the latest assistant turn names it.
      const last = messages.findLast((message) => message.role === "assistant");
      if (last?.role === "assistant" && last.model) activeModel = last.model;
      // In-process state is authoritative; the transcript is read back only when a
      // different session (a resume) starts using this profile.
      if (state.sessionId !== context.sessionId) {
        state.rebuild(messages);
        state.sessionId = context.sessionId;
      }
      return state.snapshotIfChanged(messages);
    },
    permissionDefaults: [
      ...BROWSER_PERMISSION_DEFAULTS,
      ...loadRememberedPermissions(config.home, (message) => diagnostics.push(message)),
      ...hosts,
    ],
    permissionModes: browserPermissionModes(hosts),
    defaultPermissionMode: "default",
    rememberPermission: (permission, pattern) => {
      rememberAllow(config.home, permission, pattern);
    },
    environment,
    contextMessages: async () => [environmentMessage(await environment())],
    sideBoundary: () => BROWSER_SIDE_BOUNDARY,
    // What compaction must not lose: where the browser is, the plan, collected data, and
    // every consequential action already performed.
    carryoverExtractor: () => {
      const active = browser.tabs().find((tab) => tab.active);
      return {
        browser: {
          ...(active ? { url: active.url, title: active.title } : {}),
          tabs: browser.tabs().map((tab) => ({
            tabId: tab.tabId,
            url: tab.url,
            title: tab.title,
            active: tab.active,
          })),
        },
        todo: todos.all(),
        notes: state.notes.entries(),
        commitsAlreadyPerformed: state.ledger.records().map((record) => ({
          at: new Date(record.at).toISOString(),
          host: record.host,
          action: record.action,
          target: record.target,
        })),
      };
    },
    diagnostics,
    runtime,
    scope: () => `browser-${config.browserProfile}`,
    browser,
    config,
    todos,
    notes: state.notes,
    ledger: state.ledger,
  };
}

export type { BrowserProfileOptions, ResolvedBrowserOptions };
export { BrowserManager };
export default browserProfile;
