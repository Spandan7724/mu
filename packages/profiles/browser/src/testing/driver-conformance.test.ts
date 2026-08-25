import { describe, expect, test } from "bun:test";
import type { BrowserConnectionState } from "../contracts/connection.ts";
import { type BrowserDriver, BrowserDriverError } from "../contracts/driver.ts";
import type {
  ContractTestRunner,
  DriverCapability,
  DriverContractFixture,
  DriverContractGroup,
  DriverContractSetup,
} from "./conformance-types.ts";
import {
  BROWSER_DRIVER_CONTRACT_CASES,
  missingCapabilities,
  registerBrowserDriverContract,
  runBrowserDriverContract,
  supportsCapability,
} from "./driver-conformance.ts";

const ORIGIN = "http://127.0.0.1:8931";

const fixture: DriverContractFixture = {
  origin: ORIGIN,
  pages: {
    blank: `${ORIGIN}/blank`,
    form: `${ORIGIN}/form`,
    dynamic: `${ORIGIN}/dynamic`,
    popup: `${ORIGIN}/popup`,
    dialog: `${ORIGIN}/dialog`,
    upload: `${ORIGIN}/upload`,
    download: `${ORIGIN}/download`,
    frames: `${ORIGIN}/frames`,
    redirect: `${ORIGIN}/redirect`,
    redirectTarget: `${ORIGIN}/redirect/target`,
    slow: `${ORIGIN}/slow`,
    submit: `${ORIGIN}/submit`,
    unknownSubmit: `${ORIGIN}/submit/ambiguous`,
    guardedSubmit: `${ORIGIN}/submit/guarded`,
    credentials: `${ORIGIN}/login`,
  },
  labels: {
    textField: "Full name",
    select: "Country",
    checkbox: "Willing to relocate",
    fileField: "Resume",
    submitButton: "Submit application",
    popupTrigger: "Open in a new tab",
    dialogTrigger: "Confirm",
    downloadTrigger: "Download offer",
    passwordField: "Password",
    scrollTarget: "Details",
  },
  values: {
    text: "Ada Lovelace",
    selectOption: "Ireland",
    slowText: "Loaded",
    confirmationText: "Your application was received.",
    downloadBasename: "offer.pdf",
    secretMarker: "sekrit-marker-value",
    guardMessage: "This will send your application. Continue?",
  },
  crossOriginFrameOrigin: "http://127.0.0.1:8932",
};

const ALL_CAPABILITIES: DriverCapability[] = [
  "history",
  "popups",
  "dialogs",
  "fileUpload",
  "downloads",
  "crossOriginFrames",
  "screenshots",
  "crashSimulation",
  "reconnect",
  "submissionLedger",
  "dialogGuard",
];

// A driver that answers nothing. It exists to prove that every case in the suite
// actually asserts something: a suite that passed against this would be vacuous.
function inertDriver(): BrowserDriver {
  const state: BrowserConnectionState = {
    phase: "disconnected",
    mode: "persistent",
    browser: "chrome",
    updatedAt: 0,
  };
  const refuse = async (): Promise<never> => {
    throw new BrowserDriverError("unsupported", "no driver is wired up yet");
  };
  return {
    connect: refuse,
    disconnect: async () => {},
    status: () => state,
    observe: refuse,
    navigate: refuse,
    act: refuse,
    pointer: refuse,
    submit: refuse,
    tabs: refuse,
    upload: refuse,
    wait: refuse,
    takeover: refuse,
    resumeFromTakeover: refuse,
  };
}

