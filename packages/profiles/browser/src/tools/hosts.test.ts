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
    expect(popup).toContain(`left ${site.crossOrigin}/form-basic unread`);
    expect(popup).not.toContain("Contact us");
    expect(await run("read_page", {})).not.toContain("Contact us");
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
