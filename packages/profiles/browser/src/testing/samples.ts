import { resolve } from "node:path";
import type { ActionOutcome } from "../contracts/actions.ts";
import type { ApplicantFact, ApplicantProfile } from "../contracts/applicant.ts";
import type { BrowserCarryover } from "../contracts/carryover.ts";
import type { BrowserConnectionState } from "../contracts/connection.ts";
import type { DisclosureRecord } from "../contracts/disclosure.ts";
import type { AuthorizedDocument } from "../contracts/documents.ts";
import type {
  BrowserElement,
  BrowserObservation,
  ObservationRevision,
} from "../contracts/observation.ts";
import { authorizedDocumentId, elementRefId } from "../contracts/primitives.ts";
import type { BrowserReceipt } from "../contracts/receipt.ts";
import type { BrowserFrame, BrowserTab } from "../contracts/tabs.ts";
import type { TakeoverState } from "../contracts/takeover.ts";

// Deterministic, contract-valid values. Unit tests mutate one field at a time to
// prove a schema rejects the mutation; later lanes reuse them as fixtures.
export const SAMPLE_ORIGIN = "https://jobs.example.com";
export const SAMPLE_URL = `${SAMPLE_ORIGIN}/apply`;
export const SAMPLE_SHA256 = "a".repeat(64);
export const SAMPLE_TAB_ID = "tab-1";
export const SAMPLE_CONNECTION_ID = "conn-1";
export const SAMPLE_REVISION: ObservationRevision = 3;

type Override<T> = Partial<T>;

export function sampleTab(overrides: Override<BrowserTab> = {}): BrowserTab {
  return {
    id: SAMPLE_TAB_ID,
    title: "Apply",
    url: SAMPLE_URL,
    origin: SAMPLE_ORIGIN,
    active: true,
    attached: true,
    ...overrides,
  };
}

export function sampleFrame(overrides: Override<BrowserFrame> = {}): BrowserFrame {
  return {
    id: "frame-1",
    name: "application",
    url: `${SAMPLE_ORIGIN}/apply/embedded`,
    origin: SAMPLE_ORIGIN,
    crossOrigin: false,
    ...overrides,
  };
}

export function sampleElement(overrides: Override<BrowserElement> = {}): BrowserElement {
  return {
    ref: elementRefId("e1"),
    revision: SAMPLE_REVISION,
    tabId: SAMPLE_TAB_ID,
    role: "textbox",
    name: "Full name",
    label: "Full name",
    required: true,
    inputType: "text",
    ...overrides,
  };
}

export function sampleObservation(
  overrides: Override<BrowserObservation> = {},
): BrowserObservation {
  return {
    connectionId: SAMPLE_CONNECTION_ID,
    tab: sampleTab(),
    revision: SAMPLE_REVISION,
    observedAt: 1_700_000_000_000,
    title: "Apply",
    url: SAMPLE_URL,
    origin: SAMPLE_ORIGIN,
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    frames: [sampleFrame()],
    summary: "Application form with a name field and a submit button.",
    snapshot: "form\n  textbox 'Full name'\n  button 'Submit application'",
    elements: [
      sampleElement(),
      sampleElement({
        ref: elementRefId("e2"),
        role: "button",
        name: "Submit application",
        label: "Submit application",
        inputType: "submit",
        required: false,
        risk: ["submit"],
      }),
    ],
    risks: ["submit"],
    ...overrides,
  };
}

export function sampleConnectionState(
  overrides: Override<BrowserConnectionState> = {},
): BrowserConnectionState {
  return {
    phase: "ready",
    mode: "extension",
    browser: "chrome",
    connectionId: SAMPLE_CONNECTION_ID,
    activeTabId: SAMPLE_TAB_ID,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function sampleActionOutcome(overrides: Override<ActionOutcome> = {}): ActionOutcome {
  return {
    ok: true,
    status: "completed",
    message: "Filled 'Full name'.",
    before: { tabId: SAMPLE_TAB_ID, revision: SAMPLE_REVISION, url: SAMPLE_URL },
    after: {
      tabId: SAMPLE_TAB_ID,
      revision: SAMPLE_REVISION + 1,
      url: SAMPLE_URL,
      title: "Apply",
    },
    ...overrides,
  };
}

export function sampleDocument(overrides: Override<AuthorizedDocument> = {}): AuthorizedDocument {
  return {
    id: authorizedDocumentId("doc-resume"),
    path: resolve("/documents/resume.pdf"),
    basename: "resume.pdf",
    mimeType: "application/pdf",
    bytes: 12_345,
    sha256: SAMPLE_SHA256,
    purposes: ["upload", "reference"],
    addedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function sampleFact(overrides: Override<ApplicantFact> = {}): ApplicantFact {
  return {
    id: "fact-name",
    field: "full_name",
    value: "Ada Lovelace",
    source: { kind: "user" },
    confidence: "exact",
    sensitivity: "personal",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function sampleApplicantProfile(
  overrides: Override<ApplicantProfile> = {},
): ApplicantProfile {
  return {
    version: 1,
    facts: [sampleFact()],
    policy: { defaultDemographicBehavior: "decline" },
    documents: [sampleDocument()],
    ...overrides,
  };
}

export function sampleDisclosure(overrides: Override<DisclosureRecord> = {}): DisclosureRecord {
  return {
    id: "disc-1",
    origin: SAMPLE_ORIGIN,
    url: SAMPLE_URL,
    factIds: ["fact-name"],
    fieldNames: ["Full name"],
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

export function sampleTakeoverState(overrides: Override<TakeoverState> = {}): TakeoverState {
  return {
    reason: "login",
    instructions: "Sign in to the job board in the visible browser, then resume.",
    startedAt: 1_700_000_000_000,
    tabId: SAMPLE_TAB_ID,
    url: `${SAMPLE_ORIGIN}/login`,
    ...overrides,
  };
}

export function sampleReceipt(overrides: Override<BrowserReceipt> = {}): BrowserReceipt {
  return {
    version: 1,
    id: "receipt-1",
    sessionId: "session-1",
    status: "confirmed",
    intent: "submit-form",
    startedUrl: SAMPLE_URL,
    finalUrl: `${SAMPLE_ORIGIN}/apply/confirmation`,
    origin: SAMPLE_ORIGIN,
    completedAt: "2026-08-20T10:00:00.000Z",
    confirmationText: "Your application was received.",
    externalId: "APP-4711",
    disclosedFactIds: ["fact-name"],
    disclosedFields: ["Full name"],
    uploadedFiles: [
      {
        documentId: authorizedDocumentId("doc-resume"),
        basename: "resume.pdf",
        sha256: SAMPLE_SHA256,
      },
    ],
    ...overrides,
  };
}

export function sampleCarryover(overrides: Override<BrowserCarryover> = {}): BrowserCarryover {
  return {
    connection: { mode: "extension", browser: "chrome", phase: "ready" },
    active: {
      tabId: SAMPLE_TAB_ID,
      url: SAMPLE_URL,
      origin: SAMPLE_ORIGIN,
      title: "Apply",
      revision: SAMPLE_REVISION,
    },
    allowedOrigins: [SAMPLE_ORIGIN],
    completedSteps: ["Opened the application form"],
    outstandingSteps: ["Upload the resume"],
    filledFields: [{ label: "Full name", factId: "fact-name", origin: SAMPLE_ORIGIN }],
    unresolvedQuestions: [],
    uploadedDocumentIds: [],
    ...overrides,
  };
}
