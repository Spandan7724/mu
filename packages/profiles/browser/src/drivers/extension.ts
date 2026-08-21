// The existing-browser factory. It owns the lifecycle BD25/BD26/BD29 describe —
// one long-lived stdio sidecar, co-located with the browser's operating system,
// explicit approval by default, detach without closing the user's browser — and
// stops exactly where the production bridge would begin.
//
// The bridge itself is deliberately absent. Promoting the B0 feasibility pin of
// `@playwright/mcp` to a production dependency needs its own BD entry first, so
// this factory takes the sidecar as an injected seam. Nothing here downloads,
// spawns `npx`, or resolves a package at runtime.

import type { BrowserDriver } from "../contracts/driver.ts";
import { BrowserDriverError } from "../contracts/driver.ts";
import type { BrowserSecret } from "../contracts/secret.ts";
import type { BrowserDriverFactory } from "./factory.ts";

// Chrome-family only for the first release; the extension exists nowhere else.
export const EXTENSION_BROWSERS = ["chrome", "edge", "chromium"] as const;

export interface ExtensionSidecar {
  driver: BrowserDriver;
  // Awaited on shutdown. It ends the helper process; it never closes a tab or a
  // window belonging to the user.
  exit: () => Promise<void>;
}

export interface ExtensionSidecarRequest {
  browser: string;
  // A token is an explicit advanced opt-in (BD27). It is passed straight to the
  // sidecar and is never written to disk, a log, an event or a session by anything
  // in this module.
  token?: BrowserSecret | undefined;
  signal: AbortSignal;
}

export interface ExtensionFactoryOptions {
  startSidecar: (request: ExtensionSidecarRequest) => Promise<ExtensionSidecar>;
  // Whether the sidecar can run on the operating system that owns the browser.
  // BD26: a relay hosted on the wrong side of a WSL boundary never initializes,
  // so this is checked before a connection is attempted rather than after a
  // ninety-second timeout.
  sidecarCanReachBrowser?: () => boolean;
}

export function extensionFactory(options: ExtensionFactoryOptions): BrowserDriverFactory {
  return async (factoryOptions, signal) => {
    if (factoryOptions.connection !== "extension") {
      throw new BrowserDriverError(
        "unsupported",
        "the existing-browser factory only serves extension connections",
      );
    }
    if (factoryOptions.headless === true) {
      throw new BrowserDriverError(
        "unsupported",
        "extension mode attaches to a browser you can see; it cannot run headless",
      );
    }
    if (factoryOptions.userDataDir !== undefined) {
      throw new BrowserDriverError(
        "unsupported",
        "extension mode attaches to your own browser and owns no profile directory",
      );
    }
    if (options.sidecarCanReachBrowser?.() === false) {
      throw new BrowserDriverError(
        "unsupported",
        "the extension relay must run on the same operating system as the browser (BD26). Start mu-browser where the browser runs, or use the persistent profile instead.",
      );
    }
    const sidecar = await options.startSidecar({
      browser: factoryOptions.browser,
      ...(factoryOptions.extensionToken === undefined
        ? {}
        : { token: factoryOptions.extensionToken }),
      signal,
    });
    return {
      driver: sidecar.driver,
      ownership: "attached",
      description: `your ${factoryOptions.browser} through the Playwright extension`,
      // BD29: detaching ends the helper. The browser, its windows and its tabs
      // are the user's and are left exactly as they were.
      dispose: () => sidecar.exit(),
      diagnostics:
        factoryOptions.extensionToken === undefined
          ? []
          : [
              "an extension token is configured: reconnect will not ask for approval until you revoke it",
            ],
    };
  };
}
