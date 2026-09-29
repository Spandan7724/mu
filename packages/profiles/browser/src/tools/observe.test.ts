import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { filterSections, paginate } from "../page/text.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(30_000);

const text = (result: ToolResult) =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

describe("read_page helpers", () => {
  test("query keeps matching sections; pagination breaks on lines and reports offsets", () => {
    const markdown = "# Intro\nhello\n# Pricing\nPro costs $10\n# Contact\nmail us";
    expect(filterSections(markdown, "pricing")).toBe("# Pricing\nPro costs $10");
    expect(filterSections(markdown, "nothing here")).toBe("");
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const first = paginate(long, 0, 100);
    expect(first.start).toBe(0);
    expect(first.chunk.endsWith("\n")).toBe(false);
    expect(first.end).toBeLessThanOrEqual(100);
    const second = paginate(long, first.end, 100);
    expect(second.start).toBe(first.end);
    expect(second.total).toBe(long.length);
  });
});

describeWithBrowser("observation tools in real headless Chrome", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  const run = async (name: string, args: Record<string, unknown>) =>
    (await profile.toolset
      .find((candidate) => candidate.name === name)
      ?.execute("call", args, new AbortController().signal)) as ToolResult;

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

  test("snapshot: viewport by default, full on request, subtree by ref", async () => {
    await run("navigate", { url: site.url("long") });
    const viewport = text(await run("snapshot", {}));
    expect(viewport).toStartWith("snapshot (viewport)\n");
    expect(viewport).not.toContain('"Article 80"');
    const full = await run("snapshot", { scope: "full" });
    expect(text(full)).toContain('"Article 80"');
    expect(full.retention?.key).toBe("browser:observation");
    await run("navigate", { url: site.url("form-basic") });
    const subtree = text(await run("snapshot", { ref: "e13" }));
    expect(subtree).toContain('- combobox "Country" [ref=e13]');
    expect(subtree).not.toContain("Send message");
    const stale = await run("snapshot", { ref: "e999" });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("ref e999");
  });

  test("read_page: main content as markdown with link refs, query filter", async () => {
    await run("navigate", { url: site.url("form-basic") });
    const read = await run("read_page", {});
    const body = text(read);
    expect(body).toContain("reading: main content");
    expect(body).toContain("# Contact us");
    expect(body).toContain("Fill in the form and we will get back to you");
    expect(body).toContain('[button "Send message" [ref=e14]]');
    expect(body).not.toContain("Pricing");
    expect(read.retention?.key).toBe("browser:read_page");
    await run("navigate", { url: site.url("long") });
    const longRead = text(await run("read_page", {}));
    expect(longRead).toContain("reading: page (navigation, header and footer omitted)");
    expect(longRead).toMatch(/\n- \[Article 80\]\(e\d+ \/article\/80\) by author 80\n/);
    const none = text(await run("read_page", { query: "zebra" }));
    expect(none).toContain('(no section mentions "zebra")');
  });

  test("find: whole-page search with refs and positions", async () => {
    await run("navigate", { url: site.url("long") });
    const found = await run("find", { text: "article 57" });
    expect(text(found)).toMatch(/find "article 57": 1 match\n/);
    expect(text(found)).toMatch(
      /- link "Article 57" \[ref=e\d+\] → \/article\/57 \(below; in list › listitem "by author 57"\)/,
    );
    const regex = text(await run("find", { regex: "^Article 7\\d$", limit: 3 }));
    expect(regex).toContain("10 matches");
    expect(regex).toContain("… (7 more; narrow the search or raise limit)");
    expect((await run("find", { regex: "(" })).isError).toBe(true);
    expect((await run("find", {})).isError).toBe(true);
  });

  test("screenshot refuses when the model cannot see images", async () => {
    const result = await run("screenshot", {});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Screenshots are off");
  });
});
