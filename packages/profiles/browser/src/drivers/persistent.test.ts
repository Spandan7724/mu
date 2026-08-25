// B8: a live run once confirmed, by hand, that a second `mu-browser` process is refused
// and that the lock is released on clean shutdown. This file turns that confirmation
// into something that fails on its own if the property ever regresses.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserDriverError, isBrowserDriverError } from "../contracts/driver.ts";
import { createFakeBrowserDriver } from "./fake/driver.ts";
import {
  claimProfile,
  OWNERSHIP_FILE,
  persistentProfileDir,
  persistentProfileFactory,
  releaseProfile,
} from "./persistent.ts";

const signal = () => new AbortController().signal;

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-persistent-profile-"));
}

describe("claimProfile / releaseProfile own a profile directory exclusively", () => {
  test("a second live pid is refused, naming the pid and directory the user can act on", async () => {
    const root = await tempRoot();
    try {
      const directory = persistentProfileDir(root, "default");
      await claimProfile(
        directory,
        { pid: 111, startedAt: "2026-08-20T10:00:00.000Z", host: "elsewhere" },
        () => true,
      );
      let caught: unknown;
      try {
        await claimProfile(
          directory,
          { pid: 222, startedAt: "2026-08-22T10:00:00.000Z", host: "here" },
          () => true,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BrowserDriverError);
      const message = (caught as Error).message;
      expect(message).toContain("already owns");
      expect(message).toContain("111");
      expect(message).toContain(directory);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the same pid may re-claim its own directory without being refused by itself", async () => {
    const root = await tempRoot();
    try {
      const directory = persistentProfileDir(root, "default");
      const record = { pid: 111, startedAt: "2026-08-20T10:00:00.000Z", host: "here" };
      await claimProfile(directory, record, () => true);
      // Re-entering the same session (a reconnect) must not be treated as a foreign
      // writer even though isAlive would say yes for this pid too.
      await expect(claimProfile(directory, record, () => true)).resolves.toBeUndefined();
      const stored = JSON.parse(await readFile(join(directory, OWNERSHIP_FILE), "utf8"));
      expect(stored.pid).toBe(111);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stale record from a pid that is no longer alive is reclaimed rather than refused", async () => {
    const root = await tempRoot();
    try {
      const directory = persistentProfileDir(root, "default");
      await claimProfile(
        directory,
        { pid: 999_999, startedAt: "2026-08-20T10:00:00.000Z", host: "elsewhere" },
        () => true,
      );
      await claimProfile(
        directory,
        { pid: 333, startedAt: "2026-08-22T10:00:00.000Z", host: "here" },
        () => false, // the recorded pid is dead
      );
      const stored = JSON.parse(await readFile(join(directory, OWNERSHIP_FILE), "utf8"));
      expect(stored.pid).toBe(333);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a corrupt ownership record fails loudly instead of being silently overwritten", async () => {
    const root = await tempRoot();
    try {
      const directory = persistentProfileDir(root, "default");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, OWNERSHIP_FILE), "{ not json", { mode: 0o600 });
      let caught: unknown;
      try {
        await claimProfile(
          directory,
          { pid: 333, startedAt: "2026-08-22T10:00:00.000Z", host: "here" },
          () => true,
        );
      } catch (error) {
        caught = error;
      }
      expect(isBrowserDriverError(caught)).toBe(true);
      expect((caught as Error).message).toContain("could not read the ownership record");
      // The corrupt record was never silently replaced: it is still there for a human
      // to look at, and the claim did not proceed behind it.
      expect(await readFile(join(directory, OWNERSHIP_FILE), "utf8")).toBe("{ not json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("releasing a directory that was never claimed is a no-op, not a failure", async () => {
    const root = await tempRoot();
    try {
      const directory = persistentProfileDir(root, "default");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await expect(releaseProfile(directory)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("persistentProfileFactory: two mu-browser processes cannot own one profile", () => {
  test("the loser gets an actionable error, and dispose releases the lock for the next session", async () => {
    const root = await tempRoot();
    try {
      const opened: string[] = [];
      const factoryFor = (pid: number) =>
        persistentProfileFactory({
          pid,
          isAlive: () => true, // both simulated processes are genuinely alive
          launch: async () => {
            opened.push(`pid-${pid}`);
            return {
              driver: createFakeBrowserDriver({ mode: "persistent" }),
              close: async () => {},
            };
          },
        });

      const first = await factoryFor(1001)(
        { browser: "chromium", dataRoot: root, userDataDir: "work" },
        signal(),
      );
      expect(opened).toEqual(["pid-1001"]);

      // A second, genuinely concurrent process (a different pid, alive) must be refused
      // rather than corrupting the profile by launching a second browser onto it.
      await expect(
        factoryFor(2002)({ browser: "chromium", dataRoot: root, userDataDir: "work" }, signal()),
      ).rejects.toThrow(/already owns/);
      expect(opened).toEqual(["pid-1001"]); // the second launcher was never reached

      await first.dispose();
      const directory = persistentProfileDir(root, "work");
      await expect(readFile(join(directory, OWNERSHIP_FILE), "utf8")).rejects.toThrow();

      // With the lock released, a fresh session (any pid) may now claim it.
      const third = await factoryFor(2002)(
        { browser: "chromium", dataRoot: root, userDataDir: "work" },
        signal(),
      );
      expect(opened).toEqual(["pid-1001", "pid-2002"]);
      await third.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the lock is still released even when the launcher itself throws", async () => {
    const root = await tempRoot();
    try {
      const factory = persistentProfileFactory({
        pid: 1001,
        isAlive: () => true,
        launch: async () => {
          throw new Error("the browser binary is missing");
        },
      });
      await expect(
        factory({ browser: "chromium", dataRoot: root, userDataDir: "work" }, signal()),
      ).rejects.toThrow("the browser binary is missing");
      const directory = persistentProfileDir(root, "work");
      await expect(readFile(join(directory, OWNERSHIP_FILE), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
