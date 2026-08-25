// Public programmatic surface of @mu-agent/browser.
//
// It re-exports the shared Mu SDK plus the browser profile's own entry points.
// It deliberately does not re-export the internal CLI runtime, the driver
// implementations, or anything from the coding product.

import {
  type BrowserProfile,
  type BrowserProfileOptions,
  browserProfile,
} from "@mu/profile-browser/profile";
import { Agent, type AgentOptions, defaultModelRef, optionsFromProfile, type Profile } from "mu";

export {
  BROWSER_PERMISSION_DEFAULTS,
  BROWSER_PERMISSION_MODES,
  BROWSER_PERMISSION_SCOPES,
  BROWSER_PROFILE_NAME,
  browserArtifactsDir,
  browserConfigPath,
  browserDataDir,
  browserDataLayout,
  browserProfile,
  browserProfilesDir,
  browserPrompt,
  browserSessionsDir,
  DEFAULT_BROWSER_PERMISSION_MODE,
} from "@mu/profile-browser/profile";
export * from "mu";
export type { BrowserProfile, BrowserProfileOptions };
export type {
  ActionOutcome,
  BrowserConnectionMode,
  BrowserConnectionPhase,
  BrowserConnectionState,
  BrowserDriver,
  BrowserElement,
  BrowserElementRef,
  BrowserFamily,
  BrowserObservation,
  BrowserReceipt,
  BrowserTab,
  TakeoverReason,
} from "@mu/profile-browser";
export { BrowserDriverError, connectionSummary, isBrowserDriverError } from "@mu/profile-browser";
export type {
  BrowserDriverFactory,
  BrowserDriverHandle,
} from "@mu/profile-browser/drivers";
export type { BrowserRuntime } from "@mu/profile-browser/runtime";
export { acceptsModelActions, phaseSummary } from "@mu/profile-browser/runtime";

export interface CreateBrowserAgentOptions extends AgentOptions {
  profile?: "browser" | Profile;
  profileOptions?: BrowserProfileOptions;
}

function modelRefFor(options: AgentOptions): string {
  if (typeof options.model === "string") return options.model;
  if (options.model) return `${options.model.provider}/${options.model.id}`;
  return defaultModelRef();
}

export async function createBrowserAgent(options: CreateBrowserAgentOptions = {}): Promise<Agent> {
  const { profile, profileOptions, ...agentOptions } = options;
  const resolved =
    profile === undefined || profile === "browser" ? await browserProfile(profileOptions) : profile;
  return new Agent(await optionsFromProfile(resolved, modelRefFor(agentOptions), agentOptions));
}
