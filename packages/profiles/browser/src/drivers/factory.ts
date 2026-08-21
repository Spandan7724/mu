// What a driver factory hands the runtime. `ownership` is the whole of BD29: an
// attached browser is detached from and never closed; an owned browser is closed
// and awaited. The runtime must not have to infer which it has.
import type { BrowserConnectionMode, BrowserFamily } from "../contracts/connection.ts";
import type { BrowserDriver } from "../contracts/driver.ts";
import type { BrowserSecret } from "../contracts/secret.ts";

export type BrowserDriverOwnership = "attached" | "owned";

export interface BrowserDriverHandle {
  driver: BrowserDriver;
  ownership: BrowserDriverOwnership;
  // How the connection will be described to the user before anything is opened.
  description: string;
  // Released once the driver has disconnected: sidecar exit, owned-browser close,
  // ownership record removal. Always awaited by the runtime's shutdown.
  dispose: () => Promise<void>;
  diagnostics?: string[];
}

export interface BrowserDriverFactoryOptions {
  connection: BrowserConnectionMode;
  browser: BrowserFamily;
  headless?: boolean | undefined;
  // Persistent mode only, and always inside the browser product's data root.
  userDataDir?: string | undefined;
  dataRoot: string;
  // Advanced opt-in only (BD27). Never persisted by anything here.
  extensionToken?: BrowserSecret | undefined;
}

export type BrowserDriverFactory = (
  options: BrowserDriverFactoryOptions,
  signal: AbortSignal,
) => Promise<BrowserDriverHandle>;
