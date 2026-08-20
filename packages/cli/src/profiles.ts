import { profileModuleSpecifier } from "@mu/cli-runtime";
import { codingProfile } from "@mu/profile-coding";
import { loadProfile, type Profile } from "mu";

// Profiles shipped with mu are imported statically so the bundler can see them.
// A runtime-string import works under `bun run` but not inside a
// `bun build --compile` binary, where it fails with "cannot find module".
const BUILT_IN: Record<string, (options: Record<string, unknown>) => Promise<Profile>> = {
  coding: (options) => codingProfile(options as Parameters<typeof codingProfile>[0]),
};

// Anything not shipped with mu is a module specifier the user supplies, loaded
// dynamically against this package's resolution.
const importer = (specifier: string) =>
  import(profileModuleSpecifier(specifier)) as Promise<Record<string, unknown>>;

export async function resolveProfile(
  name: string,
  options: Record<string, unknown> = {},
): Promise<Profile> {
  const builtIn = BUILT_IN[name];
  if (builtIn) return builtIn(options);
  return loadProfile(name, options, importer);
}

export const DEFAULT_PROFILE = "coding";

export function profileOptionsFromArgs(args: {
  noInstructions?: boolean;
}): Record<string, unknown> {
  return args.noInstructions ? { instructions: { enabled: false } } : {};
}
