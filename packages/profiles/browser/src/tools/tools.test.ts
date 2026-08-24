import { describe, expect, test } from "bun:test";
import type { BrowserElement } from "../contracts/observation.ts";
import { REDACTED } from "../contracts/secret.ts";
import {
  FAKE_LABELS,
  FAKE_ORIGIN,
  FAKE_PAGE_URLS,
  FAKE_VALUES,
  type FakeElementSpec,
  type FakePageSpec,
} from "../drivers/fake/site.ts";
import { browserActTool } from "./act.ts";
import { createHarness, type Harness, resultText } from "./harness.ts";
import { browserNavigateTool } from "./navigate.ts";
import { browserObserveTool } from "./observe.ts";
import { browserTabsTool } from "./tabs.ts";
import { browserTakeoverTool } from "./takeover.ts";
import { browserWaitTool } from "./wait.ts";

const signal = () => new AbortController().signal;

async function on(harness: Harness, url: string): Promise<void> {
  await harness.runtime.use((driver) => driver.navigate({ kind: "url", url }, signal()), signal());
  await harness.session.observe({}, signal());
}

function elementNamed(harness: Harness, name: string): BrowserElement {
  const found = harness.session
    .record()
    ?.observation.elements.find((element) => element.name === name || element.label === name);
  if (found === undefined) throw new Error(`no observed control named ${name}`);
  return found;
}

function refOf(element: BrowserElement) {
  return { ref: element.ref, revision: element.revision, tabId: element.tabId };
}

describe("browser_observe", () => {
  test("it reports the page as untrusted evidence, with facts Mu states itself", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const observe = browserObserveTool({ session: harness.session });
      const text = resultText(await observe.execute("c1", {}, signal()));
      expect(text).toContain('Observed "Application form"');
      expect(text).toContain("7 controls");
      expect(text).toContain(`<untrusted source="page-text" origin="${FAKE_ORIGIN}">`);
      expect(text).toContain("</untrusted>");
      expect(text).toContain(FAKE_LABELS.textField);
      // The revision is stated so the model can tell when its references died.
      expect(text).toMatch(/revision \d+/);
    } finally {
      await harness.shutdown();
    }
  });

  test("focus reorders what is shown and is never treated as a selector", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const observe = browserObserveTool({ session: harness.session });
      const text = resultText(await observe.execute("c1", { focus: "Country" }, signal()));
      const country = text.indexOf(FAKE_LABELS.select);
      const name = text.indexOf(FAKE_LABELS.textField);
      expect(country).toBeGreaterThanOrEqual(0);
      expect(country).toBeLessThan(name);
    } finally {
      await harness.shutdown();
    }
  });

  test("a credential page is redacted and never captured", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.credentials);
      const observe = browserObserveTool({ session: harness.session });
      const result = await observe.execute("c1", { screenshot: "viewport" }, signal());
      const text = resultText(result);
      expect(text).not.toContain(FAKE_VALUES.secretMarker);
      expect(text).toContain(REDACTED);
      expect(text).toContain("credential-entry control");
      expect(result.content.some((block) => block.type === "image")).toBe(false);
    } finally {
      await harness.shutdown();
    }
  });

  test("a screenshot on an ordinary page is attached and marked evictable", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const observe = browserObserveTool({ session: harness.session });
      const result = await observe.execute("c1", { screenshot: "viewport" }, signal());
      const image = result.content.find((block) => block.type === "image");
      expect(image).toBeDefined();
      expect((image as { evictable?: boolean }).evictable).toBe(true);
    } finally {
      await harness.shutdown();
    }
  });

  test("a page larger than the budget is cut between controls and says so", async () => {
    const many: FakeElementSpec[] = Array.from({ length: 400 }, (_, index) => ({
      ref: `e${index}`,
      role: "textbox",
      name: `Field ${index}`,
      label: `Field ${index}`,
      inputType: "text",
    }));
    const url = `${FAKE_ORIGIN}/huge`;
    const page: FakePageSpec = { url, title: "Huge", summary: "Many controls.", elements: many };
    const harness = createHarness({
      site: { origin: FAKE_ORIGIN, landingUrl: url, pages: new Map([[url, page]]) },
      allowedOrigins: [FAKE_ORIGIN],
    });
    try {
      const observe = browserObserveTool({ session: harness.session });
      const text = resultText(await observe.execute("c1", {}, signal()));
      expect(text).toContain("further control(s) not shown");
      // Never a half-written control: every rendered line is complete.
      for (const line of text.split("\n").filter((entry) => entry.startsWith("[r"))) {
        expect(line).toMatch(/^\[r\d+\] textbox "Field \d+"$/);
      }
    } finally {
      await harness.shutdown();
    }
  });

  test("its permission projection is observe against the page's origin", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const observe = browserObserveTool({ session: harness.session });
      expect(observe.permissionScope?.({})).toBe("browser:observe");
      expect(observe.permissionPattern?.({})).toBe(FAKE_ORIGIN);
      expect(observe.isConcurrencySafe?.({})).toBe(false);
      expect(observe.changesState).toBe(false);
    } finally {
      await harness.shutdown();
    }
  });
});

