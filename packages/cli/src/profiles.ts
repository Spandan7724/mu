import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserProfile } from "@mu/profile-browser";
import { codingProfile } from "@mu/profile-coding";
import { FileSessionStore, loadProfile, type Profile } from "mu";
import { currentExecutableCommand } from "./agent-supervisor.ts";

// Profiles shipped with mu are imported statically so the bundler can see them.
// A runtime-string import works under `bun run` but not inside a
// `bun build --compile` binary, where it fails with "cannot find module".
const BUILT_IN: Record<string, (options: Record<string, unknown>) => Promise<Profile>> = {
  coding: (options) => codingProfile(options as Parameters<typeof codingProfile>[0]),
  browser: (options) => browserProfile(options as Parameters<typeof browserProfile>[0]),
};

// Anything not shipped with mu is a module specifier the user supplies, loaded
// dynamically against this package's resolution.
export function profileModuleSpecifier(specifier: string, cwd = process.cwd()): string {
  return isAbsolute(specifier) || specifier.startsWith(".")
    ? pathToFileURL(resolve(cwd, specifier)).href
    : specifier;
}

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

export interface BrowserFlags {
  browserProfile?: string | undefined;
  cdpUrl?: string | undefined;
  headless?: boolean | undefined;
}

export function browserFlags(args: BrowserFlags): BrowserFlags {
  return {
    ...(args.browserProfile ? { browserProfile: args.browserProfile } : {}),
    ...(args.cdpUrl ? { cdpUrl: args.cdpUrl } : {}),
    ...(args.headless ? { headless: true } : {}),
  };
}

export function profileOptionsFromArgs(
  args: { noInstructions?: boolean; browser?: BrowserFlags | undefined },
  profile = DEFAULT_PROFILE,
): Record<string, unknown> {
  if (profile === "browser")
    return { ...browserFlags(args.browser ?? {}), codingCommand: currentExecutableCommand([]) };
  return args.noInstructions ? { instructions: { enabled: false } } : {};
}

export async function sessionStoreForProfile(
  profile: Profile,
  root?: string,
): Promise<FileSessionStore> {
  const scope = await profile.scope?.();
  return new FileSessionStore({
    ...(root ? { root } : {}),
    ...(scope ? { scope } : {}),
  });
}
