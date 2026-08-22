import { describe, expect, test } from "bun:test";
import type { BrowserElement } from "../contracts/observation.ts";
import { elementRefId } from "../contracts/primitives.ts";
import {
  FAKE_GUARD_MESSAGE,
  FAKE_LABELS,
  FAKE_ORIGIN,
  FAKE_PAGE_URLS,
} from "../drivers/fake/site.ts";
import { browserActTool } from "./act.ts";
import { createHarness, type Harness, resultText } from "./harness.ts";
import { BROWSER_SUBMIT_TOOL, browserSubmitTool } from "./submit.ts";

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

async function submitOnce(harness: Harness, url = FAKE_PAGE_URLS.submit) {
  await on(harness, url);
  const target = refOf(elementNamed(harness, FAKE_LABELS.submitButton));
  const submit = browserSubmitTool({ session: harness.session });
  return { submit, target };
}

describe("browser_submit", () => {
  test("a commitment is described before it happens, naming origin, intent and fields", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    const { submit, target } = await submitOnce(harness);
    const details = await submit.permissionDetails?.({ target, intent: "submit-form" } as never);
    const lines = (details?.preview as { lines: string[] } | undefined)?.lines ?? [];
    const text = lines.join("\n");
    expect(text).toContain("origin:");
    expect(text).toContain("intent: submit-form");
    // The user must be told the thing Mu cannot do.
    expect(text).toContain("cannot be undone");
    await harness.shutdown();
  });

  test("it asks under the default mode rather than proceeding", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    const { submit, target } = await submitOnce(harness);
    expect(submit.permissionScope?.({ target, intent: "purchase" } as never)).toBe(
      "browser:purchase",
    );
    expect(submit.permissionScope?.({ target, intent: "submit-form" } as never)).toBe(
      "browser:submit",
    );
    await harness.shutdown();
  });

  test("a confirmed commitment reports confirmed and does not warn about repeating", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    const { submit, target } = await submitOnce(harness);
    const text = resultText(
      await submit.execute("c1", { target, intent: "submit-form" }, signal()),
    );
    expect(text).toContain("confirmed");
    expect(text).not.toContain("Do not repeat");
    await harness.shutdown();
  });

  // BD18: the case this whole tool is shaped around.
  test("an unproven outcome is reported, and a second attempt is refused", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    const { submit, target } = await submitOnce(harness, FAKE_PAGE_URLS.unknownSubmit);
    const first = resultText(
      await submit.execute("c1", { target, intent: "submit-form" }, signal()),
    );
    expect(first).toMatch(/unconfirmed|unknown/);
    expect(first).toContain("Do not repeat");

    // Go back and observe again, so the model holds a genuinely live ref — exactly the
    // position it is in when tempted to "just try once more".
    await on(harness, FAKE_PAGE_URLS.unknownSubmit);
    const fresh = refOf(elementNamed(harness, FAKE_LABELS.submitButton));
    const second = await submit.execute("c2", { target: fresh, intent: "submit-form" }, signal());
    expect(second.isError).toBe(true);
    await harness.shutdown();
  });

  test("it refuses before observing, rather than committing blind", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    const submit = browserSubmitTool({ session: harness.session });
    const result = await submit.execute(
      "c1",
      { target: { ref: elementRefId("e1"), revision: 1, tabId: "t1" }, intent: "submit-form" },
      signal(),
    );
    expect(result.isError).toBe(true);
    await harness.shutdown();
  });

  test("a stale reference never commits", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    const { submit, target } = await submitOnce(harness);
    // Anything that changes the page invalidates what the model is holding.
    await on(harness, FAKE_PAGE_URLS.form);
    const result = await submit.execute("c1", { target, intent: "submit-form" }, signal());
    expect(result.isError).toBe(true);
    await harness.shutdown();
  });

  test("a page that asks its own question is not answered by approving the commitment", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    const { submit, target } = await submitOnce(harness, FAKE_PAGE_URLS.guardedSubmit);
    const result = await submit.execute("c1", { target, intent: "submit-form" }, signal());
    const text = resultText(result);
    // The model has to be able to read the question to decide whether to ask about it.
    expect(text).toContain(FAKE_GUARD_MESSAGE);
    expect(text).toContain("dismissed");
    expect(harness.driver.submissions()).toHaveLength(0);
    await harness.shutdown();
  });

  test("accepting the approved question commits, and the card shows the question", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    const { submit, target } = await submitOnce(harness, FAKE_PAGE_URLS.guardedSubmit);
    const args = {
      target,
      intent: "submit-form" as const,
      acceptDialog: { message: FAKE_GUARD_MESSAGE },
    };
    const details = await submit.permissionDetails?.(args as never);
    const lines = (details?.preview as { lines: string[] } | undefined)?.lines ?? [];
    expect(lines.join("\n")).toContain(FAKE_GUARD_MESSAGE);

    const text = resultText(await submit.execute("c1", args, signal()));
    expect(text).toContain("confirmed");
    expect(harness.driver.submissions()).toHaveLength(1);
    await harness.shutdown();
  });

  test("a question other than the approved one is dismissed, not answered", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    const { submit, target } = await submitOnce(harness, FAKE_PAGE_URLS.guardedSubmit);
    const result = await submit.execute(
      "c1",
      { target, intent: "submit-form", acceptDialog: { message: "Send an empty application?" } },
      signal(),
    );
    expect(resultText(result)).toContain("dismissed");
    expect(harness.driver.submissions()).toHaveLength(0);
    await harness.shutdown();
  });

  // BD12: the separation only means something if the generic path cannot reach the button.
  test("browser_act cannot press a submit control", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    await on(harness, FAKE_PAGE_URLS.submit);
    const target = refOf(elementNamed(harness, FAKE_LABELS.submitButton));
    const act = browserActTool({ session: harness.session });
    const result = await act.execute("a1", { action: "click", target }, signal());
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(BROWSER_SUBMIT_TOOL);
    await harness.shutdown();
  });
});
