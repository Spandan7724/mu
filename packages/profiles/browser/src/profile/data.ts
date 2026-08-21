// The browser product's private storage (SECURITY §11). It is a sibling of the
// coding product's `~/.mu` state, never a child of it and never the same file:
// browser permission policy, authorized documents, origin rules and receipts must
// not be readable as coding-session configuration.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DIRECTORY_MODE = 0o700;
export const SENSITIVE_FILE_MODE = 0o600;

export function muDataDir(home = homedir()): string {
  return join(home, ".mu");
}

export function browserDataDir(home = homedir()): string {
  return join(muDataDir(home), "browser");
}

export function browserConfigPath(home = homedir()): string {
  return join(browserDataDir(home), "config.json");
}

export function browserModelCatalogPath(home = homedir()): string {
  return join(browserDataDir(home), "models.json");
}

export function browserSessionsDir(home = homedir()): string {
  return join(browserDataDir(home), "sessions");
}

export function browserProfilesDir(home = homedir()): string {
  return join(browserDataDir(home), "profiles");
}

export function browserArtifactsDir(home = homedir()): string {
  return join(browserDataDir(home), "artifacts");
}

export function browserLogsDir(home = homedir()): string {
  return join(browserDataDir(home), "logs");
}

export function browserDataLayout(home = homedir()): Record<string, string> {
  return {
    root: browserDataDir(home),
    config: browserConfigPath(home),
    sessions: browserSessionsDir(home),
    profiles: browserProfilesDir(home),
    artifacts: browserArtifactsDir(home),
    logs: browserLogsDir(home),
  };
}

// Windows has no POSIX mode bits; chmod there is a no-op that still succeeds, so
// the calls are unconditional and the failure path stays a real failure.
export async function ensureBrowserDataRoot(home = homedir()): Promise<string> {
  const root = browserDataDir(home);
  for (const directory of [
    root,
    browserSessionsDir(home),
    browserProfilesDir(home),
    browserArtifactsDir(home),
    browserLogsDir(home),
  ]) {
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directory, DIRECTORY_MODE).catch(() => {});
  }
  return root;
}

export async function writePrivateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: SENSITIVE_FILE_MODE });
  await chmod(path, SENSITIVE_FILE_MODE).catch(() => {});
}
