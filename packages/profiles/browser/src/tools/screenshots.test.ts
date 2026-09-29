import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { AnyTool, ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(30_000);

describeWithBrowser("screenshots are attached only when they add information", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = (await (profile.toolset.find((tool) => tool.name === name) as AnyTool).execute(
      "x",
      args,
      new AbortController().signal,
    )) as ToolResult;
    return {
      text: result.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
      image: result.content.some((block) => block.type === "image"),
    };
  };
  const ref = (page: string, role: string, name: string) =>
    new RegExp(`${role} "${name}" \\[ref=(e\\d+)\\]`).exec(page)?.[1] as string;

  beforeAll(async () => {
    site = startFixtureSite();
    profile = await browserProfile({
      home,
      headless: true,
      keepOpen: false,
      vision: "on",
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
  });
  afterAll(async () => {
    await profile.browser.shutdown({ close: true });
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("new pages, failures and no-ops get one; small changes do not, with a periodic refresh", async () => {
    const page = await run("navigate", { url: site.url("form-basic") });
    expect(page.image).toBe(true);
    const name = ref(page.text, "textbox", "Full name");
    const email = ref(page.text, "textbox", "Email");
    expect((await run("type", { ref: name, text: "Ada" })).image).toBe(false);
    expect((await run("type", { ref: email, text: "ada@example.com" })).image).toBe(false);
    const draft = ref(page.text, "button", "Save draft");
    expect((await run("click", { ref: draft })).image).toBe(false);
    const again = await run("click", { ref: draft });
    expect(again.text.split("\n")[0]).toContain("(no visible change)");
    expect(again.image).toBe(true);
    expect((await run("type", { ref: name, text: "Ada L" })).image).toBe(false);
    expect((await run("type", { ref: name, text: "Ada Lo" })).image).toBe(false);
    expect((await run("type", { ref: name, text: "Ada Lov" })).image).toBe(false);
    expect((await run("type", { ref: name, text: "Ada Love" })).image).toBe(false);
    expect((await run("type", { ref: name, text: "Ada Lovel" })).image).toBe(true);
  });
});
