// Which driver the product composes for a given connection choice.
//
// Both real modes run the same `McpBrowserDriver` over the pinned `@playwright/mcp`
// sidecar (BD25, BD31). Nothing here downloads anything, resolves a package at
// runtime, or shells out to `npx`: the sidecar is the dependency this package
// declares, and a browser is one the user already has.
import {
  type BrowserDriverFactory,
  fakeFactory,
  mcpExtensionDriverFactory,
  mcpPersistentFactory,
} from "@mu/profile-browser/drivers";

export type BrowserConnectionChoice = "extension" | "persistent" | "fake";

export function driverFactoryFor(
  choice: BrowserConnectionChoice,
  home?: string,
): BrowserDriverFactory {
  // Authorized documents reach the driver from the runtime at connect time, not
  // from here: the user's --document paths are not authorized yet at this point.
  //
  // `resolveFrom` is this file deliberately. This package declares the sidecar
  // dependency, so in a workspace it is installed next to *this* package, not next
  // to the profile that consumes it.
  const shared = {
    resolve: { resolveFrom: [import.meta.url] },
    ...(home === undefined ? {} : { home }),
  };
  switch (choice) {
    case "fake":
      return fakeFactory();
    case "extension":
      return mcpExtensionDriverFactory(shared);
    case "persistent":
      return mcpPersistentFactory(shared);
  }
}