function setup(overrides: Partial<DriverContractSetup> = {}): DriverContractSetup {
  return {
    name: "inert",
    createDriver: inertDriver,
    connectOptions: { mode: "persistent", browser: "chrome" },
    fixture,
    capabilities: Object.fromEntries(ALL_CAPABILITIES.map((name) => [name, true])),
    uploadDocument: undefined,
    simulateConnectionLoss: async () => {},
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("driver contract registry", () => {
  test("every case has a unique id", () => {
    const ids = BROWSER_DRIVER_CONTRACT_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every case id is prefixed with its group", () => {
    for (const testCase of BROWSER_DRIVER_CONTRACT_CASES) {
      expect(testCase.id.startsWith(`${testCase.group}/`)).toBe(true);
    }
  });

  test("covers every area TESTING.md section 2 requires", () => {
    const groups = new Set(BROWSER_DRIVER_CONTRACT_CASES.map((testCase) => testCase.group));
    const required: DriverContractGroup[] = [
      "connection",
      "tabs",
      "navigation",
      "frames",
      "observation",
      "interaction",
      "dialogs",
      "files",
      "downloads",
      "screenshots",
      "errors",
      "evidence",
    ];
    for (const group of required) expect(groups.has(group)).toBe(true);
  });

  test("a case only requires capabilities the setup can declare", () => {
    for (const testCase of BROWSER_DRIVER_CONTRACT_CASES) {
      for (const capability of testCase.requires ?? []) {
        expect(ALL_CAPABILITIES).toContain(capability);
      }
    }
  });
});

describe("capability gating", () => {
  test("an undeclared capability is not supported", () => {
    expect(supportsCapability(setup({ capabilities: {} }), "popups")).toBe(false);
    expect(supportsCapability(setup(), "popups")).toBe(true);
  });

  test("cases needing an unsupported capability are reported missing, not run", () => {
    const bare = setup({ capabilities: {} });
    const popupCase = BROWSER_DRIVER_CONTRACT_CASES.find(
      (testCase) => testCase.id === "tabs/popup-becomes-a-controlled-tab",
    );
    expect(popupCase).toBeDefined();
    expect(missingCapabilities(bare, popupCase as never)).toEqual(["popups"]);
    expect(missingCapabilities(setup(), popupCase as never)).toEqual([]);
  });

  test("skipped cases are reported as skipped rather than silently passing", async () => {
    const report = await runBrowserDriverContract(setup({ capabilities: {} }), {
      filter: (testCase) => (testCase.requires ?? []).length > 0,
    });
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBeGreaterThan(0);
    for (const result of report.results) expect(result.status).toBe("skipped");
  });
});

describe("the suite detects a non-conforming driver", () => {
  // Only the case that inspects status() before connecting is satisfiable without
  // a browser. Everything else must fail, or the suite would be vacuous.
  const SATISFIABLE_WITHOUT_A_BROWSER = ["connection/initial-status"];

  test("nothing but the pre-connection status check passes without a real driver", async () => {
    const report = await runBrowserDriverContract(setup());
    expect(report.setup).toBe("inert");
    expect(report.results).toHaveLength(BROWSER_DRIVER_CONTRACT_CASES.length);
    expect(report.skipped).toBe(0);
    const passing = report.results.filter((result) => result.status === "passed");
    expect(passing.map((result) => result.id)).toEqual(SATISFIABLE_WITHOUT_A_BROWSER);
    expect(report.failed).toBe(
      BROWSER_DRIVER_CONTRACT_CASES.length - SATISFIABLE_WITHOUT_A_BROWSER.length,
    );
  }, 30_000);

  test("every failure carries a message naming what went wrong", async () => {
    const report = await runBrowserDriverContract(setup(), {
      filter: (testCase) => testCase.group === "evidence",
    });
    for (const result of report.results) {
      expect(result.status).toBe("failed");
      expect(result.message ?? "").not.toBe("");
    }
  }, 30_000);
});

describe("registration with a test framework", () => {
  test("registers one test per case, grouped, with skips named", () => {
    const registered: { path: string[]; name: string }[] = [];
    const stack: string[] = [];
    const runner: ContractTestRunner = {
      describe(name, body) {
        stack.push(name);
        body();
        stack.pop();
      },
      test(name) {
        registered.push({ path: [...stack], name });
      },
    };
    registerBrowserDriverContract(runner, setup({ capabilities: { popups: false } }));
    expect(registered).toHaveLength(BROWSER_DRIVER_CONTRACT_CASES.length);
    expect(registered.every((entry) => entry.path[0] === "browser driver contract: inert")).toBe(
      true,
    );
    const skipped = registered.filter((entry) => entry.name.includes("skipped: needs"));
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.some((entry) => entry.name.includes("popups"))).toBe(true);
  });
});
