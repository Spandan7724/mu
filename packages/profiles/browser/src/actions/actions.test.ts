import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@mu/core";
import { type BrowserProfile, browserProfile } from "../index.ts";
import { describeWithBrowser, tempUserDataDir, testBrowserPath } from "../testing/chrome.ts";
import { type FixtureSite, startFixtureSite } from "../testing/fixture-site.ts";
import type { ActionOutcome } from "./types.ts";

setDefaultTimeout(30_000);

interface Run {
  text: string;
  outcome: ActionOutcome;
  result: ToolResult;
}

function refIn(text: string, role: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`- ${role} "${escaped}"[^\\n]*?\\[ref=([a-z0-9]+)\\]`).exec(text);
  if (!match?.[1]) throw new Error(`no ${role} "${name}" in:\n${text}`);
  return match[1];
}

describeWithBrowser("browser actions on the fixture site (real headless Chrome)", () => {
  const home = tempUserDataDir();
  let site: FixtureSite;
  let profile: BrowserProfile;
  let page = "";

  const run = async (name: string, args: Record<string, unknown>): Promise<Run> => {
    const found = profile.toolset.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    const result = (await found.execute("call", args, new AbortController().signal)) as ToolResult;
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    if (result.details && "details" in (result.details as object)) page = text;
    return { text, outcome: result.details as ActionOutcome, result };
  };
  const open = (name: string) => run("navigate", { url: site.url(name) });

  beforeAll(async () => {
    site = startFixtureSite();
    profile = await browserProfile({
      home,
      headless: true,
      keepOpen: false,
      vision: "off",
      downloadsDir: join(home, "downloads"),
      workspace: home,
      ...(testBrowserPath ? { executable: testBrowserPath } : {}),
    });
  });

  afterAll(async () => {
    await profile.browser.shutdown({ close: true });
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("click submits a form and reports the navigation; outcome carries timings and retention", async () => {
    await open("form-basic");
    await run("type", { ref: refIn(page, "textbox", "Full name"), text: "Ada Lovelace" });
    const click = await run("click", { ref: refIn(page, "button", "Send message") });
    expect(click.text).toStartWith('clicked button "Send message" [e14] → navigated');
    expect(click.outcome.kind).toBe("navigated");
    expect(click.outcome.details.timings.settleMs).toBeGreaterThanOrEqual(0);
    expect(click.outcome.details.path).toBe("mouse");
    expect(click.text).toContain("[page] Submitted");
    expect(click.text).toContain("cell: Ada Lovelace");
    expect(click.result.retention?.summary).toStartWith('clicked button "Send message" [e14]');
  });

  test("fill_form sets text, checkbox, radio and select in one call, then submits", async () => {
    await open("form-basic");
    const filled = await run("fill_form", {
      fields: [
        { ref: refIn(page, "textbox", "Full name"), value: "Grace Hopper" },
        { ref: refIn(page, "textbox", "Email"), value: "grace@example.com" },
        { ref: refIn(page, "checkbox", "Subscribe to newsletter"), value: false },
        { ref: refIn(page, "radio", "Pro"), value: true },
        { ref: refIn(page, "combobox", "Country"), value: "France" },
      ],
      submitRef: refIn(page, "button", "Send message"),
    });
    expect(filled.text).toStartWith("filled 5 fields");
    expect(filled.text).toContain("[page] Submitted");
    expect(filled.text).toContain("cell: grace@example.com");
    expect(filled.text).toContain("cell: pro");
    expect(filled.text).toContain("cell: fr");
    expect(filled.text).not.toContain("columnheader: newsletter");
  });

  test("a click that saves the form waits for the save and the next step, not a fixed cap", async () => {
    await open("wizard-save");
    const next = await run("click", { ref: refIn(page, "button", "Next") });
    expect(next.text).toContain('heading "Step 2: My experience"');
    expect(next.text).not.toContain("loading");
    expect(next.outcome.details.settle).toStartWith("page changed, then settled");
  });

  test("fill_form sets radio groups by label within the group, keeps going past failures, and takes exact suggestions", async () => {
    await open("questions");
    const before = /group "Have you worked here before\?" \[ref=(e\d+)\]/.exec(page)?.[1] as string;
    const visa = /radiogroup "Do you need visa sponsorship\?" \[ref=(e\d+)\]/.exec(
      page,
    )?.[1] as string;
    const country = refIn(page, "combobox", "Country");
    const notes = refIn(page, "textbox", "Notes");
    const partial = await run("fill_form", {
      fields: [
        { ref: notes, value: "hello" },
        { ref: country, value: "France" },
      ],
      submitRef: refIn(page, "button", "Save answers"),
    });
    expect(partial.result.isError).toBe(true);
    expect(partial.text).toStartWith('filled 1 of 2 fields (combobox "Country" [e');
    expect(partial.text).toContain("1 failed, so nothing was submitted");
    expect(partial.text).toContain('failed: textbox "Notes"');
    expect(partial.text).not.toContain("Sent:");

    const whole = await run("fill_form", {
      fields: [
        { ref: before, value: "No" },
        { ref: visa, value: "Yes" },
        { ref: country, value: "India" },
      ],
      submitRef: refIn(page, "button", "Save answers"),
    });
    expect(whole.result.isError).toBeUndefined();
    expect(whole.text).toContain("Sent: before=no&visa=yes&country=India");

    await open("combobox");
    const city = await run("fill_form", {
      fields: [{ ref: refIn(page, "combobox", "City"), value: "Bost" }],
    });
    expect(city.text).toContain('picked suggestion "Boston"');
    expect(city.text).toContain("Chosen: Boston");
  });

  test("native selects styled invisible behind a custom face are still usable", async () => {
    await open("styled-select");
    expect(page).toMatch(/combobox "Size" \[ref=e\d+\]/);
    expect(page).toMatch(/combobox "Colour" \[ref=e\d+\]/);
    const filled = await run("fill_form", {
      fields: [
        { ref: refIn(page, "combobox", "Size"), value: "Large" },
        { ref: refIn(page, "combobox", "Colour"), value: "Blue" },
      ],
    });
    expect(filled.result.isError).toBeUndefined();
    expect(filled.text).toContain("Colour: Blue");
    expect(filled.text).toMatch(/Large/);
  });

  test("fill_form drives date pickers: month lists with a year dropdown, year grids, day calendars, native inputs", async () => {
    await open("datepickers");
    const filled = await run("fill_form", {
      fields: [
        { ref: refIn(page, "textbox", "Start"), value: "Sep 2025" },
        { ref: refIn(page, "textbox", "Graduation year"), value: "2031" },
        { ref: refIn(page, "textbox", "Date of birth"), value: "2025-12-05" },
        { ref: refIn(page, "date", "Delivery date"), value: "2026-11-03" },
        { ref: refIn(page, "datetime", "Card expiry"), value: "April 2027" },
      ],
    });
    expect(filled.result.isError).toBeUndefined();
    expect(filled.text).toContain(
      "start=09/2025 grad=2031 dob=2025-12-05 delivery=2026-11-03 expiry=2027-04",
    );
  });

  test("a hover menu left open by the pointer does not block a click elsewhere", async () => {
    await open("hover-menu");
    await run("hover", { ref: refIn(page, "button", "Browse jobs") });
    expect(page).toContain('link "All jobs"');
    const clicked = await run("click", { ref: refIn(page, "button", "Save date") });
    expect(clicked.result.isError).toBeUndefined();
    expect(clicked.text).toContain("Pressed");
  });

  test("occluded clicks report the covering element and what it contains", async () => {
    await open("modal");
    const blocked = await run("click", { ref: refIn(page, "button", "Hidden behind banner") });
    expect(blocked.result.isError).toBe(true);
    expect(blocked.outcome.kind).toBe("occluded");
    expect(blocked.text).toMatch(
      /covered by region "Cookie consent" \[e\d+\] \(it contains: button "Accept all" \[e\d+\], button "Reject" \[e\d+\]\)/,
    );
    expect(blocked.outcome.occludedBy?.name).toBe("Cookie consent");
    await run("click", { ref: refIn(page, "button", "Accept all") });
    const clicked = await run("click", { ref: refIn(page, "button", "Hidden behind banner") });
    expect(clicked.result.isError).toBeUndefined();
  });

  test("typing verifies values: masks and reformatting are reported; validation errors appear marked", async () => {
    await open("form-validation");
    const bad = await run("type", { ref: refIn(page, "textbox", "Email"), text: "not-an-email" });
    expect(bad.text).toMatch(/\*- alert "Please enter a valid email address"/);
    expect(bad.text).toContain("[invalid]");
    const phone = await run("type", { ref: refIn(page, "textbox", "Phone"), text: "5551234567" });
    expect(phone.outcome.kind).toBe("value-mismatch");
    expect(phone.text).toContain('the field now shows "(555) 123-4567"');
    await run("type", { ref: refIn(page, "textbox", "Email"), text: "ok@example.com" });
    expect(page).toMatch(/button "Create account" \[ref=e\d+\] \[disabled\]/);
    await run("click", { ref: refIn(page, "checkbox", "I accept the terms") });
    expect(page).not.toMatch(/button "Create account" \[ref=e\d+\] \[disabled\]/);
  });

  test("rich editor: multi-line text lands as lines", async () => {
    await open("rich-editor");
    const typed = await run("type", {
      ref: refIn(page, "textbox", "Message Body"),
      text: "Hi Alex,\nRunning late.\nSee you soon",
    });
    expect(typed.outcome.kind).toBeUndefined();
    expect(typed.text).toContain("Lines: 3");
    expect(typed.text).toMatch(
      /textbox "Message Body" \[ref=e\d+\][^\n]*\(rich\): Hi Alex,⏎Running late\.⏎See you soon/,
    );
  });

  test("combobox: typing reports new suggestions; keyboard and select choose one", async () => {
    await open("combobox");
    const typed = await run("type", { ref: refIn(page, "combobox", "City"), text: "Bo" });
    expect(typed.text).toContain("suggestions appeared");
    expect(typed.text).toMatch(/\*- option "Boston" \[ref=e\d+\]/);
    await run("press", { keys: "ArrowDown" });
    const chosen = await run("press", { keys: "Enter" });
    expect(chosen.text).toContain("Chosen: Boston");
    const selected = await run("select", {
      ref: refIn(page, "combobox", "City"),
      options: ["Paris"],
    });
    expect(selected.text).toContain('selected "Paris"');
    expect(selected.text).toContain("Chosen: Paris");
  });

  test("select: native and custom div dropdowns", async () => {
    await open("form-basic");
    const native = await run("select", {
      ref: refIn(page, "combobox", "Country"),
      options: ["india"],
    });
    expect(native.text).toContain('selected "India"');
    expect(native.text).toMatch(/combobox "Country" \[ref=e\d+\][^\n]*: India/);
    const missing = await run("select", {
      ref: refIn(page, "combobox", "Country"),
      options: ["Mars"],
    });
    expect(missing.result.isError).toBe(true);
    expect(missing.text).toContain('options: "Choose…", "Germany"');
    await open("custom-select");
    const custom = await run("select", {
      ref: refIn(page, "clickable", "Select size ▾"),
      options: ["Medium"],
    });
    expect(custom.text).toContain('selected "Medium"');
    expect(custom.text).toContain("status: M");
  });

  test("clicking a native select redirects to select with its options", async () => {
    await open("form-basic");
    const clicked = await run("click", { ref: refIn(page, "combobox", "Country") });
    expect(clicked.outcome.kind).toBe("not-interactable");
    expect(clicked.text).toContain("use the select tool");
  });

  test("new tabs from links and window.open become active and are reported", async () => {
    await open("tabs-popups");
    const link = await run("click", { ref: refIn(page, "link", "Open contact form in new tab") });
    expect(link.outcome.kind).toBe("new-tab");
    expect(link.text).toMatch(/→ opened new tab t\d+ \(.*form-basic\); it is now the active tab/);
    expect(link.text).toContain("[page] Contact form");
    await run("tabs", { action: "close", tabId: link.outcome.details.tabId });
    await open("tabs-popups");
    const popup = await run("click", { ref: refIn(page, "button", "Open articles popup") });
    expect(popup.outcome.kind).toBe("new-tab");
    expect(popup.text).toContain("[page] Long list");
    await run("tabs", { action: "close", tabId: popup.outcome.details.tabId });
  });

  test("JS dialogs show in the header, block other actions, and are answered", async () => {
    await open("dialogs");
    const confirmRef = refIn(page, "button", "Discard draft");
    const opened = await run("click", { ref: confirmRef });
    expect(opened.text).toContain("→ a JavaScript dialog opened");
    expect(opened.text).toContain('dialog: confirm "Discard draft?"');
    const blocked = await run("click", { ref: confirmRef });
    expect(blocked.outcome.kind).toBe("blocked-by-dialog");
    const accepted = await run("dialog", { action: "accept" });
    expect(accepted.text).toStartWith('accepted the confirm "Discard draft?"');
    expect(accepted.text).toContain("paragraph: discarded");
    await run("click", { ref: refIn(page, "button", "Ask name") });
    const prompted = await run("dialog", { action: "accept", text: "Ada" });
    expect(prompted.text).toContain("paragraph: Hello Ada");
  });

  test("uploads via file input and file chooser; downloads land in the session directory", async () => {
    const file = join(home, "cv.txt");
    writeFileSync(file, "resume");
    await open("upload-download");
    const direct = await run("upload", { ref: refIn(page, "button", "Resume"), paths: [file] });
    expect(direct.text).toStartWith("attached cv.txt (plain text, 1 KB)");
    expect(direct.text).toContain("resume: cv.txt");
    const chooser = await run("upload", {
      ref: refIn(page, "button", "Upload photo…"),
      paths: [file],
    });
    expect(chooser.text).toStartWith("chose cv.txt (plain text, 1 KB) in the file chooser");
    expect(chooser.text).toContain("photo: cv.txt");
    const markdown = join(home, "cv.md");
    writeFileSync(markdown, "# resume");
    const rejected = await run("upload", {
      ref: refIn(page, "button", "Resume"),
      paths: [markdown],
    });
    expect(rejected.result.isError).toBeUndefined();
    expect(rejected.text).toContain('dialog: alert "Please choose a file type from pdf or txt."');
    expect(rejected.outcome.details.timings.totalMs).toBeLessThan(5_000);
    await run("dialog", { action: "accept" });
    const cvField = refIn(page, "button", "CV (PDF or Word)");
    const refusedMd = await run("upload", { ref: cvField, paths: [markdown] });
    expect(refusedMd.result.isError).toBe(true);
    expect(refusedMd.text).toStartWith(
      "did not upload cv.md: the field accepts .pdf, .docx; this is Markdown text (.md)",
    );
    writeFileSync(join(home, "cv.pdf"), "%PDF-1.4\n");
    const relative = await run("upload", { ref: cvField, paths: ["cv.pdf"] });
    expect(relative.text).toStartWith("attached cv.pdf (PDF, 1 KB)");
    const elsewhere = tempUserDataDir();
    writeFileSync(join(elsewhere, "taxes.pdf"), "%PDF-1.4\n");
    const outside = await run("upload", { ref: cvField, paths: [join(elsewhere, "taxes.pdf")] });
    expect(outside.text).toContain("only files in");
    rmSync(elsewhere, { recursive: true, force: true });
    const missing = await run("upload", {
      ref: refIn(page, "button", "Resume"),
      paths: ["/nope.txt"],
    });
    expect(missing.result.isError).toBe(true);
    const download = await run("click", { ref: refIn(page, "link", "Download report") });
    expect(download.text).toMatch(/→ download completed: report\.csv → .*report\.csv/);
    const listed = await run("downloads", {});
    const record = profile.browser.downloads.list()[0];
    expect(listed.text).toContain("report.csv — completed");
    expect(record && existsSync(record.path) && readFileSync(record.path, "utf8")).toContain(
      "alpha,1",
    );
    expect(record?.path.startsWith(join(home, "downloads"))).toBe(true);
  });

  test("hover opens hover menus; drag moves an item onto a drop zone", async () => {
    await open("hover-drag");
    const hovered = await run("hover", { ref: refIn(page, "button", "Account ▾") });
    expect(hovered.text).toMatch(/\*- link "Profile" \[ref=e\d+\]/);
    expect(hovered.text).not.toContain("no visible change");
    const dragged = await run("drag", {
      from: refIn(page, "listitem", "Alpha"),
      to: refIn(page, "region", "Done column"),
    });
    expect(dragged.text).toContain("Done: Alpha");
  });

  test("scroll reports position, growth on infinite lists, and the end", async () => {
    await open("infinite");
    const first = await run("scroll", { direction: "down", amount: "page" });
    expect(first.text).toMatch(/^scrolled down \d+ px \(now \d+\/\d+ px\)/);
    const bottom = await run("scroll", { to: "bottom" });
    expect(bottom.text).toMatch(/content grew by \d+ px \(more loaded\)/);
    for (let i = 0; i < 8; i++) await run("scroll", { to: "bottom" });
    const end = await run("scroll", { direction: "down" });
    expect(end.text).toContain("No more posts");
    expect(end.text).toMatch(/already at the end|reached the end/);
  });

  test("settle: no-change actions return fast; SPA content is observed after its delayed render", async () => {
    await open("custom-select");
    const idle = await run("click", { ref: refIn(page, "clickable", "Settings") });
    expect(idle.text).toContain("(no visible change)");
    expect(idle.outcome.kind).toBe("no-change");
    const settleMs = Number(/\((\d+) ms\)$/.exec(idle.outcome.details.settle ?? "")?.[1]);
    expect(settleMs).toBeLessThan(450);
    await open("spa-nav");
    const reports = await run("click", { ref: refIn(page, "link", "Reports") });
    expect(reports.text).toContain("listitem: Q1 revenue: $1.2M");
    expect(reports.text).not.toContain("progressbar");
  });

  test("wait for text, evaluate, click_xy, and date inputs", async () => {
    await open("spa-nav");
    await run("navigate", { url: `${site.url("spa-nav")}#/reports` });
    const waited = await run("wait", { text: "Q2 revenue" });
    expect(waited.text).toMatch(/^waited \d+ ms for "Q2 revenue" to appear/);
    const timeout = await run("wait", { text: "never shows", seconds: 0.3 });
    expect(timeout.outcome.kind).toBe("timeout");
    const already = await run("wait", { text: "Q2 revenue", seconds: 0.3 });
    expect(already.text).toMatch(/^"Q2 revenue" was already on the page/);
    const cased = await run("wait", { text: "q2 REVENUE", seconds: 0.3 });
    expect(cased.outcome.kind).toBe("timeout");
    expect(cased.text).toContain("only in different capitalization");
    const evaluated = await run("evaluate", { function: "() => document.title" });
    expect(evaluated.text).toContain('result (untrusted page data): "Dashboard"');
    const thrown = await run("evaluate", { function: "() => { throw new Error('boom') }" });
    expect(thrown.text).toContain("script threw: Error: boom");
    await open("dialogs");
    const tab = await profile.browser.activeTab();
    const box = await tab.session.send("Runtime.evaluate", {
      expression:
        "(() => { const r = document.querySelectorAll('button')[0].getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()",
      returnByValue: true,
    });
    const [x, y] = box.result.value as [number, number];
    const xy = await run("click_xy", { x, y });
    expect(xy.text).toMatch(/^clicked at \(\d+, \d+\) on button "Show alert" \[e\d+\]/);
    await run("dialog", { action: "dismiss" });
    await open("datepicker");
    const date = await run("type", {
      ref: refIn(page, "date", "Check-in"),
      text: "October 5, 2026",
    });
    expect(date.text).toMatch(/date "Check-in" \[ref=e\d+\][^\n]*: 2026-10-05/);
    await run("click", { ref: refIn(page, "button", "Pick a date") });
    await run("click", { ref: refIn(page, "button", "Next month") });
    const picked = await run("click", { ref: refIn(page, "gridcell", "November 12, 2026") });
    expect(picked.text).toContain("Check-out: November 12, 2026");
  });

  test("frames and shadow DOM: typing and clicking inside an OOPIF and a shadow root", async () => {
    await open("iframes");
    await run("wait", { seconds: 0.5 });
    const snapshot = await run("snapshot", {});
    const crossEmail =
      /iframe "Cross origin form"\n\s+- heading[^\n]*\n\s+- textbox "Email" \[ref=(f\de\d+)\]/.exec(
        snapshot.text,
      )?.[1];
    const crossButton =
      /iframe "Cross origin form"[\s\S]*?button "Subscribe" \[ref=(f\de\d+)\]/.exec(
        snapshot.text,
      )?.[1];
    expect(crossEmail).toBeDefined();
    await run("type", { ref: crossEmail, text: "x@y.io" });
    const subscribed = await run("click", { ref: crossButton });
    expect(subscribed.text).toContain('heading "Subscribed x@y.io"');
    await open("shadow");
    await run("type", { ref: refIn(page, "searchbox", "Search docs"), text: "refs" });
    const go = await run("click", { ref: refIn(page, "button", "Go") });
    expect(go.text).toContain("Results for refs");
  });

  test("stale refs are reported with the fresh page, never clicking something else", async () => {
    await open("form-basic");
    const old = refIn(page, "button", "Send message");
    await open("custom-select");
    const stale = await run("click", { ref: old });
    expect(stale.outcome.kind).toBe("stale-ref");
    expect(stale.text).toContain("use a ref from the page state below");
    expect(stale.text).toContain("[page] Custom select");
  });
});
