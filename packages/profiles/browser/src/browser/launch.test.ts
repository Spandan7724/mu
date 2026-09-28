import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, statSync, symlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { attachToTarget } from "../cdp/session.ts";
import {
  describeWithBrowser,
  launchTestBrowser,
  type TestBrowser,
  tempUserDataDir,
  testBrowserPath,
} from "../testing/chrome.ts";
import { connectManaged, connectToEndpoint, profileLocked, resolveCdpUrl } from "./connect.ts";
import { ensureProfileDir, managedArgs, parseDevToolsActivePort } from "./launch.ts";

describe("managed launch configuration", () => {
  test("headed by default, debugging on a free port, never automation-flagged", () => {
    const args = managedArgs({
      userDataDir: "/p",
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: ["--enable-automation", "--lang=en"],
    });
    expect(args).toContain("--user-data-dir=/p");
    expect(args).toContain("--remote-debugging-port=0");
    expect(args).toContain("--disable-backgrounding-occluded-windows");
    expect(args).toContain("--window-size=1280,800");
    expect(args).toContain("--lang=en");
    expect(args).not.toContain("--enable-automation");
    expect(args.some((arg) => arg.startsWith("--headless"))).toBe(false);
    expect(
      managedArgs({ userDataDir: "/p", headless: true, viewport: { width: 1, height: 1 } }),
    ).toContain("--headless=new");
  });

  test("parses DevToolsActivePort", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/abc\n")).toBe(
      "ws://127.0.0.1:9222/devtools/browser/abc",
    );
    expect(parseDevToolsActivePort("")).toBeUndefined();
    expect(parseDevToolsActivePort("nope\n/x")).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")("profile directories are private", () => {
    const dir = join(tempUserDataDir(), "profiles", "default");
    ensureProfileDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test.skipIf(process.platform === "win32")(
    "a live SingletonLock without an endpoint is reported, a stale one is not",
    async () => {
      const dir = tempUserDataDir();
      expect(profileLocked(dir)).toBe(false);
      symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
      expect(profileLocked(dir)).toBe(true);
      await expect(
        connectManaged({ userDataDir: dir, headless: true, viewport: { width: 1, height: 1 } }),
      ).rejects.toThrow("already open in a browser that mu cannot control");
      rmSync(join(dir, "SingletonLock"));
      symlinkSync(`${hostname()}-2147483646`, join(dir, "SingletonLock"));
      expect(profileLocked(dir)).toBe(false);
    },
  );

  test("--cdp reports an unreachable endpoint clearly", async () => {
    await expect(resolveCdpUrl("127.0.0.1:1", { timeoutMs: 500 })).rejects.toThrow(
      "No CDP endpoint answered",
    );
    expect(await resolveCdpUrl("ws://127.0.0.1:9/devtools/browser/x")).toBe(
      "ws://127.0.0.1:9/devtools/browser/x",
    );
  });
});

describeWithBrowser("managed browser in real headless Chrome", () => {
  let browser: TestBrowser;
  let coldLaunchMs = 0;

  beforeAll(async () => {
    const started = performance.now();
    browser = await launchTestBrowser();
    coldLaunchMs = performance.now() - started;
  });

  afterAll(async () => {
    await browser?.close();
  });

  test("cold launch reaches a usable endpoint within budget", async () => {
    const version = await browser.connection.send("Browser.getVersion");
    expect(version.product).toMatch(/Chrome|Chromium|Brave|Edg/);
    expect(browser.pid).toBeGreaterThan(0);
    expect(coldLaunchMs).toBeLessThan(2_500);
    console.log(`cold launch ${coldLaunchMs.toFixed(0)} ms (${testBrowserPath})`);
  });

  test("was not launched with --enable-automation", async () => {
    // Chrome only reveals its command line when automation is enabled.
    await expect(browser.connection.send("Browser.getBrowserCommandLine")).rejects.toThrow();
  });

  test("a second process re-attaches instead of launching", async () => {
    const started = performance.now();
    const again = await connectManaged({
      userDataDir: browser.userDataDir,
      headless: true,
      viewport: { width: 1280, height: 800 },
      launcher: {
        discover: async () => {
          throw new Error("must not discover");
        },
        launch: async () => {
          throw new Error("must not launch");
        },
      },
    });
    const reattachMs = performance.now() - started;
    expect(again.endpoint).toEqual({ wsUrl: browser.wsUrl, launched: false });
    expect((await again.connection.send("Browser.getVersion")).product).toBeTruthy();
    await again.connection.close();
    expect(reattachMs).toBeLessThan(300);
    console.log(`re-attach ${reattachMs.toFixed(0)} ms`);
  });

  test("--cdp connects through the http endpoint", async () => {
    const { connection, endpoint } = await connectToEndpoint(
      new URL(browser.wsUrl).host.replace("127.0.0.1", "http://127.0.0.1"),
    );
    expect(endpoint.wsUrl).toBe(browser.wsUrl);
    expect((await connection.send("Target.getTargets")).targetInfos.length).toBeGreaterThan(0);
    await connection.close();
  });

  test("drives a page through a flattened session", async () => {
    const { connection } = browser;
    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
    const session = await attachToTarget(connection, targetId);
    await session.send("Page.enable");
    const loaded = session.waitFor("Page.loadEventFired");
    await session.send("Page.navigate", {
      url: "data:text/html,<title>hello</title><p id=x>mu</p>",
    });
    await loaded;
    const { result } = await session.send("Runtime.evaluate", {
      expression: "document.title + ':' + document.getElementById('x').textContent",
      returnByValue: true,
    });
    expect(result.value).toBe("hello:mu");
    await connection.send("Target.closeTarget", { targetId });
    await expect(session.send("Runtime.evaluate", { expression: "1" })).rejects.toMatchObject({
      kind: "target-closed",
    });
  });

  test("a headed request replaces a headless browser left on the profile", async () => {
    const other = await launchTestBrowser();
    let launched = false;
    await expect(
      connectManaged({
        userDataDir: other.userDataDir,
        headless: false,
        viewport: { width: 1280, height: 800 },
        launcher: {
          discover: async () => ({
            path: "/fake",
            channel: "chrome",
            product: "Google Chrome",
            version: "1",
          }),
          launch: async () => {
            launched = true;
            throw new Error("stop here");
          },
        },
      }),
    ).rejects.toThrow("stop here");
    expect(launched).toBe(true);
    await other.close();
  });
});
