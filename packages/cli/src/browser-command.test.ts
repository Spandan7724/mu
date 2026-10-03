import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { browserProfile, managedState } from "@mu/profile-browser";
import {
  describeWithBrowser,
  tempUserDataDir,
  testBrowserPath,
} from "@mu/profile-browser/testing/chrome.ts";
import { currentExecutableCommand } from "./agent-supervisor.ts";
import { parseArgs } from "./args.ts";
import { runBrowserClose, runBrowserLogin, runBrowserStatus } from "./browser-command.ts";
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
      codingCommand: currentExecutableCommand([]),
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
  test("opens a plain browser without a debugging endpoint, closes it on Enter, and the profile is reused", async () => {
    const home = tempUserDataDir();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<title>Sign in</title>", { headers: { "content-type": "text/html" } }),
    });
    const out: string[] = [];
    let entered!: () => void;
    const code = runBrowserLogin(
      parseArgs(["browser", "login", `http://127.0.0.1:${server.port}/`]),
      { stdout: (s) => out.push(s), stderr: (s) => out.push(s) },
      {
        home,
        ...(testBrowserPath ? { executable: testBrowserPath } : {}),
        extraArgs: ["--headless=new"],
        waitForEnter: () =>
          new Promise((resolve) => {
            entered = resolve;
          }),
      },
    );
    while (!out.join("").includes("press Enter")) await Bun.sleep(10);
    const profile = await browserProfile({ home, headless: true, keepOpen: false });
    await Bun.sleep(300);
    expect((await managedState(profile.config.userDataDir)).running).toBe(false);
    expect(out.join("")).toContain("not controlled by mu");
    entered();
    expect(await code).toBe(0);
    expect(out.join("")).toContain("sign-ins are saved");
    expect((await managedState(profile.config.userDataDir)).locked).toBe(false);
    await profile.browser.activeTab();
    expect(profile.browser.status()).toMatchObject({ connected: true, launched: true });
    await profile.browser.shutdown({ close: true });
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });
});

describeWithBrowser("mu browser status and close", () => {
  test("status reports a running managed browser; close shuts it", async () => {
    const home = tempUserDataDir();
    const profile = await browserProfile({
      home,
      headless: true,
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
    await profile.browser.activeTab();
    await profile.browser.shutdown();
    const out: string[] = [];
    const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s) };
    expect(await runBrowserStatus(parseArgs(["browser", "status"]), io, { home })).toBe(0);
    expect(out.join("")).toMatch(/running: yes \(ws:\/\/127\.0\.0\.1:\d+/);
    expect(await runBrowserClose(parseArgs(["browser", "close"]), io, { home })).toBe(0);
    expect(out.join("")).toContain("Closed the managed browser.");
    out.length = 0;
    await runBrowserStatus(parseArgs(["browser", "status"]), io, { home });
    expect(out.join("")).toContain("running: no");
    await runBrowserClose(parseArgs(["browser", "close"]), io, { home });
    expect(out.join("")).toContain("not running");
    rmSync(home, { recursive: true, force: true });
  });

  test("slash commands: /browser status with ledger, /tabs, /signin", async () => {
    const home = tempUserDataDir();
    const profile = await browserProfile({
      home,
      headless: true,
      keepOpen: false,
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
    const command = (name: string) =>
      profile.commands?.find((candidate) => candidate.name === name);
    const ctx = (args: string) =>
      ({
        args,
        inject: () => {},
        print: () => {},
        getModel: () => "x",
        setModel: () => {},
      }) as never;
    const before = (await command("browser")?.run(ctx(""))) as { message: string };
    expect(before.message).toContain("not connected (starts on the first browser action)");
    profile.ledger.append({
      id: "c1",
      at: Date.UTC(2026, 8, 29),
      host: "mail.test",
      url: "",
      action: "click",
      target: 'button "Send"',
    });
    const tabs = (await command("tabs")?.run(ctx(""))) as { message: string };
    expect(tabs.message).toMatch(/t\d+ "New Tab"/);
    const after = (await command("browser")?.run(ctx(""))) as { message: string };
    expect(after.message).toContain("state: connected (launched by mu)");
    expect(after.message).toContain('mail.test: click button "Send"');
    expect(command("login")).toBeUndefined();
    const login = (await command("signin")?.run(ctx("about:blank"))) as { message: string };
    expect(login.message).toContain("running headless");
    await profile.browser.shutdown({ close: true });
    rmSync(home, { recursive: true, force: true });
  });
});
