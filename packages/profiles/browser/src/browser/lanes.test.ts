import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { navigateTo } from "../actions/navigate.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";
import { BrowserManager, MAX_LANES } from "./manager.ts";
import type { Tab } from "./tabs.ts";

setDefaultTimeout(30_000);

describeWithBrowser("parallel lanes share one browser without sharing tabs", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let main: BrowserManager;
  const signal = () => AbortSignal.timeout(15_000);
  const windowOf = async (tab: Tab) =>
    (await main.connection?.send("Browser.getWindowForTarget", { targetId: tab.targetId }))
      ?.windowId;
  const title = async (tab: Tab) =>
    (await tab.session.send("Runtime.evaluate", { expression: "document.title" })).result.value;

  beforeAll(() => {
    site = startFixtureSite();
    main = new BrowserManager({
      connect: "managed",
      profileName: "lanes-test",
      userDataDir: home,
      executable: testBrowserPath,
      headless: true,
      viewport: { width: 1280, height: 800 },
      keepOpen: false,
    });
  });
  afterAll(async () => {
    await main.shutdown({ close: true });
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("each lane works in its own window, sees only its own tabs, and cannot take another's", async () => {
    const own = await main.activeTab(signal());
    const [a, b] = await Promise.all([
      main.openLane("apply to Engine Co.", signal()),
      main.openLane("apply to Loom Ltd.", signal()),
    ]);
    const [tabA, tabB] = await Promise.all([a.activeTab(signal()), b.activeTab(signal())]);
    await Promise.all([
      navigateTo(tabA, site.url("form-basic"), signal()),
      navigateTo(tabB, site.url("review"), signal()),
    ]);

    expect(new Set([await windowOf(own), await windowOf(tabA), await windowOf(tabB)]).size).toBe(3);
    expect(await title(tabA)).not.toBe(await title(tabB));
    expect(a.tabs().map((tab) => tab.tabId)).toEqual([tabA.tabId]);
    expect(b.tabs().map((tab) => tab.tabId)).toEqual([tabB.tabId]);
    expect(main.tabs().map((tab) => tab.tabId)).not.toContain(tabA.tabId);
    await expect(a.switchTab(tabB.tabId)).rejects.toThrow(
      'belongs to the sub-task "apply to Loom Ltd."',
    );
    await expect(main.closeTab(tabA.tabId)).rejects.toThrow("belongs to the sub-task");

    // Closing one lane's tab leaves every other agent's active tab alone.
    const extra = await a.openTab(undefined, signal());
    await a.closeTab(extra.tabId, signal());
    expect((await b.activeTab(signal())).tabId).toBe(tabB.tabId);
    expect((await main.activeTab(signal())).tabId).toBe(own.tabId);

    await Promise.all([a.release(), b.release()]);
    const left = main.tabs().filter((tab) => tab.leftBy);
    expect(left.map((tab) => [tab.tabId, tab.leftBy])).toEqual([
      [tabA.tabId, "apply to Engine Co."],
      [tabB.tabId, "apply to Loom Ltd."],
    ]);
    expect(left.every((tab) => !tab.openedByAgent)).toBe(true);
    await main.switchTab(tabA.tabId, signal());
  });

  test("a lane whose tab never left the blank page closes it on release", async () => {
    const lane = await main.openLane("idle", signal());
    const tab = await lane.activeTab(signal());
    await lane.release();
    expect(main.tabs().map((candidate) => candidate.tabId)).not.toContain(tab.tabId);
  });

  test(`at most ${MAX_LANES} lanes run at once; the next waits for a release or its abort`, async () => {
    const lanes = await Promise.all(
      Array.from({ length: MAX_LANES }, (_, index) => main.openLane(`item ${index}`, signal())),
    );
    const cancelled = new AbortController();
    const abandoned = main.openLane("abandoned", cancelled.signal);
    const queued = main.openLane("queued", signal());
    let started = false;
    void queued.then(() => {
      started = true;
    });
    await Bun.sleep(50);
    expect(started).toBe(false);
    cancelled.abort(new Error("stopped"));
    await expect(abandoned).rejects.toThrow("stopped");
    await lanes[0]?.release();
    const next = await queued;
    expect(next.label).toBe("queued");
    await Promise.all([next.release(), ...lanes.slice(1).map((lane) => lane.release())]);
  });
});
