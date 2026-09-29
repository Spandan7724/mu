import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(30_000);

describeWithBrowser("pages cannot tell mu is attached", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  beforeAll(async () => {
    site = startFixtureSite();
    profile = await browserProfile({
      home,
      headless: true,
      keepOpen: false,
      vision: "off",
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
  });
  afterAll(async () => {
    await profile.browser.shutdown({ close: true });
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("navigator.webdriver is false even though remote debugging is on", async () => {
    const tab = await profile.browser.activeTab();
    const result = await tab.session.send("Runtime.evaluate", {
      expression: "navigator.webdriver",
      returnByValue: true,
    });
    expect(result.result.value).toBe(false);
  });

  test("console serialization (the Runtime.enable tell) does not happen, in pages or frames", async () => {
    const run = async (name: string, args: Record<string, unknown>) =>
      (
        (await profile.toolset
          .find((candidate) => candidate.name === name)
          ?.execute("x", args, new AbortController().signal)) as ToolResult
      ).content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
    await run("navigate", { url: site.url("devtools-detect") });
    await run("wait", { seconds: 0.5 });
    const page = await run("snapshot", {});
    expect(page).toContain("paragraph: clean");
    expect(page).not.toContain("debugger detected");
  });
});
