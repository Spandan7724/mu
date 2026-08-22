import type {
  ActionOutcome,
  BrowserAction,
  NavigateRequest,
  ObserveRequest,
  SubmitRequest,
  UploadRequest,
  WaitRequest,
} from "../contracts/actions.ts";
import type { ConnectOptions } from "../contracts/connection.ts";
import type { AuthorizedDocument } from "../contracts/documents.ts";
import type { BrowserDriver } from "../contracts/driver.ts";
import type { BrowserElement, BrowserObservation } from "../contracts/observation.ts";
import type { TabOutcome, TabRequest } from "../contracts/tabs.ts";

// Behaviour a fixture site or a driver may legitimately not provide. A case that
// requires an unsupported capability is skipped and reported as skipped — never
// silently passed.
export type DriverCapability =
  | "history"
  | "popups"
  | "dialogs"
  | "fileUpload"
  | "downloads"
  | "crossOriginFrames"
  | "screenshots"
  | "crashSimulation"
  | "reconnect"
  | "submissionLedger"
  // The fixture has a commitment the page guards with its own confirm(), so
  // dismissing and accepting can be told apart by what reached the server.
  | "dialogGuard";

// URLs and semantic labels of the deterministic fixture site. Every driver runs
// the suite against a site satisfying this description, so the extension-backed
// and persistent-profile adapters cannot diverge on equivalent page behaviour.
export interface DriverContractFixture {
  origin: string;
  pages: {
    blank: string;
    form: string;
    dynamic: string;
    popup: string;
    dialog: string;
    upload: string;
    download: string;
    frames: string;
    redirect: string;
    redirectTarget: string;
    slow: string;
    submit: string;
    unknownSubmit: string;
    credentials: string;
    // Only present when the fixture declares `dialogGuard`.
    guardedSubmit?: string | undefined;
  };
  labels: {
    textField: string;
    select: string;
    checkbox: string;
    fileField: string;
    submitButton: string;
    popupTrigger: string;
    dialogTrigger: string;
    downloadTrigger: string;
    passwordField: string;
    scrollTarget: string;
  };
  values: {
    text: string;
    selectOption: string;
    slowText: string;
    confirmationText: string;
    downloadBasename: string;
    // The exact words of the guarded commitment's confirm(), when there is one.
    guardMessage?: string | undefined;
    // Pre-filled into the credentials page's password field. It must never appear
    // anywhere in an observation.
    secretMarker: string;
  };
  crossOriginFrameOrigin?: string | undefined;
}

// What the fixture server recorded. Assertions use this rather than the page's own
// narrative, so a driver cannot pass by reporting success it did not achieve.
export interface FixtureSubmission {
  path: string;
  fields: Record<string, string>;
  files: { field: string; basename: string; sha256?: string | undefined }[];
}

export interface DriverContractSetup {
  name: string;
  createDriver(): BrowserDriver | Promise<BrowserDriver>;
  connectOptions: ConnectOptions;
  fixture: DriverContractFixture;
  capabilities?: Partial<Record<DriverCapability, boolean>> | undefined;
  // An already-authorized document the upload cases may send.
  uploadDocument?: AuthorizedDocument | undefined;
  // Severs the browser or bridge without a clean disconnect.
  simulateConnectionLoss?: ((driver: BrowserDriver) => Promise<void>) | undefined;
  readSubmissions?: (() => Promise<readonly FixtureSubmission[]>) | undefined;
  resetFixture?: (() => Promise<void>) | undefined;
  teardown?: ((driver: BrowserDriver) => Promise<void>) | undefined;
  timeoutMs?: number | undefined;
}

export interface DriverContractContext {
  driver: BrowserDriver;
  setup: DriverContractSetup;
  fixture: DriverContractFixture;
  signal: AbortSignal;
  // Each wrapper validates the driver's answer against the contract schema and
  // against the serializable/secret-free invariant before returning it.
  observe(request?: ObserveRequest): Promise<BrowserObservation>;
  navigate(request: NavigateRequest): Promise<ActionOutcome>;
  act(request: BrowserAction): Promise<ActionOutcome>;
  submit(request: SubmitRequest): Promise<ActionOutcome>;
  upload(request: UploadRequest): Promise<ActionOutcome>;
  wait(request: WaitRequest): Promise<ActionOutcome>;
  tabs(request: TabRequest): Promise<TabOutcome>;
  open(url: string): Promise<BrowserObservation>;
  find(observation: BrowserObservation, label: string): BrowserElement;
  findOptional(observation: BrowserObservation, label: string): BrowserElement | undefined;
}

export type DriverContractGroup =
  | "connection"
  | "tabs"
  | "navigation"
  | "frames"
  | "observation"
  | "interaction"
  | "dialogs"
  | "files"
  | "downloads"
  | "screenshots"
  | "errors"
  | "evidence";

export interface DriverContractCase {
  id: string;
  group: DriverContractGroup;
  title: string;
  requires?: readonly DriverCapability[] | undefined;
  // Cases that drive connect/disconnect themselves get an unconnected driver.
  managesConnection?: boolean | undefined;
  run(ctx: DriverContractContext): Promise<void>;
}

export interface DriverContractCaseResult {
  id: string;
  group: DriverContractGroup;
  title: string;
  status: "passed" | "failed" | "skipped";
  message?: string | undefined;
  durationMs: number;
}

export interface DriverContractReport {
  setup: string;
  results: DriverContractCaseResult[];
  passed: number;
  failed: number;
  skipped: number;
}

// Structural match for bun:test, vitest and jest.
export interface ContractTestRunner {
  describe(name: string, body: () => void): void;
  test(name: string, body: () => Promise<void> | void): void;
}
