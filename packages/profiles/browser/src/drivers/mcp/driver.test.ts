// The real adapter, running the whole driver conformance suite against a sidecar
// that speaks `@playwright/mcp` 0.0.79's own response shapes. No browser is
// launched, so CI stays deterministic; the live-browser run of the identical
// suite lives in `live.test.ts` behind an env flag.
import { describe, expect, test } from "bun:test";
import { BROWSER_LIMITS } from "../../contracts/json.ts";
import { elementRefOf } from "../../contracts/observation.ts";
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

function contractSetup(): DriverContractSetup {
  let sidecar: ScriptedSidecar | undefined;
  return {
    name: "playwright-mcp (persistent, scripted sidecar)",
    createDriver: () => {
      sidecar = createScriptedSidecar();
      return createMcpBrowserDriver({
        sidecar,
        mode: "persistent",
        browser: "chrome",
        documents: [document],
      });
    },
    connectOptions: { mode: "persistent", browser: "chrome" },
    fixture: FAKE_DRIVER_FIXTURE,
    capabilities: FAKE_DRIVER_CAPABILITIES,
    uploadDocument: document,
    simulateConnectionLoss: async (driver) => (driver as McpBrowserDriver).sever(),
    readSubmissions: async () => sidecar?.submissions() ?? [],
    timeoutMs: 20_000,
  };
}

registerBrowserDriverContract({ describe, test }, contractSetup());

describe("persistent mode runs the complete adapter suite", () => {
  test("persistent mode passes every case, with nothing skipped", async () => {
    const report = await runBrowserDriverContract(contractSetup());
    expect(
      report.results.filter((r) => r.status === "failed").map((r) => `${r.id}: ${r.message}`),
    ).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.passed).toBe(report.results.length);
  }, 120_000);
});

async function connected(
  sidecar: ScriptedSidecar = createScriptedSidecar(),
): Promise<{ driver: McpBrowserDriver; sidecar: ScriptedSidecar; signal: AbortSignal }> {
  const driver = createMcpBrowserDriver({
    sidecar,
    mode: "persistent",
    browser: "chrome",
    documents: [document],
  });
  const signal = new AbortController().signal;
  await driver.connect({ mode: "persistent", browser: "chrome" }, signal);
  return { driver, sidecar, signal };
}

describe("Mu-owned browser shutdown (BD29)", () => {
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
    const { driver } = await connected(recorder);
    await driver.disconnect();
    expect(calls).toContain("browser_close");
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
    });
    const error = await driver
      .connect({ mode: "persistent", browser: "chrome" }, new AbortController().signal)
      .catch((thrown: unknown) => thrown);
    expect((error as { code?: string }).code).toBe("protocol-mismatch");
    expect(String(error)).toContain("Reinstall @mu-agent/browser");
    expect(driver.status().phase).toBe("disconnected");
  });

  test("a severed bridge is a typed, reconnectable failure", async () => {
    const { driver, signal } = await connected();
    driver.sever();
    const error = await driver.observe({}, signal).catch((thrown: unknown) => thrown);
    expect((error as { code?: string }).code).toBe("browser-crashed");
    expect((error as { reconnectable?: boolean }).reconnectable).toBe(true);
  });
});