describe("browser_navigate", () => {
  test("it opens an allowed origin and reports where it landed", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      const navigate = browserNavigateTool({ session: harness.session });
      const text = resultText(
        await navigate.execute("c1", { action: "open", url: FAKE_PAGE_URLS.form }, signal()),
      );
      expect(text).toContain(FAKE_PAGE_URLS.form);
      expect(text).toContain("Application form");
      expect(navigate.executionMode).toBe("sequential");
    } finally {
      await harness.shutdown();
    }
  });

  test("a non-web scheme is refused with the reason, not a stack trace", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      const navigate = browserNavigateTool({ session: harness.session });
      const result = await navigate.execute(
        "c1",
        { action: "open", url: "javascript:alert(1)" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("http(s) only");
    } finally {
      await harness.shutdown();
    }
  });

  test("an unapproved origin projects to the new-origin permission", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      const navigate = browserNavigateTool({ session: harness.session });
      const args = { action: "open" as const, url: "https://elsewhere.example/apply" };
      expect(navigate.permissionScope?.(args)).toBe("browser:new-origin");
      expect(navigate.permissionPattern?.(args)).toBe("https://elsewhere.example");
      const allowed = { action: "open" as const, url: FAKE_PAGE_URLS.form };
      expect(navigate.permissionScope?.(allowed)).toBe("browser:navigate");
    } finally {
      await harness.shutdown();
    }
  });

  test("a redirect onto another origin is reported as a new origin", async () => {
    const harness = createHarness({
      allowedOrigins: [FAKE_ORIGIN, "https://redirect.mu-browser.test"],
    });
    try {
      const navigate = browserNavigateTool({ session: harness.session });
      const text = resultText(
        await navigate.execute("c1", { action: "open", url: FAKE_PAGE_URLS.redirect }, signal()),
      );
      expect(text).toContain("a different origin");
      expect(text).toContain(FAKE_PAGE_URLS.redirectTarget);
    } finally {
      await harness.shutdown();
    }
  });

  test("history navigation takes no url", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      const navigate = browserNavigateTool({ session: harness.session });
      const result = await navigate.execute(
        "c1",
        { action: "back", url: FAKE_PAGE_URLS.form },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("takes no url");
    } finally {
      await harness.shutdown();
    }
  });
});

describe("browser_tabs", () => {
  test("a popup becomes a controlled tab, and switching invalidates references", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.popup);
      const act = browserActTool({ session: harness.session });
      const tabs = browserTabsTool({ session: harness.session });
      const trigger = elementNamed(harness, FAKE_LABELS.popupTrigger);
      await act.execute("c1", { action: "click", target: refOf(trigger) }, signal());

      const listed = await tabs.execute("c2", { action: "list" }, signal());
      const listing = resultText(listed);
      expect(listing).toContain("2 controlled tab(s)");
      expect(listing).toContain(FAKE_PAGE_URLS.popupTarget);

      const opened = harness.session.record();
      const selected = await tabs.execute(
        "c3",
        { action: "select", tabId: opened?.tabId ?? "" },
        signal(),
      );
      expect(resultText(selected)).toContain("no longer valid");
      expect(harness.session.record(opened?.tabId)).toBeUndefined();
    } finally {
      await harness.shutdown();
    }
  });

  test("list is read-only and select needs a tab", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      const tabs = browserTabsTool({ session: harness.session });
      expect(tabs.permissionScope?.({ action: "list" })).toBe("browser:observe");
      const changesState = tabs.changesState as (args: { action: string }) => boolean;
      expect(changesState({ action: "list" })).toBe(false);
      expect(changesState({ action: "open" })).toBe(true);
      const result = await tabs.execute("c1", { action: "select" }, signal());
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("needs a tabId");
    } finally {
      await harness.shutdown();
    }
  });
});

