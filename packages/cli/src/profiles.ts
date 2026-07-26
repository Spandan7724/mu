import { loadProfile, type Profile } from "mu";

// Friendly profile names shipped with mu. Anything else is treated as a module
// specifier, so users can point --profile at their own package.
const BUILT_IN: Record<string, string> = {
  coding: "@mu/profile-coding",
};

// The importer is bound here, in the package that actually depends on the
// shipped profiles.
const importer = (specifier: string) => import(specifier) as Promise<Record<string, unknown>>;

export async function resolveProfile(
  name: string,
  options: Record<string, unknown> = {},
): Promise<Profile> {
  return loadProfile(BUILT_IN[name] ?? name, options, importer);
}

export const DEFAULT_PROFILE = "coding";
