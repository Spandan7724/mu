// Snapshot latency on the fixture site: bun packages/profiles/browser/scripts/bench-snapshot.ts [iterations]
import { rmSync } from "node:fs";
import { BrowserManager } from "../src/browser/manager.ts";
import { benchSnapshots, formatBench } from "../src/testing/bench.ts";
import { tempUserDataDir, testBrowserPath } from "../src/testing/chrome.ts";
import { startFixtureSite } from "../src/testing/fixture-site.ts";

const iterations = Number(process.argv[2] ?? 30);
const site = startFixtureSite();
const userDataDir = tempUserDataDir();
const manager = new BrowserManager({
  connect: "managed",
  profileName: "bench",
  userDataDir,
  executable: testBrowserPath,
  headless: true,
  viewport: { width: 1280, height: 800 },
  keepOpen: false,
});
try {
  const pages = ["form-basic", "custom-select", "modal", "iframes", "shadow", "long", "heavy"];
  const results = await benchSnapshots(
    manager,
    Object.fromEntries(pages.map((page) => [page, site.url(page)])),
    iterations,
  );
  console.log(formatBench(results));
} finally {
  await manager.shutdown({ close: true });
  site.stop();
  rmSync(userDataDir, { recursive: true, force: true });
}
