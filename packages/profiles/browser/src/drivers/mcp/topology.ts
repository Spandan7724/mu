export interface TopologyEnvironment {
  platform?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export interface TopologyVerdict {
  supported: boolean;
  reason?: string | undefined;
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
      "MU_BROWSER_EXECUTABLE.",
  };
}
