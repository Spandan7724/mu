import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FileSessionStore, type Profile } from "mu";

// A profile that is not shipped with a product is a module specifier the user
// supplies. Path-like specifiers resolve against the invocation directory;
// bare ones stay bare so the importing package's resolution applies.
export function profileModuleSpecifier(specifier: string, cwd = process.cwd()): string {
  return isAbsolute(specifier) || specifier.startsWith(".")
    ? pathToFileURL(resolve(cwd, specifier)).href
    : specifier;
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
