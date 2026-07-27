import type { AgentMessage, Profile } from "@mu/core";
import type { AgentOptions } from "./agent.ts";

export type { Profile };

// Turns a profile into the Agent options it implies. Kept separate from the
// Agent constructor so a caller can inspect or override any of it.
export async function optionsFromProfile(
  profile: Profile,
  modelRef: string,
  overrides: AgentOptions = {},
): Promise<AgentOptions> {
  const contextMessages: AgentMessage[] = (await profile.contextMessages?.()) ?? [];

  return {
    ...overrides,
    model: overrides.model ?? modelRef,
    systemPrompt: overrides.systemPrompt ?? profile.promptFor(modelRef),
    tools: [...profile.toolset, ...(overrides.tools ?? [])],
    // Profile defaults come first so per-run rules override them (last match wins).
    permissions: [...profile.permissionDefaults, ...(overrides.permissions ?? [])],
    ...(contextMessages.length > 0 ? { initialMessages: contextMessages } : {}),
    ...(profile.carryoverExtractor ? { carryoverExtractor: profile.carryoverExtractor } : {}),
    ...((overrides.checkpointProvider ?? profile.checkpointProvider)
      ? { checkpointProvider: overrides.checkpointProvider ?? profile.checkpointProvider }
      : {}),
  } as AgentOptions;
}

// Profiles are loaded by module specifier so users can ship their own. The SDK
// deliberately does not know about any specific profile: a static import of one
// would invert the dependency direction (cli → sdk → core → ai, with profiles
// loaded at runtime). Surfaces map friendly names to specifiers themselves.
export type ProfileImporter = (specifier: string) => Promise<Record<string, unknown>>;

export async function loadProfile(
  name: string,
  options: Record<string, unknown> = {},
  // Supplied by the caller so the specifier resolves against *its* module
  // context: the SDK has no dependency on any profile package by design.
  importer: ProfileImporter = (specifier) => import(specifier),
): Promise<Profile> {
  const module = await importer(name);
  const factory = module.default ?? module.profile ?? module.codingProfile;
  if (typeof factory === "function") {
    return (await factory(options)) as Profile;
  }
  if (factory && typeof factory === "object" && "toolset" in factory) {
    return factory as Profile;
  }
  throw new Error(`Module "${name}" does not export a profile`);
}
