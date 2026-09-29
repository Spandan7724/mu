import { describe, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectManaged } from "../browser/connect.ts";
import { defaultDiscoverDeps, findCandidates } from "../browser/discover.ts";
import { killBrowserProcess } from "../browser/launch.ts";
import type { CdpConnection } from "../cdp/connection.ts";

export const testBrowserPath = findCandidates(undefined, defaultDiscoverDeps())[0]?.path;
const required = process.env.MU_BROWSER_TESTS === "require";

// Real-browser suites skip when no Chrome-family binary exists, unless
// MU_BROWSER_TESTS=require makes the absence a failure.
export function describeWithBrowser(name: string, body: () => void): void {
  if (testBrowserPath) {
    describe(name, body);
    return;
  }
  if (required) {
    describe(name, () => {
      test("requires a Chrome-family browser", () => {
        throw new Error("MU_BROWSER_TESTS=require but no Chrome-family browser was found");
      });
    });
    return;
  }
  describe.skip(`${name} (skipped: no Chrome-family browser found)`, body);
}

const created: string[] = [];
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// Removed when the process exits, whether or not the test cleaned up.
export function tempUserDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mu-browser-test-"));
  created.push(dir);
  return dir;
}

export interface TestBrowser {
  connection: CdpConnection;
  userDataDir: string;
  pid: number | undefined;
  wsUrl: string;
  close: () => Promise<void>;
}

export async function launchTestBrowser(userDataDir = tempUserDataDir()): Promise<TestBrowser> {
  const { connection, endpoint } = await connectManaged({
    userDataDir,
    headless: true,
    viewport: { width: 1280, height: 800 },
    executable: testBrowserPath,
    url: "about:blank",
  });
  return {
    connection,
    userDataDir,
    pid: endpoint.pid,
    wsUrl: endpoint.wsUrl,
    close: async () => {
      await connection.send("Browser.close", undefined, { timeoutMs: 2_000 }).catch(() => {});
      await connection.close();
      killBrowserProcess(endpoint.pid);
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
