// The stale-reference proof, taken from the running loopback fixture rather than from a
// transcription of it. `/stale` rerenders its action row so that the element that was
// "Submit application" becomes a "Delete draft" button holding the *same DOM id at the
// same position*, while the real submit moves elsewhere under a new label. The page the
// tools see below is built by reading that markup out of the live fixture, so if the
// fixture's trap changes shape this test changes with it.
//
// The fixture is loaded through a computed specifier because `@mu/browser-fixture` is
// deliberately not a dependency of this package: nothing shipped may reach it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BrowserElementRef } from "../contracts/observation.ts";
import { FAKE_ORIGIN, type FakeElementSpec, type FakePageSpec } from "../drivers/fake/site.ts";
import { browserActTool } from "./act.ts";
import { createHarness, resultText } from "./harness.ts";
import { browserObserveTool } from "./observe.ts";

const FIXTURE_INDEX = new URL("../../../../browser-fixture/src/index.ts", import.meta.url).href;

interface FixtureHandle {
  url: string;
  recorder: { count(path?: string): number };
  stop(): Promise<void>;
}

const STALE_URL = `${FAKE_ORIGIN}/stale`;

let fixture: FixtureHandle;
let markup: string;

beforeAll(async () => {
  const module = (await import(FIXTURE_INDEX)) as {
    startFixture: (options: { staleRerenderMs: number }) => Promise<FixtureHandle>;
  };
  fixture = await module.startFixture({ staleRerenderMs: 30 });
  markup = await (await fetch(`${fixture.url}/stale`)).text();
});

afterAll(async () => {
  await fixture.stop();
});

/** `<button ... id="x" ...>Label</button>` → the control a semantic driver would report. */
function buttonsIn(html: string): FakeElementSpec[] {
  const specs: FakeElementSpec[] = [];
  const pattern = /<button\b([^>]*)>([^<]*)<\/button>/g;
  for (const match of html.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    const label = (match[2] ?? "").trim();
    const id = /\bid="([^"]+)"/.exec(attributes)?.[1];
    const type = /\btype="([^"]+)"/.exec(attributes)?.[1];
    if (id === undefined) continue;
    specs.push({
      ref: id,
      role: "button",
      name: label,
      label,
      // Exactly what the DOM says and nothing more: the fake driver is given no risk
      // marker here, so the only thing standing between a stale reference and the
      // delete twin is this package's own reference discipline.
      ...(type === undefined ? {} : { inputType: type }),
    });
  }
  return specs;
}

function actionRow(html: string): string {
  return /<div id="action-row">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
}

/** The row the fixture's own script installs after the rerender. */
function rerenderedRow(html: string): string {
  const script = /row\.innerHTML\s*=\s*([\s\S]*?);\n/.exec(html)?.[1] ?? "";
  return script.replace(/'\s*\+\s*'/g, "").replace(/'/g, "");
}

function pageWith(buttons: FakeElementSpec[]): FakePageSpec {
  return {
    url: STALE_URL,
    title: "Rerendering submit button",
    summary: "This page rerenders on its own.",
    elements: [
      { ref: "candidate_note", role: "textbox", name: "Note", label: "Note", inputType: "text" },
      ...buttons,
    ],
  };
}

describe("the fixture's rerendered submit button", () => {
  test("still sets the trap this lane is built to survive", () => {
    const before = buttonsIn(actionRow(markup));
    const after = buttonsIn(rerenderedRow(markup));

    const primaryBefore = before.find((button) => button.ref === "primary-action");
    const primaryAfter = after.find((button) => button.ref === "primary-action");

    expect(primaryBefore?.name).toBe("Submit application");
    expect(primaryAfter?.name).toBe("Delete draft");
    // Same id, same first position — the two properties a naive resolver would use.
    expect(before[0]?.ref).toBe("primary-action");
    expect(after[0]?.ref).toBe("primary-action");
    expect(markup).toContain('formaction="/stale/delete"');
    // The real submit survives only under a new identity.
    expect(after.some((button) => button.ref === "moved-submit")).toBe(true);
  });

  test("a reference taken before the rerender is rejected, not retargeted", async () => {
    const before = buttonsIn(actionRow(markup));
    const after = buttonsIn(rerenderedRow(markup));
    const pages = new Map<string, FakePageSpec>([[STALE_URL, pageWith(before)]]);
    const harness = createHarness({
      site: { origin: FAKE_ORIGIN, landingUrl: STALE_URL, pages },
      allowedOrigins: [FAKE_ORIGIN],
    });
    try {
      const observe = browserObserveTool({ session: harness.session });
      const act = browserActTool({ session: harness.session });

      const observed = await observe.execute("call-1", {}, harness.signal);
      const text = resultText(observed);
      expect(text).toContain("Submit application");

      const record = harness.session.record();
      const submitRef = record?.observation.elements.find(
        (element) => element.name === "Submit application",
      );
      expect(submitRef).toBeDefined();
      const target: BrowserElementRef = {
        ref: (submitRef as { ref: string }).ref as BrowserElementRef["ref"],
        revision: (submitRef as { revision: number }).revision,
        tabId: (submitRef as { tabId: string }).tabId,
      };

      // The page rerenders exactly as the fixture's timer makes it rerender.
      pages.set(STALE_URL, pageWith(after));

      const result = await act.execute("call-2", { action: "click", target }, harness.signal);
      const message = resultText(result);

      expect(result.isError).toBe(true);
      expect(message).toContain("observe");
      // The delete twin is never named as the thing that was acted on.
      expect(message).not.toContain("Clicked");
      expect(message).not.toContain("Delete draft");

      // Nothing reached the fixture at all, and in particular not the endpoint that
      // exists only to record this mistake.
      expect(fixture.recorder.count("/stale/delete")).toBe(0);
      expect(fixture.recorder.count("/stale/submit")).toBe(0);

      // Re-observing produces a new revision, and the delete twin carries a reference
      // that is not the one the submit button had.
      const reobserved = await observe.execute("call-3", {}, harness.signal);
      const fresh = harness.session.record();
      expect(fresh?.revision).not.toBe(target.revision);
      const twin = fresh?.observation.elements.find((element) => element.name === "Delete draft");
      expect(twin).toBeDefined();
      expect(twin?.ref).not.toBe(target.ref);
      expect(resultText(reobserved)).toContain("Delete draft");
    } finally {
      await harness.shutdown();
    }
  });

  test("the delete twin cannot be clicked through browser_act even with a fresh reference", async () => {
    const after = buttonsIn(rerenderedRow(markup));
    const pages = new Map<string, FakePageSpec>([[STALE_URL, pageWith(after)]]);
    const harness = createHarness({
      site: { origin: FAKE_ORIGIN, landingUrl: STALE_URL, pages },
      allowedOrigins: [FAKE_ORIGIN],
    });
    try {
      const observe = browserObserveTool({ session: harness.session });
      const act = browserActTool({ session: harness.session });
      await observe.execute("call-1", {}, harness.signal);
      const twin = harness.session
        .record()
        ?.observation.elements.find((element) => element.name === "Delete draft");
      expect(twin).toBeDefined();
      const found = twin as NonNullable<typeof twin>;
      const result = await act.execute(
        "call-2",
        {
          action: "click",
          target: { ref: found.ref, revision: found.revision, tabId: found.tabId },
        },
        harness.signal,
      );
      const message = resultText(result);
      expect(result.isError).toBe(true);
      expect(message).toContain("browser_submit");
      expect(fixture.recorder.count("/stale/delete")).toBe(0);
    } finally {
      await harness.shutdown();
    }
  });
});
