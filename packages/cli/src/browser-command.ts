import { type BrowserProfile, browserProfile } from "@mu/profile-browser";
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
  profile?: BrowserProfile;
  waitForEnter?: () => Promise<void>;
}

// Opens the managed profile headed so the user can sign in once; the cookies
// persist in the profile directory for every later run.
export async function runBrowserLogin(
  args: ParsedArgs,
  io: Io,
  deps: BrowserLoginDeps = {},
): Promise<number> {
  if (args.cdpUrl) {
    io.stderr("mu: browser login signs in to a managed profile; it cannot be used with --cdp\n");
    return EXIT.usage;
  }
  if (args.headless && !deps.profile) {
    io.stderr("mu: browser login needs a visible window; drop --headless\n");
    return EXIT.usage;
  }
  const profile =
    deps.profile ?? (await browserProfile({ ...browserFlags(args), headless: false }));
  const url = args.loginUrl ?? DEFAULT_LOGIN_URL;
  try {
    await profile.browser.openTab(url);
  } catch (error) {
    io.stderr(
      `mu: could not open the browser: ${error instanceof Error ? error.message : error}\n`,
    );
    return EXIT.error;
  }
  const status = profile.browser.status();
  io.stdout(
    [
      `Opened ${status.product ?? "the browser"} ${status.version ?? ""} with browser profile "${status.profile}"`,
      status.userDataDir ? `  ${status.userDataDir}` : "",
      "",
      "Sign in to the sites you want mu to use (Gmail, calendars, shops…).",
      "Press Enter here when you are done, or just close the browser window.",
      "",
    ]
      .filter((line, index) => index !== 1 || line)
      .join("\n"),
  );
  const closed = profile.browser.connection?.closed.then(() => "closed" as const);
  const entered = (deps.waitForEnter ?? nextStdinLine)().then(() => "enter" as const);
  const outcome = await Promise.race([entered, ...(closed ? [closed] : [])]);
  if (outcome === "closed") {
    io.stdout("Browser closed. Your sign-ins are saved in the profile.\n");
    await profile.browser.shutdown({ close: false });
    return 0;
  }
  await profile.browser.shutdown({ close: false });
  io.stdout(
    "The browser stays open with your sign-ins saved; mu will reuse it. Run `mu browser` to start.\n",
  );
  return 0;
}
