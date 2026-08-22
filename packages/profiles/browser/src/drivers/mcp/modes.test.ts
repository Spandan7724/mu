import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBrowserDriverError } from "../../contracts/driver.ts";
import { BrowserSecret } from "../../contracts/secret.ts";
import { browserArtifactsDir } from "../../profile/data.ts";
import {
  EXTENSION_TOKEN_ENV,
  mcpExtensionSidecar,
  mcpPersistentFactory,
  mcpPersistentLaunch,
  sidecarOutputDir,
} from "./modes.ts";
import type { McpSidecar, McpSidecarSpec } from "./protocol.ts";
import { createScriptedSidecar } from "./scripted.ts";
import { PINNED_SERVER_VERSION, SIDECAR_CLI_ENV, SIDECAR_RUNTIME_ENV } from "./sidecar.ts";

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

  test("persistent mode pins --output-dir and the sidecar's own cwd to that root", async () => {
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
    // Even a default the sidecar picks for itself cannot escape: its working
    // directory is the private root, so `.playwright-mcp/` lands there.
    expect(spec.cwd).toBe(expected);
    // And the directory really exists, private, before the helper is started.
    const mode = (await stat(expected)).mode & 0o777;
    expect(mode).toBe(0o700);
    await launched.close();
  });

  test("extension mode pins the same root", async () => {
    const home = await scratch();
    const { recorded, launcher } = recorder();
    const start = mcpExtensionSidecar({
      home,
      launcher,
      resolve: { env: environment },
      platform: "linux",
      env: {},
      exists: () => false,
    });
    const sidecar = await start({ browser: "chrome", signal: new AbortController().signal });
    const spec = recorded.specs[0] as McpSidecarSpec;
    const expected = join(browserArtifactsDir(home), "sidecar");
    expect(spec.args[spec.args.indexOf("--output-dir") + 1]).toBe(expected);
    expect(spec.cwd).toBe(expected);
    await sidecar.exit();
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
    const handle = await factory(
      { connection: "persistent", browser: "chrome", dataRoot },
      new AbortController().signal,
    );
    expect(handle.ownership).toBe("owned");
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
        connection: "persistent",
        browser: "chrome",
        dataRoot: join(home, "browser-data"),
        userDataDir: "../../.config/google-chrome",
      },
      new AbortController().signal,
    ).catch((thrown: unknown) => thrown);
    expect(isBrowserDriverError(error) && error.code).toBe("unsupported");
  });
});

describe("extension mode attaches and detaches (BD26/BD27/BD29)", () => {
  test("a token is passed through the environment, never argv, and never persisted", async () => {
    const home = await scratch();
    const { recorded, launcher } = recorder();
    const start = mcpExtensionSidecar({
      home,
      launcher,
      resolve: { env: environment },
      platform: "linux",
      env: {},
      exists: () => false,
    });
    const sidecar = await start({
      browser: "chrome",
      token: new BrowserSecret("tok-secret-value"),
      signal: new AbortController().signal,
    });
    const spec = recorded.specs[0] as McpSidecarSpec;
    expect(spec.env?.[EXTENSION_TOKEN_ENV]).toBe("tok-secret-value");
    expect(spec.args.join(" ")).not.toContain("tok-secret-value");
    expect(JSON.stringify(sidecar.driver.status())).not.toContain("tok-secret-value");
    await sidecar.exit();
  });

  test("detaching ends the helper without closing the user's browser", async () => {
    const home = await scratch();
    const calls: string[] = [];
    const inner = createScriptedSidecar();
    const spy: McpSidecar = {
      ...inner,
      callTool: async (name, args, options) => {
        calls.push(name);
        return inner.callTool(name, args, options);
      },
    };
    const start = mcpExtensionSidecar({
      home,
      launcher: async () => spy,
      resolve: { env: environment },
      platform: "linux",
      env: {},
      exists: () => false,
    });
    const sidecar = await start({ browser: "chrome", signal: new AbortController().signal });
    await sidecar.driver.connect(
      { mode: "extension", browser: "chrome" },
      new AbortController().signal,
    );
    await sidecar.exit();
    expect(calls).not.toContain("browser_close");
  });

  test("a WSL-hosted relay is refused before a sidecar is ever started (BD26)", async () => {
    const home = await scratch();
    const { recorded, launcher } = recorder();
    const start = mcpExtensionSidecar({
      home,
      launcher,
      resolve: { env: environment },
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    });
    const error = await start({ browser: "chrome", signal: new AbortController().signal }).catch(
      (thrown: unknown) => thrown,
    );
    expect(isBrowserDriverError(error) && error.code).toBe("unsupported");
    expect(String(error)).toContain("same operating system as the browser");
    expect(recorded.specs).toHaveLength(0);
  });

  test("a bridge reporting the wrong build is refused at start, not mid-session", async () => {
    const home = await scratch();
    const start = mcpExtensionSidecar({
      home,
      launcher: async () =>
        createScriptedSidecar({ serverIdentity: { name: "Playwright", version: "0.0.0" } }),
      resolve: { env: environment },
      platform: "linux",
      env: {},
      exists: () => false,
    });
    const error = await start({ browser: "chrome", signal: new AbortController().signal }).catch(
      (thrown: unknown) => thrown,
    );
    expect(isBrowserDriverError(error) && error.code).toBe("protocol-mismatch");
    expect(PINNED_SERVER_VERSION).not.toBe("0.0.0");
  });
});
