// B8: an AbortSignal that is already fired when it reaches the runtime must fail the
// in-flight call without leaving the connection in a phase the session cannot describe
// or recover from. Connecting is already covered in runtime.test.ts ("cancelling the
// connection leaves the runtime disconnected rather than failed"); this covers the
// three stages that happen once a connection is already `ready`.
import { describe, expect, test } from "bun:test";
import { isBrowserDriverError } from "../contracts/driver.ts";
import type { BrowserDriverFactory } from "../drivers/factory.ts";
import { createFakeBrowserDriver } from "../drivers/fake/driver.ts";
import { FAKE_LABELS, FAKE_PAGE_URLS } from "../drivers/fake/site.ts";
import { BrowserRuntime } from "./runtime.ts";
import { phaseSummary } from "./state.ts";

const signal = () => new AbortController().signal;

function attachedFactory() {
  const driver = createFakeBrowserDriver();
  const factory: BrowserDriverFactory = async () => ({
    driver,
    ownership: "attached",
    description: "fake",
    dispose: async () => {},
  });
  return { driver, factory };
}

async function readyRuntime() {
  const { driver, factory } = attachedFactory();
  const runtime = new BrowserRuntime({
    factory,
    connection: "extension",
    browser: "chrome",
    dataRoot: "/unused",
  });
  await runtime.connect(signal());
  return { driver, runtime };
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error("cancelled by caller"));
  return controller.signal;
}

describe("cancellation mid-operation leaves the runtime in a phase it can describe and recover from", () => {
  test("observing: an aborted signal is a typed failure and the runtime stays ready", async () => {
    const { runtime } = await readyRuntime();
    const cancelled = abortedSignal();
    let caught: unknown;
    try {
      await runtime.use((driver) => driver.observe({}, cancelled), cancelled);
    } catch (error) {
      caught = error;
    }
    expect(isBrowserDriverError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("aborted");
    expect(runtime.status().phase).toBe("ready");
    expect(phaseSummary(runtime.status().phase)).toBe("connected and accepting actions");

    // Recoverable: an ordinary call right after still works with no reconnect needed.
    const observation = await runtime.use((driver) => driver.observe({}, signal()), signal());
    expect(observation.revision).toBeGreaterThan(0);
  });

  test("acting: an aborted signal is a typed failure and the runtime stays ready", async () => {
    const { runtime } = await readyRuntime();
    const cancelled = abortedSignal();
    let caught: unknown;
    try {
      await runtime.use(
        (driver) => driver.act({ kind: "scroll", deltaX: 0, deltaY: 10 }, cancelled),
        cancelled,
      );
    } catch (error) {
      caught = error;
    }
    expect(isBrowserDriverError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("aborted");
    expect(runtime.status().phase).toBe("ready");

    const result = await runtime.use(
      (driver) => driver.act({ kind: "scroll", deltaX: 0, deltaY: 10 }, signal()),
      signal(),
    );
    expect(result.status).toBe("completed");
  });

  test("submitting: an aborted signal is a typed failure and the runtime stays ready", async () => {
    const { runtime } = await readyRuntime();
    await runtime.use(
      (driver) => driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.submit }, signal()),
      signal(),
    );
    const observation = await runtime.use((driver) => driver.observe({}, signal()), signal());
    const button = observation.elements.find(
      (element) => element.name === FAKE_LABELS.submitButton,
    );
    if (button === undefined) throw new Error("no observed submit control");
    const target = { ref: button.ref, revision: button.revision, tabId: button.tabId };

    const cancelled = abortedSignal();
    let caught: unknown;
    try {
      await runtime.use(
        (driver) => driver.submit({ target, intent: "submit-form" }, cancelled),
        cancelled,
      );
    } catch (error) {
      caught = error;
    }
    expect(isBrowserDriverError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("aborted");
    // Cancelling submission is not reconnectable, so the runtime does not need a
    // reconnect to recover — it is still `ready`, and can describe itself as such.
    expect(runtime.status().phase).toBe("ready");
    expect(phaseSummary(runtime.status().phase)).toBeTruthy();
  });
});
