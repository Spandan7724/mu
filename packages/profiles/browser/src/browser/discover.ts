import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

export type BrowserChannel = "chrome" | "chromium" | "brave" | "edge";
export const BROWSER_CHANNELS: BrowserChannel[] = ["chrome", "chromium", "brave", "edge"];

export interface BrowserCandidate {
  channel: BrowserChannel;
  path: string;
}

export interface DiscoveredBrowser {
  path: string;
  channel: BrowserChannel | "custom";
  product: string;
  version: string;
}

export interface DiscoverDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists: (path: string) => boolean;
  which: (command: string) => string | null;
  probeVersion: (path: string) => Promise<string | undefined>;
}

const PATH_COMMANDS: Record<BrowserChannel, string[]> = {
  chrome: ["google-chrome-stable", "google-chrome", "chrome"],
  chromium: ["chromium", "chromium-browser"],
  brave: ["brave", "brave-browser"],
  edge: ["microsoft-edge-stable", "microsoft-edge", "msedge"],
};

export function knownPaths(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): BrowserCandidate[] {
  if (platform === "darwin") {
    const apps = (name: string, binary: string) => [
      `/Applications/${name}.app/Contents/MacOS/${binary}`,
      join(home, "Applications", `${name}.app`, "Contents", "MacOS", binary),
    ];
    return [
      ...apps("Google Chrome", "Google Chrome").map((path) => ({
        channel: "chrome" as const,
        path,
      })),
      ...apps("Chromium", "Chromium").map((path) => ({ channel: "chromium" as const, path })),
      ...apps("Brave Browser", "Brave Browser").map((path) => ({
        channel: "brave" as const,
        path,
      })),
      ...apps("Microsoft Edge", "Microsoft Edge").map((path) => ({
        channel: "edge" as const,
        path,
      })),
    ];
  }
  if (platform === "win32") {
    const roots = [
      env.PROGRAMFILES ?? "C:\\Program Files",
      env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
      env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"),
    ];
    const under = (channel: BrowserChannel, ...segments: string[]) =>
      roots.map((root) => ({ channel, path: win32.join(root, ...segments) }));
    return [
      ...under("chrome", "Google", "Chrome", "Application", "chrome.exe"),
      ...under("chromium", "Chromium", "Application", "chrome.exe"),
      ...under("brave", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ...under("edge", "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  return [
    { channel: "chrome", path: "/usr/bin/google-chrome-stable" },
    { channel: "chrome", path: "/usr/bin/google-chrome" },
    { channel: "chrome", path: "/opt/google/chrome/chrome" },
    { channel: "chromium", path: "/usr/bin/chromium" },
    { channel: "chromium", path: "/usr/bin/chromium-browser" },
    { channel: "chromium", path: "/snap/bin/chromium" },
    { channel: "brave", path: "/usr/bin/brave" },
    { channel: "brave", path: "/usr/bin/brave-browser" },
    { channel: "brave", path: "/opt/brave.com/brave/brave" },
    { channel: "edge", path: "/usr/bin/microsoft-edge-stable" },
    { channel: "edge", path: "/usr/bin/microsoft-edge" },
    { channel: "edge", path: "/opt/microsoft/msedge/msedge" },
  ];
}

export function parseVersionOutput(output: string): { product: string; version: string } {
  const text = output.trim();
  const match = /^(.*?)\s+v?(\d+(?:\.\d+){1,3})\b/.exec(text);
  if (!match) return { product: text || "unknown", version: "unknown" };
  return { product: (match[1] ?? "").trim() || "unknown", version: match[2] ?? "unknown" };
}

const PRODUCT_NAMES: Record<BrowserChannel, string> = {
  chrome: "Google Chrome",
  chromium: "Chromium",
  brave: "Brave Browser",
  edge: "Microsoft Edge",
};

async function probeVersion(path: string): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    const output = await new Response(child.stdout).text();
    return (await child.exited) === 0 ? output : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function defaultDiscoverDeps(): DiscoverDeps {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: (path) => existsSync(path),
    which: (command) => Bun.which(command),
    probeVersion,
  };
}

export function findCandidates(
  channel: BrowserChannel | undefined,
  deps: DiscoverDeps,
): BrowserCandidate[] {
  const channels = channel ? [channel] : BROWSER_CHANNELS;
  const known = knownPaths(deps.platform, deps.env, deps.home);
  const found: BrowserCandidate[] = [];
  const seen = new Set<string>();
  for (const current of channels) {
    const add = (path: string | null) => {
      if (!path || seen.has(path) || !deps.exists(path)) return;
      seen.add(path);
      found.push({ channel: current, path });
    };
    for (const candidate of known) if (candidate.channel === current) add(candidate.path);
    for (const command of PATH_COMMANDS[current]) add(deps.which(command));
  }
  return found;
}

export async function discoverBrowser(
  prefs: { executable?: string | undefined; channel?: string | undefined } = {},
  deps: DiscoverDeps = defaultDiscoverDeps(),
): Promise<DiscoveredBrowser> {
  if (prefs.executable) {
    if (!deps.exists(prefs.executable)) {
      throw new Error(`Browser executable not found: ${prefs.executable}`);
    }
    const output = await deps.probeVersion(prefs.executable);
    return {
      path: prefs.executable,
      channel: "custom",
      ...(output ? parseVersionOutput(output) : { product: "custom", version: "unknown" }),
    };
  }
  if (prefs.channel && !BROWSER_CHANNELS.includes(prefs.channel as BrowserChannel)) {
    throw new Error(
      `Unknown browser channel "${prefs.channel}" (expected ${BROWSER_CHANNELS.join(", ")})`,
    );
  }
  const channel = prefs.channel as BrowserChannel | undefined;
  const [first] = findCandidates(channel, deps);
  if (!first) {
    throw new Error(
      channel
        ? `No ${PRODUCT_NAMES[channel]} installation found. Install it, choose another browser.channel, or set browser.executable in ~/.mu/config.json.`
        : "No Chrome-family browser found. Install Google Chrome, Chromium, Brave or Microsoft Edge, or set browser.executable in ~/.mu/config.json.",
    );
  }
  const output = await deps.probeVersion(first.path);
  const parsed = output ? parseVersionOutput(output) : undefined;
  return {
    path: first.path,
    channel: first.channel,
    product: parsed?.product ?? PRODUCT_NAMES[first.channel],
    version: parsed?.version ?? "unknown",
  };
}
