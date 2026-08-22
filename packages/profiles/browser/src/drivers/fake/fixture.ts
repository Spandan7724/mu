// The fake site described in the shape the driver conformance harness consumes.
//
// The types are declared here rather than imported from `testing/`: shipped code
// must not be typed by test scaffolding, and the published declaration bundle
// must not have to carry the harness to stay resolvable. `fixture.test.ts` proves
// these values still satisfy the harness's own types.
import type { AuthorizedDocument } from "../../contracts/documents.ts";
import { authorizedDocumentId } from "../../contracts/primitives.ts";
import {
  FAKE_FRAME_ORIGIN,
  FAKE_GUARD_MESSAGE,
  FAKE_LABELS,
  FAKE_ORIGIN,
  FAKE_PAGE_URLS,
  FAKE_VALUES,
} from "./site.ts";

export interface FakeDriverFixture {
  origin: string;
  pages: Record<
    | "blank"
    | "form"
    | "dynamic"
    | "popup"
    | "dialog"
    | "upload"
    | "download"
    | "frames"
    | "redirect"
    | "redirectTarget"
    | "slow"
    | "submit"
    | "unknownSubmit"
    | "guardedSubmit"
    | "credentials",
    string
  >;
  labels: Record<
    | "textField"
    | "select"
    | "checkbox"
    | "fileField"
    | "submitButton"
    | "popupTrigger"
    | "dialogTrigger"
    | "downloadTrigger"
    | "passwordField"
    | "scrollTarget",
    string
  >;
  values: Record<
    | "text"
    | "selectOption"
    | "slowText"
    | "confirmationText"
    | "downloadBasename"
    | "secretMarker"
    | "guardMessage",
    string
  >;
  crossOriginFrameOrigin?: string | undefined;
}

export const FAKE_DRIVER_FIXTURE: FakeDriverFixture = {
  origin: FAKE_ORIGIN,
  pages: {
    blank: FAKE_PAGE_URLS.blank,
    form: FAKE_PAGE_URLS.form,
    dynamic: FAKE_PAGE_URLS.dynamic,
    popup: FAKE_PAGE_URLS.popup,
    dialog: FAKE_PAGE_URLS.dialog,
    upload: FAKE_PAGE_URLS.upload,
    download: FAKE_PAGE_URLS.download,
    frames: FAKE_PAGE_URLS.frames,
    redirect: FAKE_PAGE_URLS.redirect,
    redirectTarget: FAKE_PAGE_URLS.redirectTarget,
    slow: FAKE_PAGE_URLS.slow,
    submit: FAKE_PAGE_URLS.submit,
    unknownSubmit: FAKE_PAGE_URLS.unknownSubmit,
    guardedSubmit: FAKE_PAGE_URLS.guardedSubmit,
    credentials: FAKE_PAGE_URLS.credentials,
  },
  labels: { ...FAKE_LABELS },
  values: { ...FAKE_VALUES, guardMessage: FAKE_GUARD_MESSAGE },
  crossOriginFrameOrigin: FAKE_FRAME_ORIGIN,
};

// Everything the in-memory site can model honestly. Anything it could not model
// would be declared false, so the harness reports those cases as skipped rather
// than letting the fake pass them vacuously.
export const FAKE_DRIVER_CAPABILITIES = {
  history: true,
  popups: true,
  dialogs: true,
  fileUpload: true,
  downloads: true,
  crossOriginFrames: true,
  screenshots: true,
  crashSimulation: true,
  reconnect: true,
  submissionLedger: true,
  dialogGuard: true,
} as const;

export function fakeUploadDocument(): AuthorizedDocument {
  return {
    id: authorizedDocumentId("doc-fake-resume"),
    // Never read: the fake attaches a basename, it does not open a file.
    path: "/documents/resume.pdf",
    basename: "resume.pdf",
    mimeType: "application/pdf",
    bytes: 12_345,
    sha256: "c".repeat(64),
    purposes: ["upload"],
    addedAt: 1_700_000_000_000,
  };
}
