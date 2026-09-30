import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { AnyTool, ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";

setDefaultTimeout(30_000);

describeWithBrowser("approvals show what a consequential action sends", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  const find = (name: string) =>
    profile.toolset.find((candidate) => candidate.name === name) as AnyTool;
  const run = async (name: string, args: Record<string, unknown>) =>
    ((await find(name).execute("x", args, new AbortController().signal)) as ToolResult).content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  const preview = async (name: string, args: Record<string, unknown>) => {
    const details = await find(name).permissionDetails?.(args);
    return details?.preview?.kind === "text" ? details.preview.lines : [];
  };
  const refOf = (page: string, role: string, name: string) =>
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

  test("a form submit lists the filled fields, masking secrets and skipping placeholders", async () => {
    let page = await run("navigate", { url: site.url("form-basic") });
    page = await run("type", { ref: refOf(page, "textbox", "Full name"), text: "Ada Lovelace" });
    const lines = await preview("click", {
      ref: refOf(page, "button", "Send message"),
      commit: true,
    });
    expect(lines).toContain("sends:");
    expect(lines).toContain("  Full name: Ada Lovelace");
    expect(lines).toContain("  Password: ••••");
    expect(lines).toContain("  Subscribe to newsletter: checked");
    expect(lines.join("\n")).not.toContain("Choose");
    expect(lines.indexOf("sends:")).toBeLessThan(
      lines.findIndex((line) => line.startsWith("why this asks")),
    );
  });

  test("a review page with no fields is summarised by its text, keeping the tail", async () => {
    const page = await run("navigate", { url: site.url("review") });
    const lines = await preview("click", { ref: refOf(page, "button", "Submit application") });
    expect(lines).toContain("page being submitted shows:");
    expect(lines).toContain("  Ada Lovelace");
    expect(lines).toContain("  cv.pdf");
  });

  test("a compose without a form lists recipient chips beside each field, not suggestions", async () => {
    const page = await run("navigate", { url: site.url("compose-chips") });
    const lines = await preview("click", { ref: refOf(page, "button", "Send"), commit: true });
    expect(lines).toContain("sends:");
    expect(lines).toContain(
      "  To recipients: Ada Lovelace <ada@example.com>, Charles Babbage <charles@example.com>",
    );
    expect(lines).toContain("  Cc recipients: mary@example.com");
    expect(lines).toContain("  Subject: Engine notes");
    expect(lines).toContain("  Message Body: Notes on the analytical engine.");
    const text = lines.join("\n");
    expect(text).not.toContain("suggested@example.com");
    expect(text).not.toContain("owner@example.com");
  });

  test("recipients still show once the To row collapses, and never land on Subject", async () => {
    let page = await run("navigate", { url: site.url("compose-chips") });
    page = await run("type", {
      ref: refOf(page, "combobox", "To recipients"),
      text: "grace@example.com",
    });
    page = await run("click", { ref: refOf(page, "textbox", "Subject") });
    const lines = await preview("click", { ref: refOf(page, "button", "Send"), commit: true });
    expect(lines).toContain(
      "  To recipients: Ada Lovelace <ada@example.com>, Charles Babbage <charles@example.com>, grace@example.com",
    );
    expect(lines).toContain("  Subject: Engine notes");
  });

  test("a script-driven Reply link opens the reply box without asking; its Send lists what it sends", async () => {
    let page = await run("navigate", { url: site.url("compose-chips") });
    const reply = { ref: refOf(page, "link", "Reply") };
    expect(find("click").permissionScope?.(reply)).toBe("browser:interact");
    page = await run("click", reply);
    const sends = [...page.matchAll(/button "Send" \[ref=(e\d+)\]/g)].map((match) => match[1]);
    const lines = await preview("click", { ref: sends.at(-1), commit: true });
    expect(lines).toContain("  To recipients: Alex Kim <alex@example.com>");
    expect(lines).toContain("  Reply body: got it");
  });

  test("actions that are not consequential get no summary", async () => {
    const page = await run("navigate", { url: site.url("form-basic") });
    const lines = await preview("click", { ref: refOf(page, "textbox", "Full name") });
    expect(lines.join("\n")).not.toContain("sends:");
  });
});
