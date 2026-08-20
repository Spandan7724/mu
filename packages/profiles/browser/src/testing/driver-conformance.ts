import {
  type ActionOutcome,
  actionOutcomeSchema,
  type BrowserAction,
  type NavigateRequest,
  type ObserveRequest,
  type SubmitRequest,
  type UploadRequest,
  type WaitRequest,
} from "../contracts/actions.ts";
import type { BrowserDriver } from "../contracts/driver.ts";
import { assertJsonSerializable } from "../contracts/json.ts";
import {
  type BrowserElement,
  type BrowserObservation,
  browserObservationSchema,
} from "../contracts/observation.ts";
import { type TabOutcome, type TabRequest, tabOutcomeSchema } from "../contracts/tabs.ts";
import { fail } from "./assert.ts";
import { BROWSER_DRIVER_CONTRACT_CASES } from "./conformance-cases.ts";
import type {
  ContractTestRunner,
  DriverCapability,
  DriverContractCase,
  DriverContractCaseResult,
  DriverContractContext,
  DriverContractGroup,
  DriverContractReport,
  DriverContractSetup,
} from "./conformance-types.ts";

export { BROWSER_DRIVER_CONTRACT_CASES } from "./conformance-cases.ts";
export * from "./conformance-types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

export function supportsCapability(
  setup: DriverContractSetup,
  capability: DriverCapability,
): boolean {
  return setup.capabilities?.[capability] === true;
}

export function missingCapabilities(
  setup: DriverContractSetup,
  testCase: DriverContractCase,
): DriverCapability[] {
  return (testCase.requires ?? []).filter((capability) => !supportsCapability(setup, capability));
}

interface ContractSchema {
  safeParse(
    value: unknown,
  ):
    | { success: true }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } };
}

function validate<T>(schema: ContractSchema, value: T, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    fail(`${what} does not satisfy its contract schema: ${issues}`);
  }
  assertJsonSerializable(value, what);
  return value;
}

function matches(element: BrowserElement, label: string): boolean {
  const needle = label.toLowerCase();
  for (const candidate of [element.label, element.name, element.placeholder, element.description]) {
    if (candidate !== undefined && candidate.toLowerCase() === needle) return true;
  }
  return false;
}

function looselyMatches(element: BrowserElement, label: string): boolean {
  const needle = label.toLowerCase();
  for (const candidate of [element.label, element.name, element.placeholder, element.description]) {
    if (candidate?.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function createContext(
  driver: BrowserDriver,
  setup: DriverContractSetup,
  signal: AbortSignal,
): DriverContractContext {
  const observe = async (request: ObserveRequest = {}): Promise<BrowserObservation> =>
    validate(browserObservationSchema, await driver.observe(request, signal), "observation");
  const outcome = (value: ActionOutcome, what: string): ActionOutcome =>
    validate(actionOutcomeSchema, value, what);
  const tabs = async (request: TabRequest): Promise<TabOutcome> =>
    validate(tabOutcomeSchema, await driver.tabs(request, signal), "tab outcome");

  const findOptional = (
    observation: BrowserObservation,
    label: string,
  ): BrowserElement | undefined =>
    observation.elements.find((element) => matches(element, label)) ??
    observation.elements.find((element) => looselyMatches(element, label));

  return {
    driver,
    setup,
    fixture: setup.fixture,
    signal,
    observe,
    tabs,
    navigate: async (request: NavigateRequest) =>
      outcome(await driver.navigate(request, signal), "navigate outcome"),
    act: async (request: BrowserAction) =>
      outcome(await driver.act(request, signal), "act outcome"),
    submit: async (request: SubmitRequest) =>
      outcome(await driver.submit(request, signal), "submit outcome"),
    upload: async (request: UploadRequest) =>
      outcome(await driver.upload(request, signal), "upload outcome"),
    wait: async (request: WaitRequest) =>
      outcome(await driver.wait(request, signal), "wait outcome"),
    open: async (url: string) => {
      const result = outcome(
        await driver.navigate({ kind: "url", url }, signal),
        "navigate outcome",
      );
      if (result.status !== "completed") fail(`could not open ${url}: ${result.message}`);
      return observe();
    },
    findOptional,
    find: (observation, label) => {
      const element = findOptional(observation, label);
      if (element === undefined) {
        const seen = observation.elements
          .map((entry) => entry.label ?? entry.name ?? entry.role ?? entry.ref)
          .join(", ");
        fail(`no element labelled ${JSON.stringify(label)} in the observation; saw: ${seen}`);
      }
      return element;
    },
  };
}

// Runs one case end to end: fresh driver, connected unless the case drives the
// connection itself, and always torn down.
export async function executeContractCase(
  setup: DriverContractSetup,
  testCase: DriverContractCase,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), setup.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const driver = await setup.createDriver();
  try {
    await setup.resetFixture?.();
    if (testCase.managesConnection !== true) {
      await driver.connect(setup.connectOptions, controller.signal);
    }
    await testCase.run(createContext(driver, setup, controller.signal));
  } finally {
    clearTimeout(timer);
    try {
      await driver.disconnect();
    } catch {
      // Teardown failures must not mask the assertion that already failed.
    }
    try {
      await setup.teardown?.(driver);
    } catch {
      // As above.
    }
  }
}

// Framework-free execution, for release qualification and for proving the suite
// detects a non-conforming driver rather than passing vacuously.
export async function runBrowserDriverContract(
  setup: DriverContractSetup,
  options: { filter?: ((testCase: DriverContractCase) => boolean) | undefined } = {},
): Promise<DriverContractReport> {
  const results: DriverContractCaseResult[] = [];
  for (const testCase of BROWSER_DRIVER_CONTRACT_CASES) {
    if (options.filter && !options.filter(testCase)) continue;
    const missing = missingCapabilities(setup, testCase);
    const started = Date.now();
    if (missing.length > 0) {
      results.push({
        id: testCase.id,
        group: testCase.group,
        title: testCase.title,
        status: "skipped",
        message: `unsupported: ${missing.join(", ")}`,
        durationMs: 0,
      });
      continue;
    }
    try {
      await executeContractCase(setup, testCase);
      results.push({
        id: testCase.id,
        group: testCase.group,
        title: testCase.title,
        status: "passed",
        durationMs: Date.now() - started,
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        group: testCase.group,
        title: testCase.title,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      });
    }
  }
  return {
    setup: setup.name,
    results,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
}

// Registers the same cases with bun:test, vitest or jest. Every driver
// implementation calls this with its own factory and runs the suite unchanged.
export function registerBrowserDriverContract(
  runner: ContractTestRunner,
  setup: DriverContractSetup,
): void {
  const groups = new Map<DriverContractGroup, DriverContractCase[]>();
  for (const testCase of BROWSER_DRIVER_CONTRACT_CASES) {
    const bucket = groups.get(testCase.group);
    if (bucket) bucket.push(testCase);
    else groups.set(testCase.group, [testCase]);
  }
  runner.describe(`browser driver contract: ${setup.name}`, () => {
    for (const [group, cases] of groups) {
      runner.describe(group, () => {
        for (const testCase of cases) {
          const missing = missingCapabilities(setup, testCase);
          if (missing.length > 0) {
            runner.test(`${testCase.title} (skipped: needs ${missing.join(", ")})`, () => {});
            continue;
          }
          runner.test(testCase.title, () => executeContractCase(setup, testCase));
        }
      });
    }
  });
}
