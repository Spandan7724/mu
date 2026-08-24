// The real adapter, running the whole driver conformance suite against a sidecar
// that speaks `@playwright/mcp` 0.0.79's own response shapes. No browser is
// launched, so CI stays deterministic; the live-browser run of the identical
// suite lives in `live.test.ts` behind an env flag.
import { describe, expect, test } from "bun:test";
import { BrowserDriverError } from "../../contracts/driver.ts";
import { elementRefOf } from "../../contracts/observation.ts";
import { BrowserSecret } from "../../contracts/secret.ts";
import type { DriverContractSetup } from "../../testing/conformance-types.ts";
import {
  registerBrowserDriverContract,
  runBrowserDriverContract,
} from "../../testing/driver-conformance.ts";
import {
  FAKE_DRIVER_CAPABILITIES,
  FAKE_DRIVER_FIXTURE,
  fakeUploadDocument,
} from "../fake/fixture.ts";
import {
  defaultFakeSite,
  FAKE_LABELS,
  FAKE_PAGE_URLS,
  FAKE_VALUES,
  fakeSite,
} from "../fake/site.ts";
import { createMcpBrowserDriver, type McpBrowserDriver } from "./driver.ts";
import { createScriptedSidecar, type ScriptedSidecar } from "./scripted.ts";

const document = fakeUploadDocument();

function contractSetup(mode: "persistent" | "extension"): DriverContractSetup {
  let sidecar: ScriptedSidecar | undefined;
  return {
    name: `playwright-mcp (${mode}, scripted sidecar)`,
    createDriver: () => {
      sidecar = createScriptedSidecar();
      return createMcpBrowserDriver({
        sidecar,
        mode,
        browser: "chrome",
        ownership: mode === "persistent" ? "owned" : "attached",
        documents: [document],
      });
    },
    connectOptions: { mode, browser: "chrome" },
    fixture: FAKE_DRIVER_FIXTURE,
    capabilities: FAKE_DRIVER_CAPABILITIES,
    uploadDocument: document,
    simulateConnectionLoss: async (driver) => (driver as McpBrowserDriver).sever(),
    readSubmissions: async () => sidecar?.submissions() ?? [],
    timeoutMs: 20_000,
  };
}

registerBrowserDriverContract({ describe, test }, contractSetup("persistent"));
registerBrowserDriverContract({ describe, test }, contractSetup("extension"));

describe("both modes run the same suite and reach the same verdict", () => {
  test("persistent mode passes every case, with nothing skipped", async () => {
    const report = await runBrowserDriverContract(contractSetup("persistent"));
    expect(
      report.results.filter((r) => r.status === "failed").map((r) => `${r.id}: ${r.message}`),
    ).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.passed).toBe(report.results.length);
  }, 120_000);

  test("extension mode passes every case, with nothing skipped", async () => {
    const report = await runBrowserDriverContract(contractSetup("extension"));
    expect(
      report.results.filter((r) => r.status === "failed").map((r) => `${r.id}: ${r.message}`),
    ).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.passed).toBe(report.results.length);
  }, 120_000);
});

async function connected(
  mode: "persistent" | "extension" = "persistent",
  sidecar: ScriptedSidecar = createScriptedSidecar(),
): Promise<{ driver: McpBrowserDriver; sidecar: ScriptedSidecar; signal: AbortSignal }> {
  const driver = createMcpBrowserDriver({
    sidecar,
    mode,
    browser: "chrome",
    ownership: mode === "persistent" ? "owned" : "attached",
    documents: [document],
  });
  const signal = new AbortController().signal;
  await driver.connect({ mode, browser: "chrome" }, signal);
  return { driver, sidecar, signal };
}

