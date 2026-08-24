// The two production connection modes, filling the seams the lifecycle shells in
// `persistent.ts` and `extension.ts` already left open.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserFamily } from "../../contracts/connection.ts";
import type { AuthorizedDocument } from "../../contracts/documents.ts";
import { BrowserDriverError } from "../../contracts/driver.ts";
import { browserArtifactsDir, browserDataDir, DIRECTORY_MODE } from "../../profile/data.ts";
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
  type DiscoverBrowserOptions,
  discoverBrowserExecutable,
  extensionSidecarArgs,
  persistentSidecarArgs,
  type ResolveSidecarOptions,
  resolveSidecar,
  SIDECAR_RUNTIME_ENV,
  sidecarSpec,
} from "./sidecar.ts";
import { extensionTopology, persistentTopology } from "./topology.ts";

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

/**
 * The sidecar's working directory, and with it the root it will accept a file from.
 * `@playwright/mcp` refuses `browser_file_upload` for any path outside its output dir
 * or its cwd, so pointing cwd at the output dir alone put Mu's own staged documents
 * out of reach and made every upload fail. Mu's data root is the smallest directory
 * that contains both, it is already 0700, and the escape hatch that would lift the
 * restriction entirely also unblocks `file://` — so it is never used.
 */
async function sidecarCwd(options: McpModeOptions): Promise<string> {
  const root = browserDataDir(options.home);
  await mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
  return root;
}

export function mcpPersistentLaunch(
  options: McpModeOptions = {},
): PersistentProfileFactoryOptions["launch"] {
  const launcher = options.launcher ?? stdioSidecarLauncher;
  return async ({ userDataDir, browser, headless, documents, signal }) => {
    const outputDir = await privateOutputDir(options);
    const resolution = resolveSidecar(options.resolve);
    const executablePath = discoverBrowserExecutable(browser, options.discover);
    const verdict = persistentTopology({
      executablePath,
      ...(options.discover?.platform === undefined ? {} : { platform: options.discover.platform }),
      ...(options.discover?.env === undefined ? {} : { env: options.discover.env }),
    });
    if (!verdict.supported) {
      throw new BrowserDriverError("unsupported", verdict.reason ?? "unsupported topology");
    }
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
          cwd: await sidecarCwd(options),
          ...(options.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: options.startupTimeoutMs }),
          ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
        },
      ),
      signal,
    );
    return persistentDriver(sidecar, browser as BrowserFamily, {
      ...options,
      ...(documents === undefined ? {} : { documents }),
    });
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
  exists?: ((path: string) => boolean) | undefined;
}

export function mcpExtensionSidecar(
  options: McpExtensionOptions = {},
): ExtensionFactoryOptions["startSidecar"] {
  const launcher = options.launcher ?? stdioSidecarLauncher;
  return async ({ browser, token, documents, signal }): Promise<ExtensionSidecar> => {
    const attachable = documents ?? options.documents;
    const outputDir = await privateOutputDir(options);
    const resolution = resolveSidecar(options.resolve);
    const verdict = extensionTopology({
      runtime: resolution.runtime,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.exists === undefined ? {} : { exists: options.exists }),
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
          cwd: await sidecarCwd(options),
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
      ...(attachable === undefined ? {} : { documents: attachable }),
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
        ...(options.exists === undefined ? {} : { exists: options.exists }),
        env,
      }).supported;
    },
  });
}
