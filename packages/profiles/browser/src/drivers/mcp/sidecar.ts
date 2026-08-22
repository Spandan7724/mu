// How the Playwright MCP sidecar is located, versioned and invoked.
//
// BD31 is binding here: no `npx`, no `latest`, no runtime code download, no
// silent upgrade, and no automatic browser-binary download. The executable is one
// the user already installed (BD28) and the version is the one that was pinned.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { BrowserDriverError } from "../../contracts/driver.ts";
import type { McpServerIdentity, McpSidecarSpec } from "./protocol.ts";

export const PINNED_SIDECAR_PACKAGE = "@playwright/mcp";
export const PINNED_SIDECAR_VERSION = "0.0.79";
// The Playwright build `0.0.79` pins. The MCP server reports it as its own version.
export const PINNED_SERVER_VERSION = "1.63.0-alpha-2026-08-05";

export const SIDECAR_CLI_ENV = "MU_BROWSER_MCP_CLI";
export const SIDECAR_RUNTIME_ENV = "MU_BROWSER_MCP_RUNTIME";

export const UPDATE_INSTRUCTIONS =
  `Reinstall @mu-agent/browser so ${PINNED_SIDECAR_PACKAGE} ${PINNED_SIDECAR_VERSION} is the version on disk; ` +
  "Mu does not upgrade or download the browser bridge by itself.";

// A protocol or version mismatch fails outright rather than degrading into partial
// behaviour (ARCHITECTURE §13).
export function assertSupportedServer(identity: McpServerIdentity | undefined): void {
  if (identity === undefined) {
    throw new BrowserDriverError(
      "protocol-mismatch",
      `the browser bridge did not identify itself. ${UPDATE_INSTRUCTIONS}`,
    );
  }
  if (identity.version !== PINNED_SERVER_VERSION) {
    throw new BrowserDriverError(
      "protocol-mismatch",
      `the browser bridge reports ${identity.name} ${identity.version}, but this build of Mu is pinned to ${PINNED_SERVER_VERSION}. ${UPDATE_INSTRUCTIONS}`,
    );
  }
}

export interface SidecarResolution {
  cli: string;
  runtime: string;
}

export interface ResolveSidecarOptions {
  env?: Record<string, string | undefined> | undefined;
  // Extra module URLs to resolve `@playwright/mcp` from. The product package owns
  // the dependency, so its own location is the authoritative one.
  resolveFrom?: readonly string[] | undefined;
  runtime?: string | undefined;
}

function resolveCliFrom(base: string): string | undefined {
  try {
    const manifest = createRequire(base).resolve(`${PINNED_SIDECAR_PACKAGE}/package.json`);
    return join(dirname(manifest), "cli.js");
  } catch {
    return undefined;
  }
}

// Resolution order: an explicit configured path, then the package the product
// depends on. There is deliberately no fallback that fetches anything.
export function resolveSidecar(options: ResolveSidecarOptions = {}): SidecarResolution {
  const env = options.env ?? process.env;
  const runtime = options.runtime ?? env[SIDECAR_RUNTIME_ENV] ?? process.execPath;
  const configured = env[SIDECAR_CLI_ENV];
  if (configured !== undefined && configured.length > 0) {
    if (!isAbsolute(configured)) {
      throw new BrowserDriverError(
        "unsupported",
        `${SIDECAR_CLI_ENV} must be an absolute path to ${PINNED_SIDECAR_PACKAGE}/cli.js`,
      );
    }
    return { cli: configured, runtime };
  }
  for (const base of [...(options.resolveFrom ?? []), import.meta.url]) {
    const cli = resolveCliFrom(base);
    if (cli !== undefined) return { cli, runtime };
  }
  throw new BrowserDriverError(
    "unsupported",
    `could not find ${PINNED_SIDECAR_PACKAGE} ${PINNED_SIDECAR_VERSION}. Install @mu-agent/browser, or set ${SIDECAR_CLI_ENV} to the absolute path of its cli.js. Mu never downloads it.`,
  );
}