describe("shutdown semantics differ by ownership (BD29)", () => {
  test("an owned browser is closed and awaited before the sidecar is let go", async () => {
    const calls: string[] = [];
    const inner = createScriptedSidecar();
    const recorder: ScriptedSidecar = {
      ...inner,
      callTool: async (name, args, options) => {
        calls.push(name);
        return inner.callTool(name, args, options);
      },
    };
    const { driver } = await connected("persistent", recorder);
    await driver.disconnect();
    expect(calls).toContain("browser_close");
  });

  test("an attached browser is never closed", async () => {
    const calls: string[] = [];
    const inner = createScriptedSidecar();
    const recorder: ScriptedSidecar = {
      ...inner,
      callTool: async (name, args, options) => {
        calls.push(name);
        return inner.callTool(name, args, options);
      },
    };
    const { driver } = await connected("extension", recorder);
    await driver.disconnect();
    expect(calls).not.toContain("browser_close");
  });
});

describe("failure normalisation", () => {
  test("a version mismatch fails with update instructions instead of degrading", async () => {
    const sidecar = createScriptedSidecar({
      serverIdentity: { name: "Playwright", version: "1.0.0-not-the-pinned-build" },
    });
    const driver = createMcpBrowserDriver({
      sidecar,
      mode: "persistent",
      browser: "chrome",
      ownership: "owned",
    });
    const error = await driver
      .connect({ mode: "persistent", browser: "chrome" }, new AbortController().signal)
      .catch((thrown: unknown) => thrown);
    expect((error as { code?: string }).code).toBe("protocol-mismatch");
    expect(String(error)).toContain("Reinstall @mu-agent/browser");
    expect(driver.status().phase).toBe("disconnected");
  });

  test("a mode the driver was not built for is refused as unsupported", async () => {
    const driver = createMcpBrowserDriver({
      sidecar: createScriptedSidecar(),
      mode: "persistent",
      browser: "chrome",
      ownership: "owned",
    });
    const error = await driver
      .connect({ mode: "extension", browser: "chrome" }, new AbortController().signal)
      .catch((thrown: unknown) => thrown);
    expect((error as { code?: string }).code).toBe("unsupported");
  });

  test("a sidecar still waiting for extension approval says so, actionably", async () => {
    const sidecar = createScriptedSidecar();
    sidecar.failNext(
      new BrowserDriverError("timeout", "Waiting for incoming extension connection"),
    );
    const driver = createMcpBrowserDriver({
      sidecar,
      mode: "extension",
      browser: "chrome",
      ownership: "attached",
    });
    const error = await driver
      .connect({ mode: "extension", browser: "chrome" }, new AbortController().signal)
      .catch((thrown: unknown) => thrown);
    expect((error as { code?: string }).code).toBe("approval-required");
    expect(String(error)).toContain("Approve it in the browser");
    expect(driver.status().phase).toBe("disconnected");
  });

  test("a severed bridge is a typed, reconnectable failure", async () => {
    const { driver, signal } = await connected();
    driver.sever();
    const error = await driver.observe({}, signal).catch((thrown: unknown) => thrown);
    expect((error as { code?: string }).code).toBe("browser-crashed");
    expect((error as { reconnectable?: boolean }).reconnectable).toBe(true);
  });

  test("a connect option carrying a secret never reaches the reported state", async () => {
    const { driver } = await connected("extension");
    const state = driver.status();
    expect(JSON.stringify(state)).not.toContain("tok-");
    expect(new BrowserSecret("tok-abcdef").toJSON()).toBe("[redacted]");
  });
});

