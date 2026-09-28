import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";
import { captureScreenshot, screenshotHeader, visionEnabled } from "./screenshot.ts";

function jpegSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, "base64");
  for (let i = 2; i < bytes.length; ) {
    const marker = bytes[i + 1] as number;
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  throw new Error("no SOF marker");
}

describe("vision mode", () => {
  test("auto follows the model catalog; on/off override", () => {
    expect(visionEnabled("on", undefined)).toBe(true);
    expect(visionEnabled("off", "openai-codex/gpt-5.6-luna")).toBe(false);
    expect(visionEnabled("auto", undefined)).toBe(false);
    expect(visionEnabled("auto", "no-such/model")).toBe(false);
  });

  test("header states the CSS coordinate space and any scaling", () => {
    const base = { data: "", mimeType: "image/jpeg" as const, originX: 0, originY: 0 };
    expect(screenshotHeader({ ...base, cssWidth: 1280, cssHeight: 800, scale: 1 })).toBe(
      "screenshot: 1280x800 css px",
    );
    expect(screenshotHeader({ ...base, cssWidth: 2560, cssHeight: 1600, scale: 0.5 })).toContain(
      "image scaled 0.50×",
    );
  });
});

describeWithBrowser("screenshots in real headless Chrome", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  let vision: BrowserProfile;

  const navigate = (target: BrowserProfile, url: string) =>
    target.toolset
      .find((tool) => tool.name === "navigate")
      ?.execute("x", { url }, new AbortController().signal) as Promise<ToolResult>;

  beforeAll(async () => {
    site = startFixtureSite();
    const common = {
      home,
      headless: true,
      keepOpen: false,
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    };
    profile = await browserProfile({ ...common, vision: "off" });
    vision = await browserProfile({ ...common, vision: "on" });
  });

  afterAll(async () => {
    await vision.browser.shutdown({ close: false });
    await profile.browser.shutdown({ close: true });
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("vision off: text-only observation", async () => {
    const result = await navigate(profile, site.url("form-basic"));
    expect(result.content.map((block) => block.type)).toEqual(["text"]);
  });

  test("vision on: JPEG in CSS pixels after page-changing actions", async () => {
    const result = await navigate(vision, site.url("form-basic"));
    const [text, image] = result.content;
    expect(image?.type).toBe("image");
    expect(text?.type === "text" && text.text).toContain(
      "screenshot: 1280x800 css px\n<page_content",
    );
    if (image?.type !== "image") throw new Error("no image");
    expect(image.mimeType).toBe("image/jpeg");
    expect(jpegSize(image.data)).toEqual({ width: 1280, height: 800 });
    const timings = (result.details as { details: { timings: { screenshotMs: number } } }).details
      .timings;
    expect(timings.screenshotMs).toBeGreaterThan(0);
    console.log(
      `screenshot ${timings.screenshotMs} ms, ${Math.round(image.data.length / 1024)} KB`,
    );
  });

  test("high-DPR pages are captured at CSS size", async () => {
    const tab = await vision.browser.activeTab();
    await tab.session.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const shot = await captureScreenshot(tab);
    expect(jpegSize(shot.data)).toEqual({ width: 1280, height: 800 });
    const element = await captureScreenshot(tab, { box: { x: 10, y: 20, w: 200, h: 100 } });
    expect(jpegSize(element.data)).toEqual({ width: 200, height: 100 });
    expect([element.originX, element.originY]).toEqual([10, 20]);
    await tab.session.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 0,
      mobile: false,
    });
  });
});
