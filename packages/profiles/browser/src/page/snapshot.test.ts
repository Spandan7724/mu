import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { navigateTo } from "../actions/navigate.ts";
import { BrowserManager } from "../browser/manager.ts";
import type { Tab } from "../browser/tabs.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { FIXTURE_DIR, type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";
import { until } from "../testing/wait.ts";
import type { PageModel, PageNode } from "./model.ts";
import { mergeSeen, renderSnapshot } from "./render.ts";
import { resolveRef, StaleRefError } from "./resolve.ts";
import { capturePage } from "./snapshot.ts";

const GOLDEN_DIR = join(FIXTURE_DIR, "..", "golden");

function find(node: PageNode, predicate: (node: PageNode) => boolean): PageNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return undefined;
}

describeWithBrowser("page snapshots in real headless Chrome", () => {
  const userDataDir = tempUserDataDir();
  let site: FixtureSite;
  let manager: BrowserManager;
  let tab: Tab;

  const normalize = (text: string) =>
    text.replaceAll(site.origin, "{{ORIGIN}}").replaceAll(site.crossOrigin, "{{CROSS_ORIGIN}}");

  async function load(page: string, frames = 1): Promise<void> {
    await navigateTo(tab, site.url(page));
    await until(
      async () => {
        const list = tab.frames.list();
        if (list.length < frames || list.some((frame) => !frame.url)) return false;
        const states = await Promise.all(
          list.map((frame) =>
            frame.session
              .send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true })
              .then((result) => result.result.value)
              .catch(() => "gone"),
          ),
        );
        return states.every((state) => state === "complete");
      },
      5_000,
      `${page} loaded`,
    );
  }

  async function snapshot(): Promise<{ model: PageModel; text: string }> {
    const model = await capturePage(tab);
    const previous = tab.previous?.documentId === model.documentId ? tab.previous : undefined;
    const rendered = renderSnapshot(model, { previous });
    tab.previous = { documentId: model.documentId, ...mergeSeen(previous, rendered) };
    return { model, text: rendered.text };
  }

  function golden(page: string, text: string): void {
    const file = join(GOLDEN_DIR, `${page}.txt`);
    const actual = `${normalize(text)}\n`;
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(file, actual);
      if (process.env.UPDATE_GOLDEN !== "1")
        throw new Error(`wrote missing golden ${file}; re-run`);
      return;
    }
    expect(actual).toBe(readFileSync(file, "utf8"));
  }

  beforeAll(async () => {
    site = startFixtureSite();
    manager = new BrowserManager({
      connect: "managed",
      profileName: "test",
      userDataDir,
      executable: testBrowserPath,
      headless: true,
      viewport: { width: 1280, height: 800 },
      keepOpen: false,
    });
    tab = await manager.activeTab();
  });

  afterAll(async () => {
    await manager.shutdown({ close: true });
    site.stop();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test("form-basic: labels, states, select options, masked password", async () => {
    await load("form-basic");
    const { text } = await snapshot();
    golden("form-basic", text);
    expect(text).not.toContain("hunter2");
  });

  test("custom-select: cursor-only controls get refs and usable names", async () => {
    await load("custom-select");
    const first = await snapshot();
    golden("custom-select", first.text);
    await tab.session.send("Runtime.evaluate", {
      expression: "document.getElementById('size').click()",
    });
    const opened = await snapshot();
    expect(opened.text).toMatch(/\*- clickable "Small" \[ref=e\d+\]/);
    expect(opened.text).toMatch(/\*- clickable "Large" \[ref=e\d+\]/);
    expect(opened.text).toMatch(/\n- clickable "Select size ▾" \[ref=e1\]/);
  });

  test("modal: banner region renders; an open aria-modal dialog renders first", async () => {
    await load("modal");
    golden("modal", (await snapshot()).text);
    await tab.session.send("Runtime.evaluate", {
      expression: "document.getElementById('open').click()",
    });
    const { text, model } = await snapshot();
    golden("modal-open", text);
    expect(model.modal?.ref).toBeDefined();
  });

  test("iframes: same-origin and cross-origin (OOPIF) frames are captured with frame refs", async () => {
    await load("iframes", 3);
    const { text, model } = await snapshot();
    golden("iframes", text);
    expect(model.frames).toBe(3);
    const cross = find(
      model.root,
      (node) =>
        node.name === "Subscribe" &&
        node.frameId !== tab.frames.mainFrameId &&
        tab.frames.get(node.frameId)?.session !== tab.session,
    );
    expect(cross?.ref).toMatch(/^f\de\d+$/);
    const resolved = await resolveRef(tab, cross?.ref as string);
    expect(resolved.session).not.toBe(tab.session);
  });

  test("shadow: open shadow-DOM controls are captured", async () => {
    await load("shadow");
    const { text } = await snapshot();
    golden("shadow", text);
    expect(text).toMatch(/searchbox "Search docs" \[ref=e\d+\]/);
    expect(text).toMatch(/button "Follow" \[ref=e\d+\]/);
  });

  test("long pages render the viewport and summarize the rest; refs survive scrolling", async () => {
    await load("long");
    const top = await snapshot();
    golden("long", top.text);
    expect(top.model.offscreen.below).toBeGreaterThan(40);
    const article1 = find(top.model.root, (node) => node.name === "Article 1")?.ref;
    await tab.session.send("Runtime.evaluate", {
      expression: "window.scrollTo(0, document.body.scrollHeight)",
    });
    const bottom = await snapshot();
    expect(bottom.text).toContain('"Article 80"');
    expect(bottom.text).not.toContain('"Article 1"');
    expect(bottom.model.offscreen.above).toBeGreaterThan(40);
    await tab.session.send("Runtime.evaluate", { expression: "window.scrollTo(0, 0)" });
    const again = await snapshot();
    expect(find(again.model.root, (node) => node.name === "Article 1")?.ref).toBe(
      article1 as string,
    );
    expect(again.text).not.toContain("*-");
  });

  test("refs are stable across re-observation and never resolve to a different element", async () => {
    await load("form-basic");
    const first = await snapshot();
    const second = await snapshot();
    expect(second.text).toBe(first.text);
    const send = find(first.model.root, (node) => node.name === "Send message")?.ref as string;
    expect((await resolveRef(tab, send)).backendNodeId).toBeGreaterThan(0);
    await tab.session.send("Runtime.evaluate", {
      expression: "document.querySelector('button[type=submit]').remove()",
    });
    await expect(resolveRef(tab, send)).rejects.toBeInstanceOf(StaleRefError);
    await load("custom-select");
    const next = await snapshot();
    expect(next.model.newDocument).toBe(true);
    await expect(resolveRef(tab, "e13")).rejects.toBeInstanceOf(StaleRefError);
    expect(next.text).toContain("[ref=e1]");
  });
});