describe("browser_act", () => {
  test("advertises and performs targetless page scrolling", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.dynamic);
      const act = browserActTool({ session: harness.session });
      expect(act.description).toContain("omit target");
      expect(JSON.stringify(act.inputSchema)).toContain("Omit for page scrolling");

      const result = await act.execute("c1", { action: "scroll", deltaY: 800 }, signal());
      expect(result.isError).not.toBe(true);
      expect(resultText(result)).toContain("Scrolled");
      expect(harness.session.record()?.observation.viewport.scrollY).toBe(800);
    } finally {
      await harness.shutdown();
    }
  });

  test("a stale targeted scroll tells the model to retry without a target", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.dynamic);
      const act = browserActTool({ session: harness.session });
      const target = refOf(elementNamed(harness, FAKE_LABELS.scrollTarget));
      harness.session.invalidate(target.tabId);

      const result = await act.execute("c1", { action: "scroll", target, deltaY: 800 }, signal());
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('action "scroll", deltaY, and no target');
    } finally {
      await harness.shutdown();
    }
  });

  test("it fills, selects and checks, and reports what the page then showed", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const act = browserActTool({ session: harness.session });

      const filled = await act.execute(
        "c1",
        {
          action: "fill",
          target: refOf(elementNamed(harness, FAKE_LABELS.textField)),
          value: FAKE_VALUES.text,
        },
        signal(),
      );
      expect(resultText(filled)).toContain(`Filled "${FAKE_LABELS.textField}"`);
      expect(resultText(filled)).toContain(FAKE_VALUES.text);

      const selected = await act.execute(
        "c2",
        {
          action: "select",
          target: refOf(elementNamed(harness, FAKE_LABELS.select)),
          values: [FAKE_VALUES.selectOption],
        },
        signal(),
      );
      expect(resultText(selected)).toContain(`Selected ${FAKE_VALUES.selectOption}`);

      const checked = await act.execute(
        "c3",
        { action: "check", target: refOf(elementNamed(harness, FAKE_LABELS.checkbox)) },
        signal(),
      );
      expect(resultText(checked)).toContain(`Checked "${FAKE_LABELS.checkbox}"`);
      expect(resultText(checked)).toContain("(checked)");
    } finally {
      await harness.shutdown();
    }
  });

  test("a commitment control routes to browser_submit and performs nothing", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.submit);
      const act = browserActTool({ session: harness.session });
      const result = await act.execute(
        "c1",
        { action: "click", target: refOf(elementNamed(harness, FAKE_LABELS.submitButton)) },
        signal(),
      );
      const text = resultText(result);
      expect(result.isError).toBe(true);
      expect(text).toContain("browser_submit");
      expect(text).toContain("submit-form");
      expect(text).toContain("browser_act does not perform commitments");
      expect(harness.driver.submissions()).toHaveLength(0);
    } finally {
      await harness.shutdown();
    }
  });

  test("pressing a key that would activate a form submitter routes to browser_submit too", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.submit);
      const act = browserActTool({ session: harness.session });
      const field = harness.session
        .record()
        ?.observation.elements.find((element) => element.role === "textbox");
      const result = await act.execute(
        "c1",
        { action: "press", key: "Enter", target: refOf(field as BrowserElement) },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("browser_submit");
      expect(harness.driver.submissions()).toHaveLength(0);
    } finally {
      await harness.shutdown();
    }
  });

  test("a password control is handed to the user, not typed into", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.credentials);
      const act = browserActTool({ session: harness.session });
      const result = await act.execute(
        "c1",
        {
          action: "fill",
          target: refOf(elementNamed(harness, FAKE_LABELS.passwordField)),
          value: "hunter2",
        },
        signal(),
      );
      const text = resultText(result);
      expect(result.isError).toBe(true);
      expect(text).toContain("browser_takeover");
      expect(text).not.toContain("hunter2");
    } finally {
      await harness.shutdown();
    }
  });

  test("an unavailable option is refused with the options that exist", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const act = browserActTool({ session: harness.session });
      const result = await act.execute(
        "c1",
        {
          action: "select",
          target: refOf(elementNamed(harness, FAKE_LABELS.select)),
          values: ["Atlantis"],
        },
        signal(),
      );
      expect(result.isError).toBe(true);
      const text = resultText(result);
      expect(text).toContain("has no option Atlantis");
      expect(text).toContain("Ireland");
    } finally {
      await harness.shutdown();
    }
  });

  test("filling a list of options tells the model to select instead", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const act = browserActTool({ session: harness.session });
      const result = await act.execute(
        "c1",
        {
          action: "fill",
          target: refOf(elementNamed(harness, FAKE_LABELS.select)),
          value: "Ireland",
        },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Use action "select"');
    } finally {
      await harness.shutdown();
    }
  });

  test("invalid arguments are rejected before anything reaches the page", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const act = browserActTool({ session: harness.session });
      const target = refOf(elementNamed(harness, FAKE_LABELS.textField));

      const noValue = await act.execute("c1", { action: "fill", target }, signal());
      expect(noValue.isError).toBe(true);
      expect(resultText(noValue)).toContain("fill needs a value");

      const noTarget = await act.execute("c2", { action: "click" }, signal());
      expect(noTarget.isError).toBe(true);
      expect(resultText(noTarget)).toContain("needs a target reference");

      const halfDrag = await act.execute("c3", { action: "drag", source: target }, signal());
      expect(halfDrag.isError).toBe(true);
      expect(resultText(halfDrag)).toContain("destination");
    } finally {
      await harness.shutdown();
    }
  });

  test("entering personal data projects to the disclosure permission", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const act = browserActTool({ session: harness.session });
      const personal = {
        action: "fill" as const,
        target: refOf(elementNamed(harness, FAKE_LABELS.textField)),
        value: FAKE_VALUES.text,
      };
      expect(act.permissionScope?.(personal)).toBe("browser:disclose");
      expect(act.permissionPattern?.(personal)).toBe(`${FAKE_ORIGIN} ${FAKE_LABELS.textField}`);

      const neutral = {
        action: "hover" as const,
        target: refOf(elementNamed(harness, FAKE_LABELS.checkbox)),
      };
      expect(act.permissionScope?.(neutral)).toBe("browser:interact");
    } finally {
      await harness.shutdown();
    }
  });

  test("a cross-origin frame asks about its own origin, not the page's", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.frames);
      const act = browserActTool({ session: harness.session });
      const widget = elementNamed(harness, "Accept widget");
      const args = { action: "click" as const, target: refOf(widget) };
      expect(act.permissionScope?.(args)).toBe("browser:new-origin");
      expect(act.permissionPattern?.(args)).toBe("https://widgets.mu-browser.test");
    } finally {
      await harness.shutdown();
    }
  });

  test("a preview names the origin, the page, the control and the provenance", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const act = browserActTool({ session: harness.session });
      const details = await act.permissionDetails?.({
        action: "fill",
        target: refOf(elementNamed(harness, FAKE_LABELS.textField)),
        value: FAKE_VALUES.text,
      });
      const lines = details?.preview?.kind === "text" ? details.preview.lines : [];
      expect(lines).toContain(`origin: ${FAKE_ORIGIN}`);
      expect(lines).toContain("page: Application form");
      expect(lines).toContain(`control: ${FAKE_LABELS.textField}`);
      expect(lines).toContain("provenance: a literal value, not an authorized fact");
    } finally {
      await harness.shutdown();
    }
  });

  test("a factId with no fact store behind it is refused with what to do instead", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const act = browserActTool({ session: harness.session });
      const result = await act.execute(
        "c1",
        {
          action: "fill",
          target: refOf(elementNamed(harness, FAKE_LABELS.textField)),
          factId: "fact-1",
        },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Ask the user");
    } finally {
      await harness.shutdown();
    }
  });
});

