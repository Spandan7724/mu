// The Mu-owned persistent-profile factory. It never points automation at the
// user's normal browser profile (BD7): the only user-data directory it will ever
// name is one inside the browser product's own data root, and it takes an
// exclusive lock on that directory before anything is launched.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AuthorizedDocument } from "../contracts/documents.ts";
import { BrowserDriverError } from "../contracts/driver.ts";
import type { BrowserDriverFactory, BrowserDriverHandle } from "./factory.ts";

export const OWNERSHIP_FILE = "owner.json";

export interface ProfileOwnershipRecord {
  pid: number;
  startedAt: string;
  host: string;
}

export interface PersistentProfileFactoryOptions {
  // Injected so the lifecycle is testable without launching a browser. B2 ships
  // the ownership, path and shutdown rules; the launcher itself arrives with the
  // production adapter.
  launch: (context: {
    userDataDir: string;
    browser: string;
    headless: boolean;
    documents?: readonly AuthorizedDocument[] | undefined;
    signal: AbortSignal;
  }) => Promise<{ driver: BrowserDriverHandle["driver"]; close: () => Promise<void> }>;
  pid?: number;
  hostname?: string;
  isAlive?: (pid: number) => boolean;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A profile directory is only ever addressed relative to the product's data root,
// so no configuration value can walk out of it and reach a real Chrome profile.
export function persistentProfileDir(dataRoot: string, name: string): string {
  const root = resolve(dataRoot, "profiles");
  const target = resolve(root, name);
  const inside = relative(root, target);
  if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) {
    throw new BrowserDriverError(
      "unsupported",
      `"${name}" is not a Mu-owned browser profile name; profiles live under ${root}`,
    );
  }
  return target;
}

export async function claimProfile(
  directory: string,
  record: ProfileOwnershipRecord,
  isAlive: (pid: number) => boolean,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, OWNERSHIP_FILE);
  try {
    const existing = JSON.parse(await readFile(lock, "utf8")) as ProfileOwnershipRecord;
    if (existing.pid !== record.pid && isAlive(existing.pid)) {
      throw new BrowserDriverError(
        "unsupported",
        `another Mu browser (pid ${existing.pid}, started ${existing.startedAt}) already owns ${directory}. Close it, or start this session with a different profile.`,
      );
    }
  } catch (error) {
    if (error instanceof BrowserDriverError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new BrowserDriverError(
        "unsupported",
        `could not read the ownership record at ${lock}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await writeFile(lock, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function releaseProfile(directory: string): Promise<void> {
  await rm(join(directory, OWNERSHIP_FILE), { force: true });
}

export function persistentProfileFactory(
  options: PersistentProfileFactoryOptions,
): BrowserDriverFactory {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  return async (factoryOptions, signal) => {
    if (factoryOptions.connection !== "persistent") {
      throw new BrowserDriverError(
        "unsupported",
        "the persistent-profile factory only serves persistent connections",
      );
    }
    const directory = persistentProfileDir(
      factoryOptions.dataRoot,
      factoryOptions.userDataDir ?? "default",
    );
    await claimProfile(
      directory,
      { pid, startedAt: new Date().toISOString(), host: options.hostname ?? "local" },
      isAlive,
    );
    let launched: Awaited<ReturnType<PersistentProfileFactoryOptions["launch"]>>;
    try {
      launched = await options.launch({
        userDataDir: directory,
        browser: factoryOptions.browser,
        headless: factoryOptions.headless === true,
        ...(factoryOptions.documents === undefined ? {} : { documents: factoryOptions.documents }),
        signal,
      });
    } catch (error) {
      await releaseProfile(directory);
      throw error;
    }
    return {
      driver: launched.driver,
      ownership: "owned",
      description: `${factoryOptions.browser} with the Mu profile at ${directory}`,
      dispose: async () => {
        // BD29: the browser Mu owns is closed and awaited before the lock goes,
        // so the last profile write is on disk before another session can claim it.
        try {
          await launched.close();
        } finally {
          await releaseProfile(directory);
        }
      },
    };
  };
}
