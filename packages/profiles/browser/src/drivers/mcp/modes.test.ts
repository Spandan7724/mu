import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBrowserDriverError } from "../../contracts/driver.ts";
import { browserArtifactsDir } from "../../profile/data.ts";
import { mcpPersistentFactory, mcpPersistentLaunch, sidecarOutputDir } from "./modes.ts";
import type { McpSidecar, McpSidecarSpec } from "./protocol.ts";
import { createScriptedSidecar } from "./scripted.ts";
import { SIDECAR_CLI_ENV, SIDECAR_RUNTIME_ENV } from "./sidecar.ts";
import { persistentTopology } from "./topology.ts";

const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mu-browser-modes-"));
  temporaries.push(directory);
  return directory;
}

afterAll(async () => {
  for (const directory of temporaries) await rm(directory, { recursive: true, force: true });
});

interface Recorded {
  specs: McpSidecarSpec[];
  sidecars: ReturnType<typeof createScriptedSidecar>[];
}

function recorder(): {
  recorded: Recorded;
  launcher: (spec: McpSidecarSpec) => Promise<McpSidecar>;
} {
  const recorded: Recorded = { specs: [], sidecars: [] };
  return {
    recorded,
    launcher: async (spec) => {
      recorded.specs.push(spec);
      const sidecar = createScriptedSidecar();
      recorded.sidecars.push(sidecar);
      return sidecar;
    },
  };
}

const environment: Record<string, string | undefined> = {
  [SIDECAR_CLI_ENV]: "/opt/mcp/cli.js",
  [SIDECAR_RUNTIME_ENV]: "/usr/bin/node",
};

describe("the sidecar writes only into Mu's private artifact root (SECURITY §11)", () => {
  test("the output directory defaults under the browser data root, not the process cwd", async () => {
    const home = await scratch();
    expect(sidecarOutputDir({ home })).toBe(join(browserArtifactsDir(home), "sidecar"));
    expect(sidecarOutputDir({ home }).startsWith(process.cwd())).toBe(false);
  });

  test("persistent mode pins output under the private root and can reach staged documents", async () => {
    const home = await scratch();
    const { recorded, launcher } = recorder();
    const launch = mcpPersistentLaunch({
      home,
      launcher,
      resolve: { env: environment },
      discover: { platform: "linux", env: { MU_BROWSER_EXECUTABLE: "/usr/bin/google-chrome" } },
    });
    const launched = await launch({
      userDataDir: join(home, ".mu", "browser", "profiles", "default"),
      browser: "chrome",
      headless: false,
      signal: new AbortController().signal,
    });
    const spec = recorded.specs[0] as McpSidecarSpec;
    const expected = join(browserArtifactsDir(home), "sidecar");
    expect(spec.args[spec.args.indexOf("--output-dir") + 1]).toBe(expected);
    expect(spec.cwd).toBe(join(home, ".mu", "browser"));
    // And the directory really exists, private, before the helper is started.
    const mode = (await stat(expected)).mode & 0o777;
    expect(mode).toBe(0o700);
    await launched.close();
  });

  test("starting a sidecar creates nothing in the process working directory", async () => {
    const home = await scratch();
    const cwd = await scratch();
    const before = (await readdir(cwd)).sort();
    const { launcher } = recorder();
    const launch = mcpPersistentLaunch({
      home,
      launcher,
      resolve: { env: environment },
      discover: { platform: "linux", env: { MU_BROWSER_EXECUTABLE: "/usr/bin/google-chrome" } },
    });
    const launched = await launch({
      userDataDir: join(home, ".mu", "browser", "profiles", "default"),
      browser: "chrome",
      headless: false,
      signal: new AbortController().signal,
    });
    await launched.driver.connect(
      { mode: "persistent", browser: "chrome" },
      new AbortController().signal,
    );
    await launched.driver.observe({}, new AbortController().signal);
    await launched.close();
    expect((await readdir(cwd)).sort()).toEqual(before);
    expect(await readdir(process.cwd())).not.toContain(".playwright-mcp");
  });
});

describe("persistent mode owns its profile and its browser (BD7/BD29)", () => {
  test("the factory takes the ownership lock, describes the profile, and closes the browser", async () => {
    const home = await scratch();
    const { recorded, launcher } = recorder();
    const factory = mcpPersistentFactory({
      home,
      launcher,
      resolve: { env: environment },
      discover: { platform: "linux", env: { MU_BROWSER_EXECUTABLE: "/usr/bin/google-chrome" } },
    });
    const dataRoot = join(home, "browser-data");
    const handle = await factory({ browser: "chrome", dataRoot }, new AbortController().signal);
    expect(handle.description).toContain(join(dataRoot, "profiles", "default"));
    const spec = recorded.specs[0] as McpSidecarSpec;
    expect(spec.args[spec.args.indexOf("--user-data-dir") + 1]).toBe(
      join(dataRoot, "profiles", "default"),
    );
    await handle.driver.connect(
      { mode: "persistent", browser: "chrome" },
      new AbortController().signal,
    );
    await handle.dispose();
    // BD29: the owned browser is closed and awaited, then the helper goes.
    expect(recorded.sidecars[0]?.closed()).toBe(true);
    expect(await readdir(join(dataRoot, "profiles", "default"))).not.toContain("owner.json");
  });

  test("a profile name that would escape the data root is refused", async () => {
    const home = await scratch();
    const { launcher } = recorder();
    const factory = mcpPersistentFactory({ home, launcher, resolve: { env: environment } });
    const error = await factory(
      {
        browser: "chrome",
        dataRoot: join(home, "browser-data"),
        userDataDir: "../../.config/google-chrome",
      },
      new AbortController().signal,
    ).catch((thrown: unknown) => thrown);
    expect(isBrowserDriverError(error) && error.code).toBe("unsupported");
  });
});

describe("a Mu-owned browser is launched by the OS Mu runs on", () => {
  const WINDOWS_CHROME = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";

  // Measured: the browser starts, reports that remote debugging pipe file descriptors
  // are not supported, and dies. Refusing up front beats launching something that dies.
  test("a Windows browser is refused from linux rather than launched", () => {
    const verdict = persistentTopology({ executablePath: WINDOWS_CHROME, platform: "linux" });
    expect(verdict.supported).toBe(false);
    expect(verdict.reason).toContain("operating system Mu is running on");
  });

  test("the same browser is fine when Mu is the one on Windows", () => {
    expect(
      persistentTopology({ executablePath: WINDOWS_CHROME, platform: "win32" }).supported,
    ).toBe(true);
  });

  test("a native browser is never refused", () => {
    expect(
      persistentTopology({ executablePath: "/usr/bin/google-chrome", platform: "linux" }).supported,
    ).toBe(true);
  });
});
