// The fake site, described in the shape the driver conformance harness consumes.
// The imports here are type-only, so nothing from `testing/` reaches a build.
import { resolve } from "node:path";
import type { AuthorizedDocument } from "../../contracts/documents.ts";
import { authorizedDocumentId } from "../../contracts/primitives.ts";
import type { DriverCapability, DriverContractFixture } from "../../testing/conformance-types.ts";
import {
  FAKE_FRAME_ORIGIN,
  FAKE_LABELS,
  FAKE_ORIGIN,
  FAKE_PAGE_URLS,
  FAKE_VALUES,
} from "./site.ts";

export const FAKE_DRIVER_FIXTURE: DriverContractFixture = {
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
    credentials: FAKE_PAGE_URLS.credentials,
  },
  labels: { ...FAKE_LABELS },
  values: { ...FAKE_VALUES },
  crossOriginFrameOrigin: FAKE_FRAME_ORIGIN,
};

// Everything the in-memory site can model honestly. Anything it could not model
// would be declared false so the harness reports those cases as skipped rather
// than letting the fake pass them vacuously.
export const FAKE_DRIVER_CAPABILITIES: Readonly<Record<DriverCapability, boolean>> = {
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
};

export function fakeUploadDocument(): AuthorizedDocument {
  return {
    id: authorizedDocumentId("doc-fake-resume"),
    path: resolve("/documents/resume.pdf"),
    basename: "resume.pdf",
    mimeType: "application/pdf",
    bytes: 12_345,
    sha256: "c".repeat(64),
    purposes: ["upload"],
    addedAt: 1_700_000_000_000,
  };
}