describe("the raw tool surface stays behind the adapter", () => {
  test("visual pointer actions map only to the opt-in vision tools and re-observe", async () => {
    const calls: string[] = [];
    const inner = createScriptedSidecar();
    const recorder: ScriptedSidecar = {
      ...inner,
      callTool: async (name, args, options) => {
        calls.push(name);
        return inner.callTool(name, args, options);
      },
    };
    const { driver, signal } = await connected(recorder);
    const outcome = await driver.pointer({ kind: "click", x: 40, y: 30 }, signal);
    expect(outcome.status).toBe("completed");
    expect(calls).toContain("browser_mouse_click_xy");
    expect(calls.indexOf("browser_snapshot")).toBeGreaterThan(
      calls.indexOf("browser_mouse_click_xy"),
    );
  });

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
    const { driver, signal } = await connected(recorder);
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
  test("an oversized driver snapshot remains canonical document order and requests boxes", async () => {
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
    let requestedBoxes = false;
    const inner = createScriptedSidecar({ site });
    const sidecar: ScriptedSidecar = {
      ...inner,
      callTool: async (name, args, options) => {
        if (name === "browser_snapshot") requestedBoxes = args.boxes === true;
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
                })}`,
              },
            ],
          };
        }
        return inner.callTool(name, args, options);
      },
    };
    const { driver, signal } = await connected(sidecar);
    const observation = await driver.observe({ maxNodes: 20 }, signal);
    expect(requestedBoxes).toBe(true);
    expect(observation.elements.slice(1, 4).map((element) => element.label)).toEqual([
      "Model 1",
      "Model 2",
      "Model 3",
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
    expect(observation.screenshotOmitted).toBe("credential");
    expect(JSON.stringify(observation)).not.toContain(FAKE_VALUES.secretMarker);
  });

  test("a requested screenshot reports every non-credential omission reason", async () => {
    const cases = [
      { reason: "unavailable", content: [{ type: "text", text: "no image" }] },
      {
        reason: "unsupported-format",
        content: [{ type: "image", mimeType: "image/webp", data: "AA==" }],
      },
      {
        reason: "too-large",
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "a".repeat(BROWSER_LIMITS.maxScreenshotBase64Chars + 1),
          },
        ],
      },
    ] as const;
    for (const fixture of cases) {
      const inner = createScriptedSidecar();
      const sidecar: ScriptedSidecar = {
        ...inner,
        callTool: async (name, args, options) =>
          name === "browser_take_screenshot"
            ? { content: [...fixture.content] }
            : inner.callTool(name, args, options),
      };
      const { driver, signal } = await connected(sidecar);
      const observation = await driver.observe({ screenshot: "viewport" }, signal);
      expect(observation.screenshot).toBeUndefined();
      expect(observation.screenshotOmitted).toBe(fixture.reason);
      await driver.disconnect();
    }
  });

  test("targeted scrolling moves only the container, not the page viewport", async () => {
    const { driver, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.dynamic }, signal);
    const before = await driver.observe({}, signal);
    const target = before.elements.find((element) => element.label === FAKE_LABELS.scrollTarget);
    const outcome = await driver.act(
      { kind: "scroll", target: elementRefOf(target as never), deltaX: 0, deltaY: 400 },
      signal,
    );
    const after = await driver.observe({}, signal);
    expect(outcome.status).toBe("completed");
    expect(after.viewport.scrollY).toBe(before.viewport.scrollY);
  });

  test("a page scroll that cannot move reports failure instead of claiming success", async () => {
    const { driver, signal } = await connected();
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.blank }, signal);
    const outcome = await driver.act({ kind: "scroll", deltaX: 0, deltaY: 400 }, signal);
    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("did not move");
  });

  test("a successful scroll waits for consecutive post-scroll snapshots", async () => {
    let afterScrollSnapshots = 0;
    let scrolling = false;
    const inner = createScriptedSidecar();
    const sidecar: ScriptedSidecar = {
      ...inner,
      callTool: async (name, args, options) => {
        if (name === "browser_evaluate" && String(args.function).includes("window.scrollBy")) {
          scrolling = true;
        } else if (scrolling && name === "browser_snapshot") {
          afterScrollSnapshots += 1;
        }
        return inner.callTool(name, args, options);
      },
    };
    const { driver, signal } = await connected(sidecar);
    await driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.dynamic }, signal);
    const outcome = await driver.act({ kind: "scroll", deltaX: 0, deltaY: 400 }, signal);
    expect(outcome.status).toBe("completed");
    expect(afterScrollSnapshots).toBeGreaterThanOrEqual(2);
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
    const { driver, signal } = await connected(createScriptedSidecar({ site }));
    const observation = await driver.observe({}, signal);
    // The document root is still a node; nothing is invented beyond it.
    expect(observation.elements.filter((element) => element.name !== undefined)).toEqual([]);
    expect(observation.url).toBe("https://elsewhere.test/");
    expect(defaultFakeSite().landingUrl).not.toBe(observation.url);
  });
});