describe("browser_wait", () => {
  test("it waits for text and then shows what is actually on the page", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.slow);
      const wait = browserWaitTool({ session: harness.session });
      const text = resultText(
        await wait.execute(
          "c1",
          { condition: "text", value: FAKE_VALUES.slowText, timeoutMs: 500 },
          signal(),
        ),
      );
      expect(text).toContain("Waited for text");
      expect(text).toContain("Slow page");
    } finally {
      await harness.shutdown();
    }
  });

  test("a timeout is an instruction to read the page, not to wait again", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.blank);
      const wait = browserWaitTool({ session: harness.session });
      const text = resultText(
        await wait.execute(
          "c1",
          { condition: "text", value: "never appears", timeoutMs: 30 },
          signal(),
        ),
      );
      expect(text).toContain("decide from it rather than waiting again");
    } finally {
      await harness.shutdown();
    }
  });

  test("a stale reference cannot be waited on", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const stale = refOf(elementNamed(harness, FAKE_LABELS.textField));
      await on(harness, FAKE_PAGE_URLS.blank);
      const wait = browserWaitTool({ session: harness.session });
      const result = await wait.execute(
        "c1",
        { condition: "element", value: stale, timeoutMs: 50 },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Observe again");
    } finally {
      await harness.shutdown();
    }
  });

  test("cancellation stops the wait immediately", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.blank);
      const wait = browserWaitTool({ session: harness.session });
      const controller = new AbortController();
      const pending = wait.execute("c1", { condition: "time", value: 5_000 }, controller.signal);
      controller.abort(new Error("cancelled"));
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("cancelled");
    } finally {
      await harness.shutdown();
    }
  });
});

