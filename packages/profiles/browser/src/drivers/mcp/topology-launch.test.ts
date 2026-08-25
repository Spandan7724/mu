// modes.test.ts and sidecar.test.ts prove `persistentTopology` itself refuses a
// Windows browser from Linux. This closes the matching gap by proving the same
// refusal fires through
// `mcpPersistentLaunch` itself — before a sidecar process is ever started — rather
// than only being true of the standalone verdict function.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBrowserDriverError } from "../../contracts/driver.ts";
import { mcpPersistentLaunch } from "./modes.ts";
import type { McpSidecar, McpSidecarSpec } from "./protocol.ts";
import { createScriptedSidecar } from "./scripted.ts";
import { SIDECAR_CLI_ENV, SIDECAR_RUNTIME_ENV } from "./sidecar.ts";

const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mu-browser-topology-launch-"));
  temporaries.push(directory);
  return directory;
}

afterAll(async () => {
  for (const directory of temporaries) await rm(directory, { recursive: true, force: true });
});

function recorder(): {
  specs: McpSidecarSpec[];
  launcher: (spec: McpSidecarSpec) => Promise<McpSidecar>;
} {
  const specs: McpSidecarSpec[] = [];
  return {
    specs,
    launcher: async (spec) => {
      specs.push(spec);
      return createScriptedSidecar();
    },
  };
}

const environment: Record<string, string | undefined> = {
  [SIDECAR_CLI_ENV]: "/opt/mcp/cli.js",
  [SIDECAR_RUNTIME_ENV]: "/usr/bin/node",
};

const WINDOWS_CHROME = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";

describe("a Linux-launching-a-Windows-browser topology is refused before launch", () => {
  test("no sidecar process is started when the discovered executable is a Windows binary", async () => {
    const home = await scratch();
    const { specs, launcher } = recorder();
    const launch = mcpPersistentLaunch({
      home,
      launcher,
      resolve: { env: environment },
      discover: { platform: "linux", env: { MU_BROWSER_EXECUTABLE: WINDOWS_CHROME } },
    });
    const error = await launch({
      userDataDir: join(home, ".mu", "browser", "profiles", "default"),
      browser: "chrome",
      headless: false,
      signal: new AbortController().signal,
    }).catch((thrown: unknown) => thrown);
    expect(isBrowserDriverError(error) && error.code).toBe("unsupported");
    expect(String(error)).toContain("operating system Mu is running on");
    // The whole point: nothing was launched to fail later or leak a half-started process.
    expect(specs).toHaveLength(0);
  });

  test("a native Linux browser is launched normally, same options otherwise", async () => {
    const home = await scratch();
    const { specs, launcher } = recorder();
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
    expect(specs).toHaveLength(1);
    await launched.close();
  });
});
