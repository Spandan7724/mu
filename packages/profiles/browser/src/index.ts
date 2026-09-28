import {
  type AgentMessage,
  type AnyTool,
  customMessage,
  type Profile,
  type ProfileRuntime,
} from "@mu/core";
import { browserPrompt } from "./agent/prompts.ts";
import { defaultLauncher } from "./browser/connect.ts";
import { BrowserManager } from "./browser/manager.ts";
import {
  type BrowserProfileOptions,
  type ResolvedBrowserOptions,
  resolveBrowserOptions,
} from "./config.ts";
import { navigateTool } from "./tools/navigate.ts";
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
  });
  const deps = { browser, config };
  const toolset: AnyTool[] = [navigateTool(deps), tabsTool(deps)] as AnyTool[];
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
    promptFor: browserPrompt,
    permissionDefaults: [],
    environment,
    contextMessages: async () => [environmentMessage(await environment())],
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
