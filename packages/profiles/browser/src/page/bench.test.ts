import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { BrowserManager } from "../browser/manager.ts";
import { benchSnapshots, formatBench } from "../testing/bench.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

describeWithBrowser("snapshot latency budgets (EVALS §4)", () => {
  const userDataDir = tempUserDataDir();
  let site: FixtureSite;
  let manager: BrowserManager;

  beforeAll(() => {
    site = startFixtureSite();
    manager = new BrowserManager({
      connect: "managed",
      profileName: "bench",
      userDataDir,
      executable: testBrowserPath,
      headless: true,
      viewport: { width: 1280, height: 800 },
      keepOpen: false,
    });
  });

  afterAll(async () => {
    await manager.shutdown({ close: true });
    site.stop();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test("fixture pages: p50 < 120 ms, p95 < 300 ms; observation well under the token cap", async () => {
    const pages = ["form-basic", "custom-select", "modal", "iframes", "shadow", "long"];
    const results = await benchSnapshots(
      manager,
      Object.fromEntries(pages.map((page) => [page, site.url(page)])),
      10,
    );
    console.log(formatBench(results));
    for (const result of results) {
      expect(result.p50).toBeLessThan(120);
      expect(result.p95).toBeLessThan(300);
      expect(result.tokens).toBeLessThan(3_000);
    }
  }, 30_000);
});
