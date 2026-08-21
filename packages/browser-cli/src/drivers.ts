// Which driver the product composes for a given connection choice.
//
// B2 ships the fake driver, and the lifecycle, ownership and diagnostics of the
// two real ones. Neither real adapter has a bridge behind it yet: promoting the
// B0 feasibility pin of `@playwright/mcp` to a production dependency needs its
// own decision entry first, so the seam fails with the reason and the next step
// instead of pretending to connect.
import {
  type BrowserDriverFactory,
  extensionFactory,
  fakeFactory,
  persistentProfileFactory,
} from "@mu/profile-browser/drivers";

export type BrowserConnectionChoice = "extension" | "persistent" | "fake";

export const UNAVAILABLE_EXTENSION =
  "The Playwright extension bridge is not part of this build yet. Run mu-browser --fake-browser for a deterministic session, or track the browser bridge decision (BD25) for the release that enables it.";

export const UNAVAILABLE_PERSISTENT =
  "Launching a Mu-owned browser is not part of this build yet. Run mu-browser --fake-browser for a deterministic session, or track the browser bridge decision (BD25) for the release that enables it.";

export function driverFactoryFor(choice: BrowserConnectionChoice): BrowserDriverFactory {
  switch (choice) {
    case "fake":
      return fakeFactory();
    case "extension":
      return extensionFactory({
        startSidecar: async () => {
          throw new Error(UNAVAILABLE_EXTENSION);
        },
      });
    case "persistent":
      return persistentProfileFactory({
        launch: async () => {
          throw new Error(UNAVAILABLE_PERSISTENT);
        },
      });
  }
}
