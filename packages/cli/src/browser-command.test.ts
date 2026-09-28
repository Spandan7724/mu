import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { browserProfile } from "@mu/profile-browser";
import {
  describeWithBrowser,
  tempUserDataDir,
  testBrowserPath,
} from "@mu/profile-browser/testing/chrome.ts";
import { parseArgs } from "./args.ts";
import { runBrowserLogin } from "./browser-command.ts";
import { profileOptionsFromArgs } from "./profiles.ts";

describe("mu browser arguments", () => {
  test("mu browser selects the browser profile for the interactive app", () => {
    expect(parseArgs(["browser"])).toMatchObject({ mode: "tui", profile: "browser" });
    expect(parseArgs(["--profile", "browser"])).toMatchObject({ mode: "tui", profile: "browser" });
  });

  test("login takes an optional start URL and browser flags", () => {
    expect(parseArgs(["browser", "login"])).toMatchObject({ mode: "browser-login" });
    expect(
      parseArgs(["browser", "login", "https://github.com/login", "--browser-profile", "work"]),
    ).toMatchObject({
      mode: "browser-login",
      loginUrl: "https://github.com/login",
      browserProfile: "work",
    });
  });

  test("browser flags reach only the browser profile", () => {
    const args = parseArgs(["browser", "-p", "hi", "--cdp", "http://127.0.0.1:9222", "--headless"]);
    expect(args).toMatchObject({ mode: "headless", prompt: "hi", headless: true });
    expect(profileOptionsFromArgs({ browser: args }, "browser")).toEqual({
      cdpUrl: "http://127.0.0.1:9222",
      headless: true,
    });
    expect(profileOptionsFromArgs({ noInstructions: true, browser: args }, "coding")).toEqual({
      instructions: { enabled: false },
    });
  });

  test("browser must come first and flags need values", () => {
    expect(parseArgs(["-p", "x", "browser"]).errors.length).toBeGreaterThan(0);
    expect(parseArgs(["--cdp"]).errors).toContain("--cdp requires an endpoint URL");
  });

  test("login refuses --cdp and --headless", async () => {
    const out: string[] = [];
    const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s) };
    expect(await runBrowserLogin(parseArgs(["browser", "login", "--cdp", "x:1"]), io)).toBe(2);
    expect(await runBrowserLogin(parseArgs(["browser", "login", "--headless"]), io)).toBe(2);
    expect(out.join("")).toContain("needs a visible window");
  });
});

describeWithBrowser("mu browser login", () => {
  test("opens the start page, waits for Enter, and leaves the browser running", async () => {
    const home = tempUserDataDir();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<title>Sign in</title>", { headers: { "content-type": "text/html" } }),
    });
    const profile = await browserProfile({
      home,
      headless: true,
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
    const out: string[] = [];
    let entered!: () => void;
    const code = runBrowserLogin(
      parseArgs(["browser", "login", `http://127.0.0.1:${server.port}/`]),
      { stdout: (s) => out.push(s), stderr: (s) => out.push(s) },
      {
        profile,
        waitForEnter: () =>
          new Promise((resolve) => {
            entered = resolve;
          }),
      },
    );
    while (!out.join("").includes("Press Enter")) await Bun.sleep(10);
    const opened = profile.browser.tabs().find((tab) => tab.url.includes(String(server.port)));
    expect(opened?.openedByAgent).toBe(true);
    entered();
    expect(await code).toBe(0);
    expect(out.join("")).toContain("stays open");
    const again = await browserProfile({ home, headless: true });
    await again.browser.ensureConnected();
    expect(again.browser.status().launched).toBe(false);
    await again.browser.shutdown({ close: true });
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });
});
