import {
  type AgentMessage,
  type AnyTool,
  customMessage,
  type Profile,
  type ProfileRuntime,
} from "@mu/core";
import { TodoStore, todoTool } from "mu";
import { hostOf } from "./actions/navigate.ts";
import { recordingCommits } from "./agent/ledger.ts";
import { notesTool } from "./agent/notes.ts";
import {
  BROWSER_PERMISSION_DEFAULTS,
  browserPermissionModes,
  hostRules,
  loadRememberedPermissions,
  rememberAllow,
} from "./agent/permissions.ts";
import { BROWSER_SIDE_BOUNDARY, BROWSER_TASK_PROMPT, browserPrompt } from "./agent/prompts.ts";
import { BrowserState, type CommitLedger, formatNotes, type NotesStore } from "./agent/state.ts";
import { defaultLauncher } from "./browser/connect.ts";
import { BrowserManager } from "./browser/manager.ts";
import { browserCommands } from "./commands.ts";
import {
  type BrowserProfileOptions,
  type ResolvedBrowserOptions,
  resolveBrowserOptions,
} from "./config.ts";
import { jevFromEnv } from "./jev/client.ts";
import { visionEnabled } from "./page/screenshot.ts";
import type { SecretRegistry } from "./page/secrets.ts";
import { actFirstTools, actTool } from "./tools/act.ts";
import { delegateTool } from "./tools/delegate.ts";
import { fileTools } from "./tools/files.ts";
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
    workspace: config.workspace,
    userHome: config.home,
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

const PAGE_CONTENT = /<page_content untrusted="true">([\s\S]*?)<\/page_content>/g;

// Records which site each piece of page text the model sees came from, and the
// links it saw, so cross-site data flows can be recognised.
function observingDataFlow(tool: AnyTool, browser: BrowserManager): AnyTool {
  return {
    ...tool,
    execute: async (...args) => {
      const result = await tool.execute(...args);
      const tab = browser.currentTab();
      if (!tab) return result;
      for (const link of tab.links) browser.dataflow.link(link);
      tab.links.clear();
      const host = hostOf(tab.url);
      for (const block of result.content) {
        if (block.type !== "text") continue;
        for (const match of block.text.matchAll(PAGE_CONTENT))
          browser.dataflow.observe(host, match[1] ?? "");
      }
      return result;
    },
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
  const state = new BrowserState();
  const hosts = hostRules(config.allowedHosts, config.blockedHosts);
  const todos = new TodoStore();
  const jev = config.jev === "off" ? undefined : jevFromEnv();
  // One agent's tools over one lane of the browser: the main agent's, or a sub-task's.
  const toolsFor = (lane: BrowserManager, laneState: BrowserState, laneTodos: TodoStore) => {
    const deps = {
      browser: lane,
      config,
      vision: () => visionEnabled(config.vision, activeModel),
      notes: () => formatNotes(laneState.notes.entries()),
    };
    const interaction = interactionTools(deps);
    const rawTools: AnyTool[] = [
      navigateTool(deps),
      interaction.click,
      interaction.type,
      interaction.fill,
      ...(jev ? [actTool(deps, jev)] : []),
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
      todoTool(laneTodos),
      notesTool(laneState),
      ...fileTools(config.workspace),
      delegateTool({
        command: config.codingCommand,
        workspace: config.workspace,
        model: () => activeModel,
        pageText: (text) => lane.dataflow.leak(text, "")?.from,
      }),
    ] as AnyTool[];
    return (jev ? actFirstTools(rawTools, deps) : rawTools).map((candidate) =>
      observingDataFlow(
        redacting(recordingCommits(candidate, lane, laneState), lane.secrets),
        lane,
      ),
    );
  };
  const toolset = toolsFor(browser, state, todos);
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
      return browserPrompt(modelRef, { act: jev !== undefined });
    },
    refreshContext: (messages, context) => {
      browser.dataflow.userSaid(
        messages
          .filter((message) => message.role === "user")
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          )
          .join("\n"),
      );
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
    // Each task subagent works in a lane of its own: its own window and tabs, notes
    // and todo list, with the session's ledger, secrets and data-flow record.
    subagents: {
      inspectionTools: [],
      taskSession: async (description, signal) => {
        const lane = await browser.openLane(description, signal);
        const laneState = new BrowserState(state.ledger);
        return {
          tools: toolsFor(lane, laneState, new TodoStore()),
          prompt: BROWSER_TASK_PROMPT,
          // The brief is written by the main agent, possibly from page text, so it
          // never counts as the user's own words for the data-flow check.
          refreshContext: async (messages) => [
            ...(messages.some(
              (message) => message.role === "custom" && message.customType === "environment",
            )
              ? []
              : [environmentMessage({ ...(await environment()), subTask: description })]),
            ...laneState.snapshotIfChanged(messages),
          ],
          close: () => lane.release(),
        };
      },
    },
    commands: browserCommands(browser, state.ledger),
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
export { closeManaged, managedState } from "./browser/connect.ts";
export { discoverBrowser } from "./browser/discover.ts";
export { launchForSignIn } from "./browser/launch.ts";
export default browserProfile;
