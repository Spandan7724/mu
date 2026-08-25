// What a driver factory hands the runtime. Every production browser is Mu-owned and
// is closed and awaited during disposal.
import type { BrowserFamily } from "../contracts/connection.ts";
import type { AuthorizedDocument } from "../contracts/documents.ts";
import type { BrowserDriver } from "../contracts/driver.ts";

export interface BrowserDriverHandle {
  driver: BrowserDriver;
  // How the connection will be described to the user before anything is opened.
  description: string;
  // Released once the driver has disconnected: sidecar exit, browser close,
  // ownership record removal. Always awaited by the runtime's shutdown.
  dispose: () => Promise<void>;
  diagnostics?: string[];
}

export interface BrowserDriverFactoryOptions {
  browser: BrowserFamily;
  headless?: boolean | undefined;
  // Persistent mode only, and always inside the browser product's data root.
  userDataDir?: string | undefined;
  dataRoot: string;
  // What the driver may attach to a file input. Supplied at connect time, because
  // a document can be authorized after the runtime is built.
  documents?: readonly AuthorizedDocument[] | undefined;
}

export type BrowserDriverFactory = (
  options: BrowserDriverFactoryOptions,
  signal: AbortSignal,
) => Promise<BrowserDriverHandle>;
