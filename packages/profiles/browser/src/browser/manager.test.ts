import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { endpointAlive } from "./connect.ts";
import { killBrowserProcess, readDevToolsActivePort } from "./launch.ts";
import { BrowserManager } from "./manager.ts";

setDefaultTimeout(30_000);

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

describeWithBrowser("BrowserManager in real headless Chrome", () => {
  const userDataDir = tempUserDataDir();
  let manager: BrowserManager;
  let child: ReturnType<typeof Bun.serve>;
  let parent: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    child = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<title>child</title><button>inner</button>", {
          headers: { "content-type": "text/html" },
        }),
    });
    parent = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        // A different host name makes the iframe cross-site, hence out of process.
        new Response(
          `<title>parent</title><iframe src="http://localhost:${child.port}/"></iframe>`,
          { headers: { "content-type": "text/html" } },
        ),
    });
    manager = new BrowserManager({
      connect: "managed",
      profileName: "test",
      userDataDir,
      executable: testBrowserPath,
      headless: true,
      viewport: { width: 1280, height: 800 },
      keepOpen: false,
    });
  });

  afterAll(async () => {
    await manager.shutdown({ close: true });
    child.stop(true);
    parent.stop(true);
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test("does not start a browser until a tab is needed", () => {
    expect(manager.status()).toMatchObject({ connected: false, launched: false });
    expect(existsSync(join(userDataDir, "DevToolsActivePort"))).toBe(false);
  });

  test("first use launches and reuses the blank start tab", async () => {
    const tab = await manager.activeTab();
    expect(manager.status()).toMatchObject({ connected: true, launched: true, mode: "managed" });
    expect(manager.status().version).toMatch(/^\d+\./);
    expect(manager.tabs()).toEqual([
      {
        tabId: tab.tabId,
        url: expect.stringMatching(/^(about:blank|chrome:\/\/new-?tab)/),
        title: expect.any(String),
        active: true,
        openedByAgent: true,
      },
    ]);
    expect(await manager.activeTab()).toBe(tab);
  });

  test("opens, switches and closes tabs by short id", async () => {
    const first = await manager.activeTab();
    const second = await manager.openTab("about:blank#two");
    expect(second.tabId).not.toBe(first.tabId);
    expect(manager.tabs().find((tab) => tab.active)?.tabId).toBe(second.tabId);
    expect((await manager.switchTab(first.tabId)).tabId).toBe(first.tabId);
    await manager.closeTab(second.tabId);
    expect(manager.tabs().map((tab) => tab.tabId)).toEqual([first.tabId]);
    await expect(manager.switchTab("t99")).rejects.toThrow('No tab "t99"');
  });

  test("auto-attaches out-of-process iframes with their own session", async () => {
    const tab = await manager.activeTab();
    await tab.session.send("Page.navigate", { url: `http://127.0.0.1:${parent.port}/` });
    const isChild = (frame: { url: string; session: unknown }) =>
      frame.url.startsWith(`http://localhost:${child.port}`) && frame.session !== tab.session;
    await until(() => tab.frames.list().some(isChild));
    const frame = tab.frames.list().find(isChild);
    if (!frame) throw new Error("iframe frame missing");
    expect(frame.session).not.toBe(tab.session);
    expect(frame.parentId).toBe(tab.frames.mainFrameId as string);
    const { result } = await frame.session.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    expect(result.value).toBe("child");
  });

  test("tracks JavaScript dialogs on the tab", async () => {
    const tab = await manager.activeTab();
    const opened = tab.session.waitFor("Page.javascriptDialogOpening");
    await tab.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => confirm('sure?'))",
    });
    await opened;
    expect(tab.dialog).toEqual({ type: "confirm", message: "sure?" });
    await tab.session.send("Page.handleJavaScriptDialog", { accept: true });
    await until(() => tab.dialog === undefined);
  });

  test("stop aborts in-flight CDP work", async () => {
    const tab = await manager.activeTab();
    const pending = tab.session.send(
      "Runtime.evaluate",
      { expression: "new Promise(() => {})", awaitPromise: true },
      { signal: manager.actionSignal() },
    );
    manager.stop();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  test("a browser crash is reported once and the next call recovers", async () => {
    const before = manager.status().pid;
    killBrowserProcess(before);
    await until(() => !manager.isConnected);
    expect(manager.drainNotices()).toEqual([expect.stringContaining("browser disconnected")]);
    expect(manager.drainNotices()).toEqual([]);
    const tab = await manager.activeTab();
    expect(manager.status()).toMatchObject({ connected: true, launched: true });
    expect(manager.status().pid).not.toBe(before);
    const { result } = await tab.session.send("Runtime.evaluate", {
      expression: "1 + 1",
      returnByValue: true,
    });
    expect(result.value).toBe(2);
  });

  test("shutdown detaches by default and closes when asked", async () => {
    const wsUrl = readDevToolsActivePort(userDataDir) as string;
    const kept = new BrowserManager({ ...manager.options, keepOpen: true });
    await kept.activeTab();
    expect(kept.status().launched).toBe(false);
    await kept.shutdown();
    expect(await endpointAlive(wsUrl)).toBe(true);
    await manager.shutdown({ close: true });
    await until(async () => !(await endpointAlive(wsUrl)));
  });
});
