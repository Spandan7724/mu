// The two production connection modes, filling the seams the lifecycle shells in
// `persistent.ts` and `extension.ts` already left open.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserFamily } from "../../contracts/connection.ts";
import { BrowserDriverError } from "../../contracts/driver.ts";
import type { AuthorizedDocument } from "../../contracts/documents.ts";
import { browserArtifactsDir, DIRECTORY_MODE } from "../../profile/data.ts";
import type { ExtensionFactoryOptions, ExtensionSidecar } from "../extension.ts";
import { extensionFactory } from "../extension.ts";
import type { BrowserDriverFactory } from "../factory.ts";
import type { PersistentProfileFactoryOptions } from "../persistent.ts";
import { persistentProfileFactory } from "../persistent.ts";
import { stdioSidecarLauncher } from "./client.ts";
import { createMcpBrowserDriver, type McpBrowserDriver } from "./driver.ts";
import type { McpSidecar, McpSidecarLauncher } from "./protocol.ts";
import {
  assertSupportedServer,
  discoverBrowserExecutable,
  type DiscoverBrowserOptions,
  extensionSidecarArgs,
  persistentSidecarArgs,
  resolveSidecar,
  type ResolveSidecarOptions,
  SIDECAR_RUNTIME_ENV,
  sidecarSpec,
} from "./sidecar.ts";
import { extensionTopology } from "./topology.ts";

export const EXTENSION_TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";

export interface McpModeOptions {
  launcher?: McpSidecarLauncher | undefined;
  resolve?: ResolveSidecarOptions | undefined;
  discover?: DiscoverBrowserOptions | undefined;
  // Everything the sidecar writes — page snapshots, console logs, downloads —
  // lands here. Left to the sidecar's own default it would be the process working
  // directory, which puts page content wherever mu-browser happened to be started
  // (SECURITY §11).
  outputDir?: string | undefined;
  home?: string | undefined;
  documents?: readonly AuthorizedDocument[] | undefined;
  viewport?: { width: number; height: number } | undefined;
  startupTimeoutMs?: number | undefined;
  callTimeoutMs?: number | undefined;
}

export function sidecarOutputDir(options: McpModeOptions = {}): string {
  return options.outputDir ?? join(browserArtifactsDir(options.home), "sidecar");
}

async function privateOutputDir(options: McpModeOptions): Promise<string> {
  const directory = sidecarOutputDir(options);
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  return directory;
}

export function mcpPersistentLaunch(
  options: McpModeOptions = {},
): PersistentProfileFactoryOptions["launch"] {
  const launcher = options.launcher ?? stdioSidecarLauncher;
  return async ({ userDataDir, browser, headless, signal }) => {
    const outputDir = await privateOutputDir(options);
    const resolution = resolveSidecar(options.resolve);
    const executablePath = discoverBrowserExecutable(browser, options.discover);
    const sidecar = await launcher(
      sidecarSpec(
        resolution,
        persistentSidecarArgs({
          browser,
          outputDir,
          executablePath,
          userDataDir,
          headless,
          ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
        }),
        {
          // The sidecar's own working directory is the private output root, so
          // even a default it decides for itself cannot escape into the user's cwd.
          cwd: outputDir,
          ...(options.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: options.startupTimeoutMs }),
          ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
        },
      ),
      signal,
    );
    return persistentDriver(sidecar, browser as BrowserFamily, options);
  };
}

export function persistentDriver(
  sidecar: McpSidecar,
  browser: BrowserFamily,
  options: McpModeOptions = {},
): { driver: McpBrowserDriver; close: () => Promise<void> } {
  const driver = createMcpBrowserDriver({
    sidecar,
    mode: "persistent",
    browser,
    ownership: "owned",
    ...(options.documents === undefined ? {} : { documents: options.documents }),
  });
  return {
    driver,
    // BD29: the owned browser is closed and awaited before stdio ends, so the last
    // profile write is on disk before the helper goes away.
    close: async () => {
      await driver.disconnect();
      await sidecar.close();
    },
  };
}

export interface McpExtensionOptions extends McpModeOptions {
  platform?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export function mcpExtensionSidecar(
  options: McpExtensionOptions = {},
): ExtensionFactoryOptions["startSidecar"] {
  const launcher = options.launcher ?? stdioSidecarLauncher;
  return async ({ browser, token, signal }): Promise<ExtensionSidecar> => {
    const outputDir = await privateOutputDir(options);
    const resolution = resolveSidecar(options.resolve);
    const verdict = extensionTopology({
      runtime: resolution.runtime,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (!verdict.supported) {
      throw new BrowserDriverError("unsupported", verdict.reason ?? "unsupported topology");
    }
    const sidecar = await launcher(
      sidecarSpec(
        resolution,
        extensionSidecarArgs({
          browser,
          outputDir,
          ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
        }),
        {
          cwd: outputDir,
          // BD27: a token is an advanced opt-in credential. It is handed to the
          // helper through its environment rather than its argv, which would put
          // it in every process listing, and it is never written anywhere by Mu.
          ...(token === undefined ? {} : { env: { [EXTENSION_TOKEN_ENV]: token.reveal() } }),
          ...(options.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: options.startupTimeoutMs }),
          ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
        },
      ),
      signal,
    );
    assertSupportedServer(sidecar.serverIdentity());
    const driver = createMcpBrowserDriver({
      sidecar,
      mode: "extension",
      browser: browser as BrowserFamily,
      ownership: "attached",
      ...(options.documents === undefined ? {} : { documents: options.documents }),
    });
    return {
      driver,
      // BD29: detaching ends the helper. The browser, its windows and its tabs are
      // the user's and are left exactly as they were.
      exit: async () => {
        await driver.disconnect();
        await sidecar.close();
      },
    };
  };
}

export function mcpPersistentFactory(
  options: McpModeOptions & { pid?: number; hostname?: string } = {},
): BrowserDriverFactory {
  return persistentProfileFactory({
    launch: mcpPersistentLaunch(options),
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
  });
}

export function mcpExtensionDriverFactory(options: McpExtensionOptions = {}): BrowserDriverFactory {
  return extensionFactory({
    startSidecar: mcpExtensionSidecar(options),
    sidecarCanReachBrowser: () => {
      const env = options.env ?? process.env;
      const runtime = options.resolve?.runtime ?? env[SIDECAR_RUNTIME_ENV];
      return extensionTopology({
        ...(runtime === undefined ? {} : { runtime }),
        ...(options.platform === undefined ? {} : { platform: options.platform }),
        env,
      }).supported;
    },
  });
}