describe("browser_takeover", () => {
  test("it pauses, says what the user must do, and does not claim completion", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.credentials);
      const takeover = browserTakeoverTool({ session: harness.session });
      const result = await takeover.execute(
        "c1",
        { reason: "password", instructions: "Sign in with your password manager." },
        signal(),
      );
      const text = resultText(result);
      expect(text).toContain("Waiting for you in the browser (password)");
      expect(text).toContain("Sign in with your password manager.");
      expect(text).toContain("The task is not complete");
      expect(result.terminate).toBe(true);
      expect(harness.runtime.status().phase).toBe("takeover");
      expect(takeover.permissionScope?.({ reason: "password", instructions: "x" })).toBe(
        "browser:takeover",
      );
    } finally {
      await harness.shutdown();
    }
  });

  test("while the user has the browser, actions refuse rather than race them", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      const target = refOf(elementNamed(harness, FAKE_LABELS.textField));
      const takeover = browserTakeoverTool({ session: harness.session });
      await takeover.execute("c1", { reason: "login", instructions: "sign in" }, signal());
      const act = browserActTool({ session: harness.session });
      const result = await act.execute("c2", { action: "fill", target, value: "Ada" }, signal());
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("The user has control");
    } finally {
      await harness.shutdown();
    }
  });
});

describe("driver failures become instructions", () => {
  test("a lost connection tells the model not to assume anything completed", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      harness.driver.failNext("connection-lost", "the bridge went away");
      const observe = browserObserveTool({ session: harness.session });
      const result = await observe.execute("c1", {}, signal());
      expect(result.isError).toBe(true);
      const text = resultText(result);
      expect(text).toContain("the bridge went away");
      expect(text).toContain("Nothing about the last action is confirmed");
    } finally {
      await harness.shutdown();
    }
  });

  test("an unsupported operation offers takeover as the way through", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await on(harness, FAKE_PAGE_URLS.form);
      harness.driver.failNext("unsupported", "this browser cannot do that");
      const observe = browserObserveTool({ session: harness.session });
      const text = resultText(await observe.execute("c1", {}, signal()));
      expect(text).toContain("browser_takeover");
    } finally {
      await harness.shutdown();
    }
  });
});
