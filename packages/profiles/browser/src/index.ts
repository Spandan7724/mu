import type { AnyTool, Profile } from "@mu/core";
import { browserPrompt } from "./agent/prompts.ts";

export interface BrowserProfileOptions {
  browserProfile?: string;
}

export interface BrowserProfile extends Profile {}

export async function browserProfile(options: BrowserProfileOptions = {}): Promise<BrowserProfile> {
  const profileName = options.browserProfile ?? "default";
  const toolset: AnyTool[] = [];
  return {
    name: "browser",
    toolset,
    promptFor: browserPrompt,
    permissionDefaults: [],
    scope: () => `browser-${profileName}`,
  };
}

export default browserProfile;
