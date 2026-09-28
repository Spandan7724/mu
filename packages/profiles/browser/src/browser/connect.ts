import { lstatSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { type CdpConnection, CdpError, connectCdp } from "../cdp/connection.ts";
import { type DiscoveredBrowser, discoverBrowser } from "./discover.ts";
import {
  type BrowserEndpoint,
  type LaunchOptions,
  launchBrowser,
  readDevToolsActivePort,
  type Size,
} from "./launch.ts";

export interface BrowserLauncher {
  discover(prefs: {
    executable?: string | undefined;
    channel?: string | undefined;
  }): Promise<DiscoveredBrowser>;
  launch(options: LaunchOptions): Promise<BrowserEndpoint>;
}

export const defaultLauncher: BrowserLauncher = {
  discover: (prefs) => discoverBrowser(prefs),
  launch: (options) => launchBrowser(options),
};

interface Signals {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

function timeoutSignal(options: Signals, fallbackMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? fallbackMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

function httpBase(wsUrl: string): string {
  const url = new URL(wsUrl);
  return `http://${url.host}`;
}

// Answers only when a browser is actually listening on the endpoint.
export async function endpointAlive(wsUrl: string, options: Signals = {}): Promise<boolean> {
  try {
    const response = await fetch(`${httpBase(wsUrl)}/json/version`, {
      signal: timeoutSignal(options, 1_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { webSocketDebuggerUrl?: string };
    return typeof body.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

export async function resolveCdpUrl(endpoint: string, options: Signals = {}): Promise<string> {
  if (/^wss?:\/\//i.test(endpoint)) return endpoint;
  const base = /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
  let body: { webSocketDebuggerUrl?: string };
  try {
    const response = await fetch(`${base.replace(/\/+$/, "")}/json/version`, {
      signal: timeoutSignal(options, 5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = (await response.json()) as { webSocketDebuggerUrl?: string };
  } catch (error) {
    if (options.signal?.aborted) throw new CdpError("aborted", "connect", "aborted");
    throw new Error(
      `No CDP endpoint answered at ${base} (${error instanceof Error ? error.message : String(error)}). Start the browser with --remote-debugging-port and pass that address to --cdp.`,
    );
  }
  if (!body.webSocketDebuggerUrl) {
    throw new Error(`${base}/json/version did not report a webSocketDebuggerUrl`);
  }
  return body.webSocketDebuggerUrl;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Chrome's SingletonLock is a symlink to "<hostname>-<pid>" on Unix; a lock
// left by a crashed browser on this host is not a live lock.
export function profileLocked(userDataDir: string): boolean {
  const lock = join(userDataDir, "SingletonLock");
  try {
    lstatSync(lock);
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    const target = readlinkSync(lock);
    const separator = target.lastIndexOf("-");
    const host = target.slice(0, separator);
    const pid = Number(target.slice(separator + 1));
    if (host === hostname() && Number.isInteger(pid)) return pidAlive(pid);
    return true;
  } catch {
    return true;
  }
}

async function waitForUnlock(userDataDir: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (profileLocked(userDataDir) && Date.now() < deadline) {
    if (signal?.aborted) throw new CdpError("aborted", "connect", "aborted");
    await Bun.sleep(50);
  }
}

export interface ManagedConnectOptions {
  userDataDir: string;
  headless: boolean;
  viewport: Size;
  executable?: string | undefined;
  channel?: string | undefined;
  args?: string[] | undefined;
  url?: string | undefined;
  launcher?: BrowserLauncher | undefined;
  signal?: AbortSignal | undefined;
}

export interface ConnectedBrowser {
  connection: CdpConnection;
  endpoint: BrowserEndpoint;
  browser?: DiscoveredBrowser;
}

export async function connectManaged(options: ManagedConnectOptions): Promise<ConnectedBrowser> {
  const existing = readDevToolsActivePort(options.userDataDir);
  if (existing && (await endpointAlive(existing, { signal: options.signal }))) {
    const connection = await connectCdp(existing, { signal: options.signal });
    const { userAgent } = await connection.send("Browser.getVersion", undefined, {
      signal: options.signal,
    });
    if (options.headless || !userAgent.includes("Headless")) {
      return { connection, endpoint: { wsUrl: existing, launched: false } };
    }
    // A headless run left this profile's browser running; a visible window was asked for.
    await connection.send("Browser.close", undefined, { timeoutMs: 2_000 }).catch(() => {});
    await Promise.race([connection.closed, Bun.sleep(3_000)]);
    await connection.close();
    await waitForUnlock(options.userDataDir, options.signal);
  }
  if (profileLocked(options.userDataDir)) {
    throw new Error(
      `The browser profile ${options.userDataDir} is already open in a browser that mu cannot control (it was started without remote debugging). Close that browser window, then try again; mu will reopen it with debugging enabled.`,
    );
  }
  const launcher = options.launcher ?? defaultLauncher;
  const browser = await launcher.discover({
    executable: options.executable,
    channel: options.channel,
  });
  const endpoint = await launcher.launch({
    path: browser.path,
    userDataDir: options.userDataDir,
    headless: options.headless,
    viewport: options.viewport,
    args: options.args,
    url: options.url,
    signal: options.signal,
  });
  const connection = await connectCdp(endpoint.wsUrl, { signal: options.signal });
  return { connection, endpoint, browser };
}

export async function connectToEndpoint(
  endpoint: string,
  options: Signals = {},
): Promise<ConnectedBrowser> {
  const wsUrl = await resolveCdpUrl(endpoint, options);
  const connection = await connectCdp(wsUrl, options);
  return { connection, endpoint: { wsUrl, launched: false } };
}
