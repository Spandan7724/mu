// A consumer of the published package, compiled against the published
// declarations and then executed against the published bundle. `bun run
// verify:sdk` builds first, so both halves come from the same build.
import {
  acceptsModelActions,
  BROWSER_PROFILE_NAME,
  type BrowserProfileOptions,
  browserDataLayout,
  browserProfile,
  createBrowserAgent,
  phaseSummary,
} from "../dist/index.js";

const options: BrowserProfileOptions = { browser: "chrome" };

const profile = await browserProfile(options);
if (profile.name !== BROWSER_PROFILE_NAME) throw new Error("unexpected profile identity");
if (profile.checkpointProvider !== undefined) {
  throw new Error("the browser profile must ship no checkpoint provider");
}
if (profile.toolset.length === 0) throw new Error("the browser profile has no tools");
if (typeof createBrowserAgent !== "function") throw new Error("createBrowserAgent is missing");
if (acceptsModelActions("disconnected")) throw new Error("disconnected must not accept actions");
if (!phaseSummary("ready").includes("accepting")) throw new Error("phaseSummary is wrong");
if (!browserDataLayout().root.includes("browser")) throw new Error("data root is wrong");
await profile.runtime.shutdown?.();

console.log(`@mu-agent/browser consumer ok — profile ${profile.name}`);
