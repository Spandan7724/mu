// tools/render.ts is the one place the page and the driver's own words become the
// text the model reads. This exercises the surfaces that had no direct coverage:
// download outcomes (metadata only, SECURITY §11), a page-authored dialog message
// (wrapped as untrusted, SECURITY §5), and defense-in-depth on credential display
// even when a value reaches these functions despite the schema layer that should
// have stripped it first.
import { describe, expect, test } from "bun:test";
import { elementRefId } from "../contracts/primitives.ts";
import { REDACTED } from "../contracts/secret.ts";
import { FAKE_LABELS, FAKE_ORIGIN, FAKE_PAGE_URLS, FAKE_VALUES } from "../drivers/fake/site.ts";
import { sampleElement } from "../testing/samples.ts";
import { browserActTool } from "./act.ts";
import { createHarness, type Harness, resultText } from "./harness.ts";
import { describeElement, screenshotSuppressed } from "./render.ts";

const signal = () => new AbortController().signal;

async function on(harness: Harness, url: string): Promise<void> {
  await harness.runtime.use((driver) => driver.navigate({ kind: "url", url }, signal()), signal());
  await harness.session.observe({}, signal());
}

function refOf(element: { ref: string; revision: number; tabId: string }) {
  return { ref: element.ref, revision: element.revision, tabId: element.tabId };
}

function elementNamed(harness: Harness, name: string) {
  const found = harness.session
    .record()
    ?.observation.elements.find((element) => element.name === name || element.label === name);
  if (found === undefined) throw new Error(`no observed control named ${name}`);
  return found;
}

describe("a download outcome reaches the model as metadata only", () => {
  test("the basename, type and size are stated; nothing else is", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.download);
      const act = browserActTool({ session: harness.session });
      const result = await act.execute(
        "c1",
        { action: "click", target: refOf(elementNamed(harness, FAKE_LABELS.downloadTrigger)) },
        signal(),
      );
      const text = resultText(result);
      expect(text).toContain(FAKE_VALUES.downloadBasename);
      expect(text).toContain("bytes");
      expect(text).toContain("holds the file privately");
      expect(text).toContain("not opened, run, or readable from here");
      // No filesystem path of any shape — POSIX, Windows drive, or UNC — reaches the text.
      expect(text).not.toMatch(/[A-Za-z]:\\/);
      expect(text).not.toMatch(/\\\\[A-Za-z0-9_.-]+\\/);
      expect(text).not.toContain("/tmp");
      expect(text).not.toContain("/home");
      expect(text).not.toContain("artifacts");
    } finally {
      await harness.shutdown();
    }
  });
});

describe("a page-authored dialog message is untrusted evidence", () => {
  test("the dialog's own words are wrapped, not narrated as Mu's own statement", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.dialog);
      const act = browserActTool({ session: harness.session });
      const result = await act.execute(
        "c1",
        { action: "click", target: refOf(elementNamed(harness, FAKE_LABELS.dialogTrigger)) },
        signal(),
      );
      const text = resultText(result);
      expect(text).toContain('<untrusted source="page-text">');
      expect(text).toContain("Your session expires soon.");
      expect(text).toContain("</untrusted>");
    } finally {
      await harness.shutdown();
    }
  });
});

describe("describeElement never displays a credential value (defense in depth)", () => {
  // These elements are hand-built rather than round-tripped through the schema, on
  // purpose: browserElementSchema already refuses a value on a credential-shaped
  // control (BD14), so this proves the display function holds the line on its own
  // rather than only inheriting it from validation upstream.
  test("a password-typed control shows REDACTED even carrying a raw value", () => {
    const element = sampleElement({
      ref: elementRefId("e1"),
      inputType: "password",
      label: "Password",
      value: "hunter2",
    });
    const line = describeElement(element);
    expect(line).not.toContain("hunter2");
    expect(line).toContain(REDACTED);
  });

  test("a control merely risk-flagged as authentication is redacted too", () => {
    const element = sampleElement({
      ref: elementRefId("e2"),
      label: "Recovery code",
      inputType: "text",
      risk: ["authentication"],
      value: "abc123secret",
    });
    const line = describeElement(element);
    expect(line).not.toContain("abc123secret");
    expect(line).toContain(REDACTED);
  });

  test("a credential-shaped label with no declared inputType is still redacted", () => {
    const element = sampleElement({
      ref: elementRefId("e3"),
      label: "One-time passcode",
      value: "999111",
    });
    const line = describeElement(element);
    expect(line).not.toContain("999111");
    expect(line).toContain(REDACTED);
  });

  test("an ordinary field's value is shown", () => {
    const element = sampleElement({
      ref: elementRefId("e4"),
      label: "Full name",
      value: "Ada Lovelace",
    });
    expect(describeElement(element)).toContain("Ada Lovelace");
  });
});

describe("screenshotSuppressed", () => {
  test("a page risk marker alone is enough, with no credential element present", () => {
    const suppressed = screenshotSuppressed({
      connectionId: "c",
      tab: {
        id: "t",
        title: "t",
        url: "https://example.com",
        origin: "https://example.com",
        active: true,
        attached: true,
      },
      revision: 1,
      observedAt: 0,
      title: "t",
      url: "https://example.com",
      origin: "https://example.com",
      viewport: { width: 1, height: 1, scrollX: 0, scrollY: 0 },
      frames: [],
      summary: "s",
      snapshot: "s",
      elements: [],
      risks: ["captcha"],
    });
    expect(suppressed).toBe(true);
  });

  test("an ordinary page with no credential element and no risk is not suppressed", () => {
    const suppressed = screenshotSuppressed({
      connectionId: "c",
      tab: {
        id: "t",
        title: "t",
        url: "https://example.com",
        origin: "https://example.com",
        active: true,
        attached: true,
      },
      revision: 1,
      observedAt: 0,
      title: "t",
      url: "https://example.com",
      origin: "https://example.com",
      viewport: { width: 1, height: 1, scrollX: 0, scrollY: 0 },
      frames: [],
      summary: "s",
      snapshot: "s",
      elements: [sampleElement({ ref: elementRefId("e1"), inputType: "text" })],
      risks: [],
    });
    expect(suppressed).toBe(false);
  });
});
