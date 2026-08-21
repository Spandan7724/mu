import { describe, expect, test } from "bun:test";
import { mayRetry } from "../../contracts/actions.ts";
import { acceptsModelActions } from "../../contracts/connection.ts";
import { isBrowserDriverError } from "../../contracts/driver.ts";
import { assertJsonSerializable } from "../../contracts/json.ts";
import { elementRefOf } from "../../contracts/observation.ts";
import { BrowserSecret, REDACTED } from "../../contracts/secret.ts";
import type { DriverContractSetup } from "../../testing/conformance-types.ts";
import {
  registerBrowserDriverContract,
  runBrowserDriverContract,
} from "../../testing/driver-conformance.ts";
import { createFakeBrowserDriver, type FakeBrowserDriver } from "./driver.ts";
import { FAKE_DRIVER_CAPABILITIES, FAKE_DRIVER_FIXTURE, fakeUploadDocument } from "./fixture.ts";
import { FAKE_LABELS, FAKE_PAGE_URLS, FAKE_VALUES } from "./site.ts";

const document = fakeUploadDocument();

function contractSetup(): DriverContractSetup {
  let current: FakeBrowserDriver | undefined;
  return {
    name: "fake",
    createDriver: () => {
      current = createFakeBrowserDriver({ documents: [document] });
      return current;
    },
    connectOptions: { mode: "extension", browser: "chrome" },
    fixture: FAKE_DRIVER_FIXTURE,
    capabilities: FAKE_DRIVER_CAPABILITIES,
    uploadDocument: document,
    simulateConnectionLoss: async (driver) =>
      (driver as FakeBrowserDriver).simulateConnectionLoss(),
    readSubmissions: async () => current?.submissions() ?? [],
    timeoutMs: 20_000,
  };
}

registerBrowserDriverContract({ describe, test }, contractSetup());

describe("the fake driver runs the whole contract, with nothing skipped", () => {
  test("every declared capability is exercised and every case passes", async () => {
    const report = await runBrowserDriverContract(contractSetup());
    const failures = report.results.filter((result) => result.status === "failed");
    expect(failures.map((result) => `${result.id}: ${result.message}`)).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.passed).toBe(report.results.length);
  }, 60_000);
});

async function connected(): Promise<{ driver: FakeBrowserDriver; signal: AbortSignal }> {
  const driver = createFakeBrowserDriver({ documents: [document] });
  const signal = new AbortController().signal;
  await driver.connect({ mode: "extension", browser: "chrome" }, signal);
  return { driver, signal };
}

describe("scripting and failure injection", () => {
  test("a driver awaiting approval refuses to connect until it is approved", async () => {
    const driver = createFakeBrowserDriver({ requireApproval: true });
    const signal = new AbortController().signal;
    expect(driver.status().approvalRequired).toBe(true);
    await expect(driver.connect({ mode: "extension", browser: "chrome" }, signal)).rejects.toThrow(
      "approve the connection",
    );
    expect(driver.status().phase).toBe("disconnected");
    driver.approve();
    const state = await driver.connect({ mode: "extension", browser: "chrome" }, signal);
    expect(state.phase).toBe("ready");
    expect(acceptsModelActions(state.phase)).toBe(true);
  });

  test("an injected failure applies once and then clears", async () => {
    const { driver, signal } = await connected();
    driver.failNext("protocol-mismatch", "update the extension");
    const error = await driver.observe({}, signal).catch((thrown: unknown) => thrown);
    expect(isBrowserDriverError(error) && error.code).toBe("protocol-mismatch");
    expect(isBrowserDriverError(error) && error.reconnectable).toBe(false);
    await expect(driver.observe({}, signal)).resolves.toBeDefined();
  });

  test("a mode the driver was not built for is refused as unsupported", async () => {
    const driver = createFakeBrowserDriver();
    const error = await driver
      .connect({ mode: "persistent", browser: "chrome" }, new AbortController().signal)
      .catch((thrown: unknown) => thrown);
    expect(isBrowserDriverError(error) && error.code).toBe("unsupported");
  });

  test("a connect option carrying a secret never reaches the reported state", async () => {
    const driver = createFakeBrowserDriver();
    const state = await driver.connect(
      { mode: "extension", browser: "chrome", extensionToken: new BrowserSecret("tok-abcdef") },
      new AbortController().signal,
    );
    assertJsonSerializable(state, "connection state");
    expect(JSON.stringify(state)).not.toContain("tok-abcdef");
  });
});

describe("observation discipline", () => {
  test("bounded observation reports what it omitted", async () => {
    const { driver, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.form }, signal);
    const bounded = await driver.observe({ maxNodes: 2, maxTextChars: 12 }, signal);
    expect(bounded.elements).toHaveLength(2);
    expect(bounded.snapshot.length).toBe(12);
    expect(bounded.truncated?.nodesOmitted).toBe(5);
    expect(bounded.truncated?.textCharsOmitted).toBeGreaterThan(0);
  });

  test("a credential field is observed redacted and its value never leaves the page", async () => {
    const { driver, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.credentials }, signal);
    const observation = await driver.observe({ screenshot: "viewport" }, signal);
    const password = observation.elements.find(
      (element) => element.label === FAKE_LABELS.passwordField,
    );
    expect(password?.value).toBe(REDACTED);
    expect(observation.risks).toContain("password");
    expect(observation.screenshot).toBeUndefined();
    expect(JSON.stringify(observation)).not.toContain(FAKE_VALUES.secretMarker);
  });
});

describe("takeover", () => {
  test("takeover stops accepting model actions and resuming re-observes at a new revision", async () => {
    const { driver, signal } = await connected();
    const before = await driver.observe({}, signal);
    await driver.takeover("login");
    expect(driver.status().phase).toBe("takeover");
    expect(acceptsModelActions(driver.status().phase)).toBe(false);
    await expect(
      driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.form }, signal),
    ).rejects.toThrow("only a ready connection accepts actions");
    const after = await driver.resumeFromTakeover(signal);
    expect(driver.status().phase).toBe("ready");
    expect(after.revision).toBeGreaterThan(before.revision);
  });
});

describe("commitment routing", () => {
  test("an uncertain submission is recorded once and is never retryable", async () => {
    const { driver, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.unknownSubmit }, signal);
    const observation = await driver.observe({}, signal);
    const button = observation.elements.find(
      (element) => element.label === FAKE_LABELS.submitButton,
    );
    const outcome = await driver.submit(
      { target: elementRefOf(button as never), intent: "submit-form" },
      signal,
    );
    expect(outcome.status).toBe("unknown");
    expect(mayRetry(outcome)).toBe(false);
    expect(driver.submissions()).toHaveLength(1);
  });

  test("a submit request whose intent disagrees with the control is blocked", async () => {
    const { driver, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.submit }, signal);
    const observation = await driver.observe({}, signal);
    const button = observation.elements.find(
      (element) => element.label === FAKE_LABELS.submitButton,
    );
    const outcome = await driver.submit(
      { target: elementRefOf(button as never), intent: "purchase" },
      signal,
    );
    expect(outcome.status).toBe("blocked");
    expect(driver.submissions()).toHaveLength(0);
  });
});
