// The same driver conformance suite, against a real browser.
//
// CI never requires a browser: without `MU_BROWSER_LIVE=1` this file registers one
// test that says so and exits. With it, the suite that runs is byte-for-byte the
// one the scripted sidecar runs, which is the whole point of a shared harness.
//
//   MU_BROWSER_LIVE=1 \
//   MU_BROWSER_MCP_RUNTIME=<node on the browser's OS> \
//   MU_BROWSER_MCP_CLI=<@playwright/mcp cli.js, as that OS sees it> \
//   MU_BROWSER_EXECUTABLE=<installed Chrome, as that OS sees it> \
//   MU_BROWSER_LIVE_PROFILE=<Mu-owned user-data dir, as that OS sees it> \
//   MU_BROWSER_LIVE_OUTPUT=<Mu-owned output dir, as that OS sees it> \
//   bun test packages/profiles/browser/src/drivers/mcp/live.test.ts
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import type { DriverContractSetup } from "../../testing/conformance-types.ts";
import {
  registerBrowserDriverContract,
  runBrowserDriverContract,
} from "../../testing/driver-conformance.ts";
import { stdioSidecarLauncher } from "./client.ts";
import { createMcpBrowserDriver, type McpBrowserDriver } from "./driver.ts";
import { liveContractFixture } from "./live-fixture.ts";
import type { McpSidecar } from "./protocol.ts";
import { persistentSidecarArgs, resolveSidecar, sidecarSpec } from "./sidecar.ts";

const LIVE = process.env.MU_BROWSER_LIVE === "1";

interface LiveFixtureHandle {
  url: string;
  crossOrigin: { url: string };
  recorder: { all(): readonly { path: string }[] };
  stop(): Promise<void>;
}

// Resolved at runtime: `@mu/browser-fixture` is a test asset of the workspace, not
// a dependency of the shipped profile, so it must not be a compile-time import.
async function startLiveFixture(): Promise<LiveFixtureHandle> {
  const here = new URL(".", import.meta.url);
  const specifier = new URL("../../../../browser-fixture/src/index.ts", here).href;
  const module = (await import(specifier)) as {
    startFixture: () => Promise<LiveFixtureHandle>;
  };
  return module.startFixture();
}

function liveSidecar(outputDir: string): Promise<McpSidecar> {
  const resolution = resolveSidecar();
  const executablePath = process.env.MU_BROWSER_EXECUTABLE;
  const userDataDir = process.env.MU_BROWSER_LIVE_PROFILE;
  if (executablePath === undefined || userDataDir === undefined) {
    throw new Error(
      "MU_BROWSER_EXECUTABLE and MU_BROWSER_LIVE_PROFILE are required for a live run",
    );
  }
  return stdioSidecarLauncher(
    sidecarSpec(
      resolution,
      persistentSidecarArgs({ browser: "chrome", outputDir, executablePath, userDataDir }),
      { cwd: undefined, startupTimeoutMs: 60_000, callTimeoutMs: 90_000 },
    ),
    new AbortController().signal,
  );
}

if (!LIVE) {
  describe("live browser conformance", () => {
    test("is skipped unless MU_BROWSER_LIVE=1 (CI never requires a browser)", () => {
      expect(LIVE).toBe(false);
    });
  });
} else {
  const outputDir = process.env.MU_BROWSER_LIVE_OUTPUT ?? "";
  const fixture = await startLiveFixture();
  const contract = liveContractFixture({
    origin: fixture.url,
    crossOrigin: fixture.crossOrigin.url,
  });
  let sidecar: McpSidecar | undefined;

  const setup: DriverContractSetup = {
    name: "playwright-mcp (persistent, live browser)",
    createDriver: async () => {
      sidecar = await liveSidecar(outputDir);
      return createMcpBrowserDriver({
        sidecar,
        mode: "persistent",
        browser: "chrome",
        ownership: "owned",
      });
    },
    connectOptions: { mode: "persistent", browser: "chrome" },
    fixture: contract as never,
    capabilities: {
      history: true,
      popups: true,
      dialogs: true,
      // The sidecar runs on the browser's operating system (BD26), so a document
      // path Mu holds is not a path the sidecar can open. Reported skipped rather
      // than passed on a translation Mu cannot make honestly.
      fileUpload: false,
      downloads: true,
      crossOriginFrames: true,
      screenshots: true,
      crashSimulation: true,
      reconnect: true,
      submissionLedger: true,
    },
    simulateConnectionLoss: async (driver) => (driver as McpBrowserDriver).sever(),
    readSubmissions: async () =>
      fixture.recorder.all().map((entry) => ({ path: entry.path, fields: {}, files: [] })),
    teardown: async () => {
      await sidecar?.close();
      sidecar = undefined;
    },
    timeoutMs: 120_000,
  };

  registerBrowserDriverContract({ describe, test }, setup);

  describe("live browser evidence", () => {
    test("the whole suite is reported, pass, skip and fail counted", async () => {
      const report = await runBrowserDriverContract(setup);
      console.log(
        `[live] ${report.setup}: ${report.passed} passed, ${report.skipped} skipped, ${report.failed} failed of ${report.results.length}`,
      );
      for (const result of report.results) {
        if (result.status !== "passed") {
          console.log(`[live] ${result.status}: ${result.id} — ${result.message ?? ""}`);
        }
      }
      expect(report.failed).toBe(0);
    }, 900_000);

    test("a live sidecar writes nothing into the process working directory", async () => {
      const before = (await readdir(process.cwd())).sort();
      const live = await liveSidecar(outputDir);
      const driver = createMcpBrowserDriver({
        sidecar: live,
        mode: "persistent",
        browser: "chrome",
        ownership: "owned",
      });
      const signal = new AbortController().signal;
      await driver.connect({ mode: "persistent", browser: "chrome" }, signal);
      await driver.navigate({ kind: "url", url: contract.pages.form as string }, signal);
      await driver.observe({ screenshot: "viewport" }, signal);
      await driver.disconnect();
      await live.close();
      const after = (await readdir(process.cwd())).sort();
      expect(after).toEqual(before);
      expect(after).not.toContain(".playwright-mcp");
    }, 300_000);
  });

  process.on("beforeExit", () => {
    void fixture.stop();
  });
}