describe("the raw tool surface stays behind the adapter", () => {
  test("no unsafe or inspection tool is ever called", async () => {
    const calls: string[] = [];
    const inner = createScriptedSidecar();
    const recorder: ScriptedSidecar = {
      ...inner,
      callTool: async (name, args, options) => {
        calls.push(name);
        return inner.callTool(name, args, options);
      },
    };
    const { driver, signal } = await connected("persistent", recorder);
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.form }, signal);
    const observation = await driver.observe({ screenshot: "viewport" }, signal);
    const field = observation.elements.find((element) => element.label === FAKE_LABELS.textField);
    await driver.act(
      { kind: "fill", target: elementRefOf(field as never), value: FAKE_VALUES.text },
      signal,
    );
    await driver.disconnect();
    expect(calls).not.toContain("browser_run_code_unsafe");
    expect(calls).not.toContain("browser_network_requests");
    expect(calls).not.toContain("browser_network_request");
    expect(calls).not.toContain("browser_console_messages");
  });

  test("the sidecar only ever writes inside the output directory it was given", async () => {
    const { driver, sidecar, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.download }, signal);
    const observation = await driver.observe({ screenshot: "viewport" }, signal);
    const trigger = observation.elements.find(
      (element) => element.label === FAKE_LABELS.downloadTrigger,
    );
    await driver.act({ kind: "click", target: elementRefOf(trigger as never) }, signal);
    const written = sidecar.writtenPaths();
    expect(written.length).toBeGreaterThan(0);
    for (const path of written) expect(path.startsWith("/mu-artifacts/sidecar/")).toBe(true);
  });
});

describe("observation discipline", () => {
  test("an oversized page prioritizes controls in the viewport before applying maxNodes", async () => {
    const url = "https://fake.mu-browser.test/oversized";
    const site = fakeSite(
      [
        {
          url,
          title: "Oversized models",
          summary: "A model catalog larger than one observation.",
          elements: Array.from({ length: 300 }, (_, index) => ({
            ref: `model-${index + 1}`,
            role: "link",
            name: `Model ${index + 1}`,
            label: `Model ${index + 1}`,
          })),
        },
      ],
      url,
    );
    const inner = createScriptedSidecar({ site });
    const sidecar: ScriptedSidecar = {
      ...inner,
      callTool: async (name, args, options) => {
        if (name === "browser_evaluate" && String(args.function).includes("window.innerWidth")) {
          return {
            content: [
              {
                type: "text",
                text: `### Result\n${JSON.stringify({
                  width: 1280,
                  height: 720,
                  scrollX: 0,
                  scrollY: 24_000,
                  readyState: "complete",
                  frameUrls: [],
                  visibleLabels: ["Model 241", "Model 242", "Model 243"],
                })}`,
              },
            ],
          };
        }
        return inner.callTool(name, args, options);
      },
    };
    const { driver, signal } = await connected("persistent", sidecar);
    const observation = await driver.observe({ maxNodes: 20 }, signal);
    expect(observation.elements.slice(0, 3).map((element) => element.label)).toEqual([
      "Model 241",
      "Model 242",
      "Model 243",
    ]);
    expect(observation.truncated?.nodesOmitted).toBe(281);
  });

  test("a credential value on the page is never observed and never screenshotted", async () => {
    const { driver, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.credentials }, signal);
    const observation = await driver.observe({ screenshot: "viewport" }, signal);
    const password = observation.elements.find(
      (element) => element.label === FAKE_LABELS.passwordField,
    );
    expect(password?.value).toBe("[redacted]");
    expect(observation.risks).toContain("password");
    expect(observation.screenshot).toBeUndefined();
    expect(JSON.stringify(observation)).not.toContain(FAKE_VALUES.secretMarker);
  });

  test("a page change advances the revision; typing into a field does not", async () => {
    const { driver, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.form }, signal);
    const before = await driver.observe({}, signal);
    const field = before.elements.find((element) => element.label === FAKE_LABELS.textField);
    await driver.act(
      { kind: "fill", target: elementRefOf(field as never), value: FAKE_VALUES.text },
      signal,
    );
    const after = await driver.observe({}, signal);
    expect(after.revision).toBe(before.revision);
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.dynamic }, signal);
    expect((await driver.observe({}, signal)).revision).toBeGreaterThan(before.revision);
  });
});

