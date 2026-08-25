import type { BrowserDriverFactory } from "./factory.ts";
import { createFakeBrowserDriver, type FakeBrowserDriverOptions } from "./fake/driver.ts";

export type {
  BrowserDriverFactory,
  BrowserDriverFactoryOptions,
  BrowserDriverHandle,
} from "./factory.ts";
export * from "./fake/index.ts";
export * from "./mcp/index.ts";
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
    const driver = createFakeBrowserDriver({ ...options, mode: "persistent" });
    return {
      driver,
      description: `a deterministic fake ${factoryOptions.browser}`,
      dispose: async () => driver.reset(),
    };
  };
}
