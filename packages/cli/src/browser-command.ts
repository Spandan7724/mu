import {
  browserProfile,
  closeManaged,
  discoverBrowser,
  launchForSignIn,
  managedState,
} from "@mu/profile-browser";
import type { ParsedArgs } from "./args.ts";
import { EXIT } from "./headless.ts";
import { browserFlags } from "./profiles.ts";

export const DEFAULT_LOGIN_URL = "https://accounts.google.com/";

interface Io {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

function nextStdinLine(): Promise<void> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      if (!chunk.toString().includes("\n")) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

export interface BrowserLoginDeps {
  home?: string;
  executable?: string;
  // Test-only extra Chrome flags (for example headless).
  extraArgs?: string[];
  waitForEnter?: () => Promise<void>;
}

// Signs in through a plain Chrome window on the managed profile: Google and other
// sign-in pages reject browsers driven over the DevTools protocol, so mu neither
// enables debugging nor attaches here. Later runs reuse the saved cookies.
export async function runBrowserLogin(
  args: ParsedArgs,
  io: Io,
  deps: BrowserLoginDeps = {},
): Promise<number> {
  if (args.cdpUrl) {
    io.stderr("mu: browser login signs in to a managed profile; it cannot be used with --cdp\n");
    return EXIT.usage;
  }
  if (args.headless) {
    io.stderr("mu: browser login needs a visible window; drop --headless\n");
    return EXIT.usage;
  }
  const profile = await browserProfile({
    ...browserFlags(args),
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.executable ? { executable: deps.executable } : {}),
  });
  const config = profile.config;
  const state = await managedState(config.userDataDir);
  if (state.running) {
    io.stdout("Closing mu's browser on this profile so it can reopen without automation…\n");
    await closeManaged(config.userDataDir);
  } else if (state.locked) {
    io.stderr(
      `mu: the browser profile ${config.userDataDir} is already open in a Chrome window. Close it, then run mu browser login again.\n`,
    );
    return EXIT.usage;
  }
  let path: string;
  try {
    path = (await discoverBrowser({ executable: config.executable, channel: config.channel })).path;
  } catch (error) {
    io.stderr(`mu: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.error;
  }
  const url = args.loginUrl ?? DEFAULT_LOGIN_URL;
  const browser = launchForSignIn({
    path,
    userDataDir: config.userDataDir,
    url,
    ...(deps.extraArgs ? { args: deps.extraArgs } : {}),
  });
  io.stdout(
    [
      `Opened a normal Chrome window (not controlled by mu) with browser profile "${config.browserProfile}"`,
      `  ${config.userDataDir}`,
      "",
      "Sign in to the sites you want mu to use (Gmail, calendars, shops…).",
      "When you are done, close the browser window or press Enter here.",
      "",
    ].join("\n"),
  );
  const outcome = await Promise.race([
    browser.exited.then(() => "closed" as const),
    (deps.waitForEnter ?? nextStdinLine)().then(() => "enter" as const),
  ]);
  if (outcome === "enter") await browser.close();
  io.stdout(
    "Your sign-ins are saved in the profile. Run `mu browser` to start; mu opens this profile with its own controls from now on.\n",
  );
  return 0;
}

export async function runBrowserStatus(
  args: ParsedArgs,
  io: Io,
  deps: { home?: string } = {},
): Promise<number> {
  const profile = await browserProfile({ ...browserFlags(args), ...deps });
  const env = (await profile.environment?.()) ?? {};
  const config = profile.config;
  const lines = [`browser profile: ${config.browserProfile}`];
  if (config.connect === "cdp") {
    lines.push(`connection: cdp ${config.cdpUrl}`);
  } else {
    const state = await managedState(config.userDataDir);
    lines.push(
      `browser: ${env.browser ?? "unknown"}`,
      ...(env.executable ? [`executable: ${env.executable}`] : []),
      `profile dir: ${config.userDataDir}`,
      `running: ${state.running ? `yes (${state.endpoint})` : state.locked ? "open without remote debugging — close that window" : "no"}`,
    );
  }
  lines.push(`downloads: ${config.downloadsDir}`);
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

export async function runBrowserClose(
  args: ParsedArgs,
  io: Io,
  deps: { home?: string } = {},
): Promise<number> {
  if (args.cdpUrl) {
    io.stderr(
      "mu: browser close only closes the managed browser; it will not close a --cdp browser\n",
    );
    return EXIT.usage;
  }
  const profile = await browserProfile({ ...browserFlags(args), ...deps });
  const closed = await closeManaged(profile.config.userDataDir);
  io.stdout(closed ? "Closed the managed browser.\n" : "The managed browser is not running.\n");
  return 0;
}
