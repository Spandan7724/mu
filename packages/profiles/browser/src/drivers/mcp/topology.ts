// BD26. The extension relay must run on the operating system that owns the
// browser. B0 measured what happens when it does not: the WebSocket connects, the
// extension never sends the protocol-v2 initialisation event, and the call fails
// after 90,007 ms. This module turns that into an immediate, actionable refusal.
import { existsSync } from "node:fs";

export interface TopologyEnvironment {
  platform?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  exists?: ((path: string) => boolean) | undefined;
}

// WSL is the case that matters: Mu runs on Linux while the browser is a Windows
// process, so a Linux-hosted relay is on the wrong side of the boundary.
export function isWsl(environment: TopologyEnvironment = {}): boolean {
  const platform = environment.platform ?? process.platform;
  if (platform !== "linux") return false;
  const env = environment.env ?? process.env;
  if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) return true;
  const exists = environment.exists ?? existsSync;
  return exists("/proc/sys/fs/binfmt_misc/WSLInterop");
}

export interface TopologyVerdict {
  supported: boolean;
  reason?: string | undefined;
}

// A Windows Node runtime given as the sidecar runtime means Mu is doing exactly
// what B0 validated: staying in WSL and launching the helper on the browser's OS.
function runtimeIsWindows(runtime: string | undefined): boolean {
  return runtime !== undefined && /\.exe$/i.test(runtime);
}

export function extensionTopology(
  options: { runtime?: string | undefined } & TopologyEnvironment = {},
): TopologyVerdict {
  if (!isWsl(options)) return { supported: true };
  if (runtimeIsWindows(options.runtime)) return { supported: true };
  return {
    supported: false,
    reason:
      "the Playwright extension relay must run on the same operating system as the browser (BD26). " +
      "Mu is in WSL, so it needs a Windows Node to host the sidecar: set MU_BROWSER_MCP_RUNTIME to " +
      "the Windows node.exe path and MU_BROWSER_MCP_CLI to the Windows path of @playwright/mcp's " +
      "cli.js, or use the persistent profile instead. A WSL-hosted relay connects but never " +
      "completes the extension handshake, and times out after ninety seconds.",
  };
}

// The same boundary, in the other direction. Playwright drives a browser it launched
// over `--remote-debugging-pipe`, which is an inherited file descriptor pair. A Linux
// process cannot hand those to a Windows `chrome.exe`, and the Linux `--user-data-dir`
// it passes is not a path that binary can open either: the browser starts, reports
// "Remote debugging pipe file descriptors are not supported", and dies. Measured, not
// assumed.
function executableIsWindows(path: string | undefined): boolean {
  return path !== undefined && (/\.exe$/i.test(path) || /^\/mnt\/[a-z]\//i.test(path));
}

export function persistentTopology(
  options: { executablePath?: string | undefined } & TopologyEnvironment = {},
): TopologyVerdict {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return { supported: true };
  if (!executableIsWindows(options.executablePath)) return { supported: true };
  return {
    supported: false,
    reason:
      "a Mu-owned browser must be launched by the operating system Mu is running on. " +
      `${options.executablePath} is a Windows browser and Mu is on ${platform}, so Playwright ` +
      "cannot give it the debugging pipe it drives it through, and the profile directory Mu " +
      "owns is not a path that binary can open. Install a Linux browser and unset " +
      "MU_BROWSER_EXECUTABLE, or use --connection extension with a Windows-hosted sidecar.",
  };
}
