// B8: cancellation must never leave a commitment silently in limbo. `browser_submit`
// already settles the ledger in a `finally`-shaped path even when the driver call is
// cancelled — this proves it end to end: the tool never throws, the model is told the
// outcome is unproven, and a second attempt is refused rather than repeating something
// that may already have happened.
import { describe, expect, test } from "bun:test";
import type { BrowserElement } from "../contracts/observation.ts";
import { FAKE_LABELS, FAKE_PAGE_URLS } from "../drivers/fake/site.ts";
import { createHarness, type Harness, resultText } from "./harness.ts";
import { browserSubmitTool } from "./submit.ts";

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

describe("submitting: an aborted attempt is settled and reported, never left unknown and silent", () => {
  test("the tool never throws, reports the outcome as unproven, and never repeats it", async () => {
    const harness = createHarness({ allowedOrigins: [new URL(FAKE_PAGE_URLS.submit).origin] });
    await on(harness, FAKE_PAGE_URLS.submit);
    const target = refOf(elementNamed(harness, FAKE_LABELS.submitButton));
    const submit = browserSubmitTool({ session: harness.session });

    // The driver call itself is what gets cancelled — the exact case BD18 exists for:
    // the request may already have reached the page.
    harness.driver.failNext("aborted", "the operation was cancelled");

    const result = await submit.execute("c1", { target, intent: "submit-form" }, signal());
    // A cancelled commitment attempt is a reported outcome, not a thrown tool failure.
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("stopped reporting before it confirmed");
    expect(text).toContain("Do not repeat");

    // The ledger actually parked it: the model is not merely told not to repeat, it is
    // structurally prevented from repeating the same commitment.
    await on(harness, FAKE_PAGE_URLS.submit);
    const fresh = refOf(elementNamed(harness, FAKE_LABELS.submitButton));
    const second = await submit.execute("c2", { target: fresh, intent: "submit-form" }, signal());
    expect(second.isError).toBe(true);
    expect(resultText(second)).toContain("unproven");
    expect(harness.driver.submissions()).toHaveLength(0);
    await harness.shutdown();
  });

  test("a connection dropped mid-submit is settled the same way, and is distinguished from a plain abort", async () => {
    const harness = createHarness({ allowedOrigins: [new URL(FAKE_PAGE_URLS.submit).origin] });
    await on(harness, FAKE_PAGE_URLS.submit);
    const target = refOf(elementNamed(harness, FAKE_LABELS.submitButton));
    const submit = browserSubmitTool({ session: harness.session });

    harness.driver.failNext("connection-lost", "the bridge dropped mid-request");
    const result = await submit.execute("c1", { target, intent: "submit-form" }, signal());
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("Do not repeat");
    expect(harness.runtime.status().phase).toBe("reconnecting");

    // Refused for the same reason as the plain-abort case: an unproven outcome, not
    // something the model can retry — even once the connection itself is restored.
    await harness.runtime.reconnect(signal());
    await on(harness, FAKE_PAGE_URLS.submit);
    const fresh = refOf(elementNamed(harness, FAKE_LABELS.submitButton));
    const second = await submit.execute("c2", { target: fresh, intent: "submit-form" }, signal());
    expect(second.isError).toBe(true);
    expect(harness.driver.submissions()).toHaveLength(0);
    await harness.shutdown();
  });
});
