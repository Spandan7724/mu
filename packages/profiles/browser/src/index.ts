import {
  type AgentMessage,
  type AnyTool,
  customMessage,
  type Profile,
  type ProfileRuntime,
} from "@mu/core";
import {
  BROWSER_PERMISSION_DEFAULTS,
  browserPermissionModes,
  hostRules,
  loadRememberedPermissions,
  rememberAllow,
} from "./agent/permissions.ts";
import { BROWSER_SIDE_BOUNDARY, browserPrompt } from "./agent/prompts.ts";
import { defaultLauncher } from "./browser/connect.ts";
import { BrowserManager } from "./browser/manager.ts";
import {
  type BrowserProfileOptions,
  type ResolvedBrowserOptions,
  resolveBrowserOptions,
} from "./config.ts";
import { visionEnabled } from "./page/screenshot.ts";
import { interactionTools } from "./tools/interact.ts";
import { navigateTool } from "./tools/navigate.ts";
import { findTool, readPageTool, screenshotTool, snapshotTool } from "./tools/observe.ts";
import { tabsTool } from "./tools/tabs.ts";

export interface BrowserProfile extends Profile {
  browser: BrowserManager;
  config: ResolvedBrowserOptions;
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
  const toolset: AnyTool[] = [
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
  ] as AnyTool[];
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
    // The model can change mid-session; the latest assistant turn names it.
    refreshContext: (messages) => {
      const last = messages.findLast((message) => message.role === "assistant");
      if (last?.role === "assistant" && last.model) activeModel = last.model;
      return [];
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
    diagnostics,
    runtime,
    scope: () => `browser-${config.browserProfile}`,
    browser,
    config,
  };
}

export type { BrowserProfileOptions, ResolvedBrowserOptions };
export { BrowserManager };
export default browserProfile;