describe("commitment routing", () => {
  test("a confirmed submit carries its post-submit navigation as evidence", async () => {
    const { driver, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.submit }, signal);
    const observation = await driver.observe({}, signal);
    const button = observation.elements.find(
      (element) => element.label === FAKE_LABELS.submitButton,
    );
    const outcome = await driver.submit(
      { target: elementRefOf(button as never), intent: "submit-form" },
      signal,
    );

    expect(outcome.navigation?.from).toBe(observation.url);
    expect(outcome.navigation?.to).not.toBe(observation.url);
    expect(outcome.details).toMatchObject({ formDisappeared: true });
  });

  test("a generic click on a submitter is blocked and names the submit path", async () => {
    const { driver, sidecar, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.submit }, signal);
    const observation = await driver.observe({}, signal);
    const button = observation.elements.find(
      (element) => element.label === FAKE_LABELS.submitButton,
    );
    const outcome = await driver.act(
      { kind: "click", target: elementRefOf(button as never) },
      signal,
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.message.toLowerCase()).toContain("submit");
    expect(sidecar.submissions()).toHaveLength(0);
  });

  test("a submit whose intent disagrees with the control is blocked", async () => {
    const { driver, sidecar, signal } = await connected();
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
    expect(sidecar.submissions()).toHaveLength(0);
  });

  test("a lost confirmation is recorded once, reported unknown, and never retried", async () => {
    const { driver, sidecar, signal } = await connected();
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
    expect(outcome.ok).toBe(false);
    expect(sidecar.submissions()).toHaveLength(1);
  });

  test("a new semantic rejection alert is carried as failure evidence", async () => {
    const { driver, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.failedSubmit }, signal);
    const observation = await driver.observe({}, signal);
    const button = observation.elements.find(
      (element) => element.label === FAKE_LABELS.submitButton,
    );
    const outcome = await driver.submit(
      { target: elementRefOf(button as never), intent: "submit-form" },
      signal,
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.details).toMatchObject({
      formDisappeared: true,
      failureText: "We could not submit your application. No application was created.",
    });
  });
});

describe("uploads name documents, never paths", () => {
  test("an authorized document is sent by the path only the adapter knows", async () => {
    const { driver, sidecar, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.upload }, signal);
    const observation = await driver.observe({}, signal);
    const field = observation.elements.find((element) => element.label === FAKE_LABELS.fileField);
    const outcome = await driver.upload(
      { target: elementRefOf(field as never), documentIds: [document.id] },
      signal,
    );
    expect(outcome.status).toBe("completed");
    expect(sidecar.uploadedPaths()).toEqual([document.path]);
    expect(JSON.stringify(outcome)).not.toContain(document.path);
  });
});

describe("takeover", () => {
  test("takeover stops model actions and resuming re-observes at a new revision", async () => {
    const { driver, signal } = await connected();
    const before = await driver.observe({}, signal);
    await driver.takeover("login");
    expect(driver.status().phase).toBe("takeover");
    await expect(
      driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.form }, signal),
    ).rejects.toThrow("only a ready connection accepts actions");
    const after = await driver.resumeFromTakeover(signal);
    expect(driver.status().phase).toBe("ready");
    expect(after.revision).toBeGreaterThan(before.revision);
  });
});

describe("a site the adapter has never seen", () => {
  test("an unknown page is observed without inventing controls", async () => {
    const site = fakeSite(
      [{ url: "https://elsewhere.test/", title: "Elsewhere", summary: "", elements: [] }],
      "https://elsewhere.test/",
    );
    const { driver, signal } = await connected("persistent", createScriptedSidecar({ site }));
    const observation = await driver.observe({}, signal);
    // The document root is still a node; nothing is invented beyond it.
    expect(observation.elements.filter((element) => element.name !== undefined)).toEqual([]);
    expect(observation.url).toBe("https://elsewhere.test/");
    expect(defaultFakeSite().landingUrl).not.toBe(observation.url);
  });
});
