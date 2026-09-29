import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ToolResult } from "@mu/core";
import { normalizeUrl } from "../actions/navigate.ts";
import type { ActionOutcome } from "../actions/types.ts";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";

setDefaultTimeout(30_000);

describe("URL normalization", () => {
  test("bare domains get https, local hosts get http, schemes pass through", () => {
    expect(normalizeUrl("gmail.com")).toBe("https://gmail.com");
    expect(normalizeUrl("news.ycombinator.com/news?p=2")).toBe(
      "https://news.ycombinator.com/news?p=2",
    );
    expect(normalizeUrl("localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(normalizeUrl("127.0.0.1")).toBe("http://127.0.0.1");
    expect(normalizeUrl("devbox:8080")).toBe("http://devbox:8080");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
    expect(() => normalizeUrl("cheap flights to paris")).toThrow("is not a URL");
    expect(() => normalizeUrl("intranet")).toThrow("is not a URL");
  });
});

function text(result: ToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describeWithBrowser("navigate and tabs tools in real headless Chrome", () => {
  const home = tempUserDataDir();
  let profile: BrowserProfile;
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  const run = async (name: string, args: Record<string, unknown>) => {
    const found = profile.toolset.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found.execute("call", args, new AbortController().signal) as Promise<ToolResult>;
  };

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const page = new URL(request.url).pathname.slice(1) || "index";
        return new Response(
          `<title>Page ${page}</title><h1>${page}</h1><div style="height:3000px"></div>`,
          {
            headers: { "content-type": "text/html" },
          },
        );
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    profile = await browserProfile({
      home,
      headless: true,
      keepOpen: false,
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
  });

  afterAll(async () => {
    await profile.runtime?.shutdown?.();
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("navigate returns the page header, timings and a retention summary", async () => {
    await run("navigate", { url: "about:blank" });
    const result = await run("navigate", { url: `${base}/a` });
    const outcome = result.details as ActionOutcome;
    expect(result.isError).toBeUndefined();
    expect(text(result)).toStartWith(`navigated to ${base}/a\n`);
    expect(text(result)).toContain(`[page] Page a\nurl: ${base}/a (new page`);
    expect(text(result)).toContain('<page_content untrusted="true">\n- heading "a" [level=1]\n');
    expect(text(result)).toMatch(
      /tabs: 1 \(active: t\d+\) · scroll: 0\/\d+ px · viewport 1280x800/,
    );
    expect(text(result)).toContain("dialog: none");
    expect(outcome.details.timings.totalMs).toBeGreaterThan(0);
    expect(outcome.details.settle).toMatch(/page loaded and quiet after navigation \(\d+ ms\)/);
    expect(outcome.details.url).toBe(`${base}/a`);
    expect(result.retention).toEqual({
      key: "browser:observation",
      summary: `navigated to ${base}/a (page: "Page a" ${base}/a)`,
    });
    console.log(`navigate timings ${JSON.stringify(outcome.details.timings)}`);
  });

  test("back, forward, reload and same-document navigation", async () => {
    await run("navigate", { url: `${base}/b` });
    expect(text(await run("navigate", { url: "back" }))).toContain(`url: ${base}/a (new page`);
    expect(text(await run("navigate", { url: "forward" }))).toContain(`url: ${base}/b (new page`);
    const reloaded = await run("navigate", { url: "reload" });
    expect(text(reloaded)).toStartWith("reloaded the page");
    const fragment = await run("navigate", { url: `${base}/b#section` });
    expect((fragment.details as ActionOutcome).details.settle).toBe("same-document navigation");
    expect(text(fragment)).toContain(`url: ${base}/b#section`);
  });

  test("an unreachable host is an actionable error with the page state", async () => {
    const result = await run("navigate", { url: "http://mu-does-not-exist.invalid/" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("could not load http://mu-does-not-exist.invalid/");
    expect(text(result)).toContain("ERR_NAME_NOT_RESOLVED");
    expect(result.retention?.key).toBe("browser:observation");
  });

  test("tabs open, list, switch and close", async () => {
    const opened = await run("tabs", { action: "open", url: `${base}/c` });
    const newId = (opened.details as ActionOutcome).details.tabId;
    expect(text(opened)).toContain("[page] Page c");
    const listed = text(await run("tabs", { action: "list" }));
    expect(listed).toContain(`* ${newId} "Page c" ${base}/c`);
    const first = profile.browser.tabs().find((tab) => !tab.active)?.tabId as string;
    expect(text(await run("tabs", { action: "switch", tabId: first }))).toContain(
      `active: ${first}`,
    );
    const closed = await run("tabs", { action: "close", tabId: newId });
    expect(text(closed)).toContain(`closed tab ${newId}`);
    expect(profile.browser.tabs().map((tab) => tab.tabId)).toEqual([first]);
    const missing = await run("tabs", { action: "switch", tabId: "t404" });
    expect(missing.isError).toBe(true);
  });

  test("navigate in a new tab makes it active", async () => {
    const result = await run("navigate", { url: `${base}/d`, newTab: true });
    expect(text(result)).toMatch(/navigated in new tab t\d+ to/);
    expect(text(result)).toContain("tabs: 2");
    await run("tabs", { action: "close", tabId: (result.details as ActionOutcome).details.tabId });
  });

  test("an open JS dialog blocks navigation and is shown in the header", async () => {
    const tab = await profile.browser.activeTab();
    const opened = tab.session.waitFor("Page.javascriptDialogOpening");
    await tab.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => alert('hold on'))",
    });
    await opened;
    const result = await run("navigate", { url: `${base}/e` });
    expect(result.isError).toBe(true);
    expect((result.details as ActionOutcome).kind).toBe("blocked-by-dialog");
    expect(text(result)).toContain('dialog: alert "hold on"');
    await tab.session.send("Page.handleJavaScriptDialog", { accept: true });
  });

  test("permission scopes and patterns", () => {
    const navigate = profile.toolset.find((candidate) => candidate.name === "navigate");
    const tabs = profile.toolset.find((candidate) => candidate.name === "tabs");
    expect(navigate?.permissionScope?.({ url: "gmail.com" })).toBe("browser:navigate");
    expect(navigate?.permissionPattern?.({ url: "gmail.com/inbox" })).toBe("gmail.com");
    expect(tabs?.permissionScope?.({ action: "list" })).toBe("browser:observe");
    expect(tabs?.permissionScope?.({ action: "close", tabId: "t1" })).toBe("browser:navigate");
    expect(navigate?.executionMode).toBe("sequential");
  });
});