export type BrowserPlatform = "linux" | "darwin" | "win32";

// Bounded, known install locations only (SECURITY §4): discovery never scans the
// filesystem and never downloads a browser.
const EXECUTABLES: Record<BrowserPlatform, Record<string, readonly string[]>> = {
  linux: {
    chrome: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
    ],
    edge: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
    chromium: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
  },
  darwin: {
    chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    chromium: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
  },
  win32: {
    chrome: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
    edge: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    chromium: ["C:\\Program Files\\Chromium\\Application\\chrome.exe"],
  },
};

export const BROWSER_EXECUTABLE_ENV = "MU_BROWSER_EXECUTABLE";

export interface DiscoverBrowserOptions {
  platform?: BrowserPlatform | undefined;
  env?: Record<string, string | undefined> | undefined;
  exists?: ((path: string) => boolean) | undefined;
}

export function browserExecutableCandidates(
  browser: string,
  platform: BrowserPlatform,
): readonly string[] {
  return EXECUTABLES[platform][browser] ?? [];
}

export function discoverBrowserExecutable(
  browser: string,
  options: DiscoverBrowserOptions = {},
): string {
  const env = options.env ?? process.env;
  const configured = env[BROWSER_EXECUTABLE_ENV];
  if (configured !== undefined && configured.length > 0) return configured;
  const platform = options.platform ?? (process.platform as BrowserPlatform);
  const exists = options.exists ?? existsSync;
  const candidates = browserExecutableCandidates(browser, platform);
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // An unreadable candidate is simply not a candidate.
    }
  }
  throw new BrowserDriverError(
    "unsupported",
    `no installed ${browser} was found${candidates.length === 0 ? "" : ` at ${candidates.join(", ")}`}. Install it, or set ${BROWSER_EXECUTABLE_ENV} to its path. Mu does not download browsers.`,
  );
}

export interface SidecarArgsOptions {
  browser: string;
  // Always inside Mu's own artifact root. Left unset, the sidecar writes page
  // snapshots and console logs into the process working directory, which would put
  // page content — personal data on a real site — wherever mu-browser was started
  // (SECURITY §11).
  outputDir: string;
  viewport?: { width: number; height: number } | undefined;
  isolated?: boolean | undefined;
}

export interface PersistentSidecarArgsOptions extends SidecarArgsOptions {
  executablePath: string;
  userDataDir: string;
  headless?: boolean | undefined;
}

function commonArgs(options: SidecarArgsOptions): string[] {
  const viewport = options.viewport ?? { width: 1_280, height: 720 };
  return [
    "--browser",
    options.browser,
    "--output-dir",
    options.outputDir,
    "--viewport-size",
    `${viewport.width}x${viewport.height}`,
    // The model never sees generated Playwright source, so producing it is waste
    // and a second place for page text to end up.
    "--codegen",
    "none",
  ];
}

export function persistentSidecarArgs(options: PersistentSidecarArgsOptions): string[] {
  const args = [
    ...commonArgs(options),
    "--executable-path",
    options.executablePath,
    // BD7: the only user-data directory ever named is one Mu owns.
    "--user-data-dir",
    options.userDataDir,
  ];
  if (options.headless === true) args.push("--headless");
  return args;
}

export function extensionSidecarArgs(options: SidecarArgsOptions): string[] {
  // No `--executable-path` and no `--user-data-dir`: extension mode attaches to
  // the browser the user is already running and owns nothing (BD29).
  return [...commonArgs(options), "--extension"];
}

export function sidecarSpec(
  resolution: SidecarResolution,
  args: readonly string[],
  extra: Partial<McpSidecarSpec> = {},
): McpSidecarSpec {
  return { runtime: resolution.runtime, cli: resolution.cli, args, ...extra };
}
