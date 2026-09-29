// Snapshot latency on live heavy pages:
//   bun packages/profiles/browser/scripts/bench-live-snapshot.ts [iterations] [url…]
// Uses a temporary signed-out profile unless --browser-profile names a managed one
// (for signed-in pages such as Gmail).
import { rmSync } from "node:fs";
import { BrowserManager } from "../src/browser/manager.ts";
import { resolveBrowserOptions } from "../src/config.ts";
import { benchSnapshots, formatBench } from "../src/testing/bench.ts";
import { tempUserDataDir, testBrowserPath } from "../src/testing/chrome.ts";

const argv = process.argv.slice(2);
const profileIndex = argv.indexOf("--browser-profile");
const managed = profileIndex >= 0 ? argv.splice(profileIndex, 2)[1] : undefined;
const iterations = Number(argv[0] ?? 20);
const urls = argv.slice(1).length
  ? argv.slice(1)
  : ["https://www.amazon.com/s?k=usb+c+hub", "https://www.ebay.com/sch/i.html?_nkw=usb+c+hub"];
const userDataDir = managed
  ? resolveBrowserOptions({ browserProfile: managed }).userDataDir
  : tempUserDataDir();
const manager = new BrowserManager({
  connect: "managed",
  profileName: managed ?? "bench",
  userDataDir,
  executable: testBrowserPath,
  headless: !managed,
  viewport: { width: 1280, height: 800 },
  keepOpen: Boolean(managed),
});
try {
  const results = await benchSnapshots(
    manager,
    Object.fromEntries(urls.map((url) => [new URL(url).host, url])),
    iterations,
  );
  console.log(formatBench(results));
} finally {
  await manager.shutdown();
  if (!managed) rmSync(userDataDir, { recursive: true, force: true });
}
