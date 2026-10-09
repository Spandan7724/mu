import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";
import { until } from "../testing/wait.ts";

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

  test("a no-op right after a fresh page counts as no change, despite collapsed landmarks", async () => {
    const page = await run("navigate", { url: site.url("form-basic") });
    expect(page).toContain('- navigation "Main"');
    const disabled = /button "Save draft" \[ref=(e\d+)\] \[disabled\]/.exec(page)?.[1] as string;
    const clicked = await run("click", { ref: disabled });
    expect(clicked).toContain("(unchanged,");
    expect(clicked.split("\n")[0]).toEndWith("(no visible change)");
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
    const refused = await run("tabs", { action: "switch", tabId: "t2" });
    expect(refused).toContain("did not switch to t2");
    expect(refused).toContain("What you have recorded so far");
    await run("snapshot", {});
    expect(await run("tabs", { action: "switch", tabId: "t2" })).not.toContain(
      "tab switches in a row",
    );
  });

  test("past four agent tabs the least recently used one is closed, never a user tab", async () => {
    const connection = await profile.browser.ensureConnected();
    const { targetId: userTarget } = await connection.send("Target.createTarget", {
      url: site.url("shadow"),
    });
    const userTab = () =>
      profile.browser.tabs().find((tab) => tab.url.includes("/shadow") && !tab.openedByAgent);
    await until(() => userTab() !== undefined);
    const pages = ["long", "modal", "custom-select", "iframes", "form-validation", "dialogs"];
    let closedNote = "";
    for (const page of pages) {
      const text = await run("tabs", { action: "open", url: site.url(page) });
      if (text.includes("to keep at most 4 agent tabs open")) closedNote = text;
    }
    expect(closedNote).toMatch(/note: Closed tab t\d+ \(.+\) to keep at most 4 agent tabs open/);
    expect(profile.browser.tabs().filter((tab) => tab.openedByAgent).length).toBeLessThanOrEqual(4);
    expect(userTab()).toBeDefined();
    await connection.send("Target.closeTarget", { targetId: userTarget });
  });
  test("acting on a tab the user left in the background brings it to the front", async () => {
    const page = await run("navigate", { url: site.url("custom-select") });
    const connection = await profile.browser.ensureConnected();
    const { targetId } = await connection.send("Target.createTarget", { url: site.url("long") });
    const visibility = async () => {
      const tab = await profile.browser.activeTab();
      const { result } = await tab.session.send("Runtime.evaluate", {
        expression: "document.visibilityState",
        returnByValue: true,
      });
      return result.value;
    };
    await until(async () => (await visibility()) === "hidden");
    const clicked = await run("click", {
      ref: /clickable "Select size ▾" \[ref=(e\d+)\]/.exec(page)?.[1] as string,
    });
    expect(clicked).not.toContain("timed out");
    expect(await visibility()).toBe("visible");
    await connection.send("Target.closeTarget", { targetId });
  });
});
