import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { AnyTool, ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(30_000);

describeWithBrowser("unchanged site header and footer collapse to one line", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  const run = async (name: string, args: Record<string, unknown>) =>
    (
      (await (profile.toolset.find((tool) => tool.name === name) as AnyTool).execute(
        "x",
        args,
        new AbortController().signal,
      )) as ToolResult
    ).content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  const ref = (page: string, role: string, name: string) =>
    new RegExp(`${role} "${name}" \\[ref=(e\\d+)\\]`).exec(page)?.[1] as string;

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

  test("shown in full first, collapsed while unchanged, expanded when changed or asked for", async () => {
    const first = await run("navigate", { url: site.url("chrome") });
    expect(first).toContain('link "Careers"');
    expect(first).toContain('link "Deals"');

    const bought = await run("click", { ref: ref(first, "button", "Buy one") });
    expect(bought).toContain("In stock: 2");
    expect(bought).toMatch(/- contentinfo \(unchanged, 3 interactive elements; use find/);
    expect(bought).toMatch(/- banner \(unchanged, 4 interactive elements; use find/);
    expect(bought).not.toContain('link "Careers"');

    const found = await run("find", { text: "Careers" });
    expect(found).toContain('link "Careers"');

    const changed = await run("click", { ref: ref(first, "button", "Change footer") });
    expect(changed).toContain("Updated terms");
    expect(changed).toContain('link "Careers"');

    const full = await run("snapshot", { scope: "full" });
    expect(full).toContain('link "Careers"');
    expect(full).toContain('link "Deals"');
  });
});
