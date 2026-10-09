import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(30_000);

describeWithBrowser("allowedHosts hold wherever the page goes", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  const tool = (name: string) => profile.toolset.find((candidate) => candidate.name === name);
  const run = async (name: string, args: Record<string, unknown>) =>
    ((await tool(name)?.execute("x", args, new AbortController().signal)) as ToolResult).content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  const linkRef = (page: string, name: string) =>
    new RegExp(`link "${name}" \\[ref=(e\\d+)\\]`).exec(page)?.[1] as string;

  beforeAll(async () => {
    site = startFixtureSite();
    profile = await browserProfile({
      home,
      headless: true,
      keepOpen: false,
      vision: "off",
      allowedHosts: [new URL(site.origin).host, "collect.example"],
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
  });
  afterAll(async () => {
    await profile.browser.shutdown({ close: true });
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("a redirect to another host is stopped and nothing from it is shown", async () => {
    const result = await run("navigate", {
      url: `${site.origin}/redirect?to=${encodeURIComponent(`${site.crossOrigin}/form-basic`)}`,
    });
    expect(result).toContain(`blocked loading ${site.crossOrigin}/form-basic`);
    expect(result).not.toContain("Contact us");
    expect(await run("read_page", {})).not.toContain("Contact us");
  });

  test("links to another host, in the same tab or through a redirect, are stopped", async () => {
    let page = await run("navigate", { url: site.url("offsite-links") });
    const direct = await run("click", { ref: linkRef(page, "Other site") });
    expect(direct).toContain("blocked loading");
    expect(direct).not.toContain("Contact us");
    page = await run("navigate", { url: site.url("offsite-links") });
    const redirected = await run("click", { ref: linkRef(page, "Redirects to other site") });
    expect(redirected).toContain("blocked loading");
    expect(redirected).not.toContain("Contact us");
    page = await run("navigate", { url: site.url("offsite-links") });
    expect(await run("click", { ref: linkRef(page, "Same site") })).not.toContain("blocked");
  });

  test("a popup on another host is left unread", async () => {
    const page = await run("navigate", { url: site.url("offsite-links") });
    const popup = await run("click", { ref: linkRef(page, "Other site in a new tab") });
    expect(popup).toContain(`blocked loading ${site.crossOrigin}/form-basic`);
    expect(popup).not.toContain("Contact us");
    expect(site.requests).not.toContain(`${site.crossOrigin}/form-basic`);
    expect(await run("read_page", {})).not.toContain("Contact us");
  });

  test("nothing is done on a tab that reached an excluded host past the network block", async () => {
    await run("navigate", { url: site.url("offsite-links") });
    const tab = profile.browser.currentTab();
    if (!tab) throw new Error("no tab");
    // What a load the block missed leaves behind (e.g. a back-forward cache restore).
    tab.url = `${site.crossOrigin}/form-basic`;
    const result = await run("evaluate", { function: "fetch('/api/slow?ms=1').then(() => 'ran')" });
    expect(result).toContain(`left ${site.crossOrigin}/form-basic unread`);
    expect(result).not.toContain("ran");
    expect(site.requests).not.toContain(`${site.origin}/api/slow`);
    expect(profile.browser.currentTab()?.url).toBe("about:blank");
  });

  test("after a blocked load the agent may still go back and close the tab", async () => {
    let page = await run("navigate", { url: site.url("offsite-links") });
    await run("tabs", { action: "open", url: site.url("offsite-links") });
    page = await run("snapshot", {});
    expect(await run("click", { ref: linkRef(page, "Other site") })).toContain("blocked loading");
    const tab = profile.browser.currentTab();
    if (!tab) throw new Error("no tab");
    // Target info names an error page by the URL that failed.
    tab.url = `${site.crossOrigin}/form-basic`;
    expect(tool("navigate")?.permissionPattern?.({ url: "back" })).toBe("about:blank");
    expect(tool("tabs")?.permissionPattern?.({ action: "close", tabId: tab.tabId })).toBe(
      "about:blank",
    );
    expect(tool("tabs")?.permissionPattern?.({ action: "switch", tabId: "t1" })).toBe(
      new URL(site.origin).host,
    );
    await run("tabs", { action: "close", tabId: tab.tabId });
  });

  test("an excluded host stays a navigation, so the allowlist denies it even when it would share data", () => {
    const navigate = tool("navigate");
    const query = `?q=${"x".repeat(400)}`;
    const scope = (url: string) =>
      typeof navigate?.permissionScope === "function"
        ? navigate.permissionScope({ url })
        : navigate?.permissionScope;
    expect(scope(`https://elsewhere.example${query}`)).toBe("browser:navigate");
    expect(scope(`https://collect.example${query}`)).toBe("browser:share");
  });
});
