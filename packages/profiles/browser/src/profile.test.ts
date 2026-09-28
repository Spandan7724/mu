import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent, optionsFromProfile } from "mu";
import type { BrowserLauncher } from "./browser/connect.ts";
import { endpointAlive } from "./browser/connect.ts";
import { readDevToolsActivePort } from "./browser/launch.ts";
import { resolveBrowserOptions } from "./config.ts";
import { browserProfile } from "./index.ts";
import { describeWithBrowser, testBrowserPath } from "./testing/chrome.ts";

function tempHome(config?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "mu-browser-home-"));
  if (config !== undefined) {
    mkdirSync(join(home, ".mu"), { recursive: true });
    writeFileSync(join(home, ".mu", "config.json"), JSON.stringify(config));
  }
  return home;
}

function recordingLauncher() {
  const calls: string[] = [];
  const launcher: BrowserLauncher = {
    discover: async () => {
      calls.push("discover");
      return {
        path: "/fake/chrome",
        channel: "chrome",
        product: "Google Chrome",
        version: "154.0",
      };
    },
    launch: async () => {
      calls.push("launch");
      throw new Error("launch not expected");
    },
  };
  return { calls, launcher };
}

describe("browser profile options", () => {
  test("config file supplies defaults that explicit options override", () => {
    const home = tempHome({
      model: "x/y",
      browser: { browserProfile: "work", headless: true, viewport: { width: 1024, height: 700 } },
    });
    const config = resolveBrowserOptions({ home, headless: false });
    expect(config).toMatchObject({
      browserProfile: "work",
      connect: "managed",
      headless: false,
      vision: "auto",
      keepOpen: true,
      viewport: { width: 1024, height: 700 },
      userDataDir: join(home, ".mu", "browser", "profiles", "work"),
      downloadsDir: join(home, ".mu", "browser", "downloads"),
    });
    expect(resolveBrowserOptions({ home, cdpUrl: "http://127.0.0.1:9222" }).connect).toBe("cdp");
  });

  test("invalid config is reported and ignored; invalid names and cdp without url throw", () => {
    const home = tempHome({ browser: { headless: "yes" } });
    const warnings: string[] = [];
    expect(resolveBrowserOptions({ home }, (message) => warnings.push(message)).headless).toBe(
      false,
    );
    expect(warnings[0]).toContain("browser.headless");
    expect(() => resolveBrowserOptions({ home, browserProfile: "../escape" })).toThrow(
      "Invalid browser profile name",
    );
    expect(() => resolveBrowserOptions({ home, connect: "cdp" })).toThrow("needs a cdpUrl");
  });
});

describe("browser profile", () => {
  test("creating the profile and its environment never launches a browser", async () => {
    const home = tempHome();
    const { calls, launcher } = recordingLauncher();
    const profile = await browserProfile({ home, launcher });
    const env = await profile.environment?.();
    expect(env).toMatchObject({
      browser: "Google Chrome 154.0",
      executable: "/fake/chrome",
      browserProfile: "default",
      connection: "managed persistent profile",
      headless: "false",
      vision: "auto",
    });
    expect(calls).toEqual(["discover"]);
    expect(await profile.scope?.()).toBe("browser-default");
    expect(existsSync(join(home, ".mu", "browser"))).toBe(false);
    const [message] = (await profile.contextMessages?.()) ?? [];
    expect(message).toMatchObject({ role: "custom", customType: "environment" });
  });

  test("runtime stop aborts the manager's action signal", async () => {
    const profile = await browserProfile({
      home: tempHome(),
      launcher: recordingLauncher().launcher,
    });
    const signal = profile.browser.actionSignal();
    profile.runtime?.stop?.();
    expect(signal.aborted).toBe(true);
    expect(profile.browser.actionSignal().aborted).toBe(false);
    await profile.runtime?.shutdown?.();
  });
});

describeWithBrowser("browser profile runtime in real headless Chrome", () => {
  test("agent shutdown closes the browser when keepOpen is false", async () => {
    const home = tempHome();
    const profile = await browserProfile({
      home,
      headless: true,
      keepOpen: false,
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
    const agent = new Agent(
      await optionsFromProfile(profile, "fake/fake-1", {
        provider: new FakeProvider([]),
        model: fakeModel,
      }),
    );
    await profile.browser.activeTab();
    const wsUrl = readDevToolsActivePort(profile.config.userDataDir) as string;
    expect(await endpointAlive(wsUrl)).toBe(true);
    await agent.shutdown();
    const deadline = Date.now() + 5_000;
    while ((await endpointAlive(wsUrl)) && Date.now() < deadline) await Bun.sleep(20);
    expect(await endpointAlive(wsUrl)).toBe(false);
  });
});
