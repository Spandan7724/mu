import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(30_000);

describeWithBrowser("loop detection", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  const run = async (name: string, args: Record<string, unknown>) =>
    (
      (await profile.toolset
        .find((candidate) => candidate.name === name)
        ?.execute("x", args, new AbortController().signal)) as ToolResult
    ).content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");

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

  test("three interactions that change nothing trigger a nudge; a change resets it", async () => {
    const page = await run("navigate", { url: site.url("custom-select") });
    const settings = /clickable "Settings" \[ref=(e\d+)\]/.exec(page)?.[1] as string;
    expect(await run("click", { ref: settings })).not.toContain("has not changed");
    expect(await run("click", { ref: settings })).not.toContain("has not changed");
    const third = await run("click", { ref: settings });
    expect(third).toContain("note: the page has not changed after 3 actions");
    const opened = await run("click", {
      ref: /clickable "Select size ▾" \[ref=(e\d+)\]/.exec(page)?.[1] as string,
    });
    expect(opened).not.toContain("has not changed");
    expect(await run("snapshot", {})).not.toContain("has not changed");
  });

  test("repeated tab switching without acting gets a nudge", async () => {
    await run("navigate", { url: site.url("form-basic") });
    await run("tabs", { action: "open", url: site.url("long") });
    expect(await run("tabs", { action: "switch", tabId: "t1" })).not.toContain(
      "tab switches in a row",
    );
    await run("tabs", { action: "switch", tabId: "t2" });
    expect(await run("tabs", { action: "switch", tabId: "t1" })).toContain(
      "3 tab switches in a row",
    );
    await run("snapshot", {});
    expect(await run("tabs", { action: "switch", tabId: "t2" })).not.toContain(
      "tab switches in a row",
    );
  });
});
