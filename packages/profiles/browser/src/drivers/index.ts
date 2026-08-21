import type { BrowserDriverFactory } from "./factory.ts";
import { createFakeBrowserDriver, type FakeBrowserDriverOptions } from "./fake/driver.ts";

export type {
  ExtensionFactoryOptions,
  ExtensionSidecar,
  ExtensionSidecarRequest,
} from "./extension.ts";
export { EXTENSION_BROWSERS, extensionFactory } from "./extension.ts";
export type {
  BrowserDriverFactory,
  BrowserDriverFactoryOptions,
  BrowserDriverHandle,
  BrowserDriverOwnership,
} from "./factory.ts";
export * from "./fake/index.ts";
export type { PersistentProfileFactoryOptions, ProfileOwnershipRecord } from "./persistent.ts";
export {
  claimProfile,
  OWNERSHIP_FILE,
  persistentProfileDir,
  persistentProfileFactory,
  releaseProfile,
} from "./persistent.ts";

// The fake driver as a factory, so a session can be composed against it through
// exactly the same seam the real adapters use.
export function fakeFactory(options: FakeBrowserDriverOptions = {}): BrowserDriverFactory {
  return async (factoryOptions) => {
    const driver = createFakeBrowserDriver({ ...options, mode: factoryOptions.connection });
    return {
      driver,
      // Nothing real is owned, so nothing real is closed.
      ownership: "attached",
      description: `a deterministic fake ${factoryOptions.browser}`,
      dispose: async () => driver.reset(),
    };
  };
}
