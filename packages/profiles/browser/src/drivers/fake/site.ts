// The deterministic site the fake driver serves. It is a data model, not HTML: a
// page is a list of semantic controls plus the behaviour a control triggers, which
// is exactly the surface `BrowserDriver` exposes. Every later lane can script one
// of these instead of standing up a browser.
import type { BrowserDialog, BrowserDownload } from "../../contracts/actions.ts";
import type { SubmitIntent } from "../../contracts/intent.ts";
import type {
  BrowserElementBox,
  BrowserElementOption,
  BrowserRisk,
} from "../../contracts/observation.ts";

export const FAKE_ORIGIN = "https://fake.mu-browser.test";
export const FAKE_FRAME_ORIGIN = "https://widgets.mu-browser.test";
export const FAKE_REDIRECT_ORIGIN = "https://redirect.mu-browser.test";

// A 1×1 transparent PNG. Deterministic, tiny, and carries no page content — the
// fake never renders anything, so a screenshot is evidence of the request only.
export const FAKE_SCREENSHOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export type FakeBehavior =
  | { kind: "open-tab"; url: string }
  | { kind: "dialog"; dialogKind: BrowserDialog["kind"]; message: string }
  | { kind: "download"; download: BrowserDownload }
  | {
      kind: "commit";
      intent: SubmitIntent;
      // `unknown` models a lost confirmation: the submission reaches the server
      // and the answer never arrives (BD18).
      confirmation: "confirmed" | "unknown";
      resultUrl: string;
      confirmationText?: string;
      externalId?: string;
      // A confirm() the page raises before it will commit. Dismissing it leaves the
      // commitment undone, so this is the fixture's proof that acceptance is a
      // decision and not a formality.
      guard?: { dialogKind: BrowserDialog["kind"]; message: string };
    };

export interface FakeElementSpec {
  ref: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  description?: string;
  value?: string;
  inputType?: string;
  checked?: boolean;
  options?: BrowserElementOption[];
  risk?: BrowserRisk[];
  box?: BrowserElementBox;
  disabled?: boolean;
  required?: boolean;
  frameId?: string;
  behavior?: FakeBehavior;
  // Present on the page, never observable. Proves the driver reports a redacted
  // credential field rather than filtering the marker out of a serialized answer.
  secretValue?: string;
}

export interface FakeFrameSpec {
  id: string;
  parentId?: string;
  name?: string;
  url: string;
  crossOrigin?: boolean;
}

export interface FakePageSpec {
  url: string;
  title: string;
  summary: string;
  elements: FakeElementSpec[];
  frames?: FakeFrameSpec[];
  // Served instead of this page, as a server-side redirect would be.
  redirectTo?: string;
  // Screenshots are suppressed here (SECURITY §11).
  credential?: boolean;
  // Free text `wait({condition:"text"})` matches against.
  text?: string[];
  contentHeight?: number;
}

export interface FakeSite {
  origin: string;
  landingUrl: string;
  pages: ReadonlyMap<string, FakePageSpec>;
}

export function fakeSite(pages: readonly FakePageSpec[], landingUrl: string): FakeSite {
  const map = new Map<string, FakePageSpec>();
  for (const page of pages) map.set(page.url, page);
  if (!map.has(landingUrl)) throw new Error(`fake site has no landing page at ${landingUrl}`);
  return { origin: FAKE_ORIGIN, landingUrl, pages: map };
}

const url = (path: string): string => `${FAKE_ORIGIN}${path}`;

export const FAKE_PAGE_URLS = {
  blank: url("/blank"),
  form: url("/form"),
  dynamic: url("/dynamic"),
  popup: url("/popup"),
  popupTarget: url("/popup/opened"),
  dialog: url("/dialog"),
  upload: url("/upload"),
  download: url("/download"),
  frames: url("/frames"),
  redirect: url("/redirect"),
  redirectTarget: `${FAKE_REDIRECT_ORIGIN}/landed`,
  slow: url("/slow"),
  submit: url("/submit"),
  submitted: url("/submit/received"),
  failedSubmit: url("/submit/rejected-form"),
  failedSubmitted: url("/submit/rejected"),
  guardedSubmit: url("/submit/guarded"),
  unknownSubmit: url("/submit/ambiguous"),
  unknownSubmitted: url("/submit/ambiguous/pending"),
  credentials: url("/login"),
} as const;

export const FAKE_LABELS = {
  textField: "Full name",
  select: "Country",
  checkbox: "Willing to relocate",
  fileField: "Resume",
  submitButton: "Submit application",
  popupTrigger: "Open in a new tab",
  dialogTrigger: "Show a notice",
  downloadTrigger: "Download offer",
  passwordField: "Password",
  scrollTarget: "Details",
} as const;

export const FAKE_GUARD_MESSAGE = "This will send your application. Continue?";

export const FAKE_VALUES = {
  text: "Ada Lovelace",
  selectOption: "Ireland",
  slowText: "Loaded",
  confirmationText: "Your application was received.",
  downloadBasename: "offer.pdf",
  secretMarker: "sekrit-marker-value",
} as const;

const textbox = (ref: string, label: string): FakeElementSpec => ({
  ref,
  role: "textbox",
  name: label,
  label,
  inputType: "text",
  value: "",
});

function formElements(): FakeElementSpec[] {
  return [
    textbox("e1", FAKE_LABELS.textField),
    {
      ref: "e2",
      role: "combobox",
      name: FAKE_LABELS.select,
      label: FAKE_LABELS.select,
      inputType: "select-one",
      options: [
        { label: "Ireland", value: "Ireland" },
        { label: "Portugal", value: "Portugal" },
        { label: "Japan", value: "Japan" },
      ],
    },
    {
      ref: "e3",
      role: "checkbox",
      name: FAKE_LABELS.checkbox,
      label: FAKE_LABELS.checkbox,
      inputType: "checkbox",
      checked: false,
    },
    {
      ref: "e4",
      role: "textbox",
      name: "Notes",
      label: "Notes",
      inputType: "text",
      value: "",
    },
    {
      ref: "e5",
      role: "textbox",
      name: "Portfolio URL",
      label: "Portfolio URL",
      inputType: "text",
      value: "",
    },
    {
      ref: "e6",
      role: "textbox",
      name: "Referral",
      label: "Referral",
      inputType: "text",
      value: "",
    },
    {
      ref: "e7",
      role: "textbox",
      name: "Availability",
      label: "Availability",
      inputType: "text",
      value: "",
    },
  ];
}

// The site every conformance run and every later lane's default test uses.
export function defaultFakeSite(): FakeSite {
  const pages: FakePageSpec[] = [
    {
      url: FAKE_PAGE_URLS.blank,
      title: "Blank",
      summary: "An empty landing page.",
      text: ["Nothing here yet."],
      elements: [
        { ref: "b1", role: "heading", name: "Blank", label: "Blank" },
        { ref: "b2", role: "link", name: "Start", label: "Start" },
      ],
    },
    {
      url: FAKE_PAGE_URLS.form,
      title: "Application form",
      summary: "An application form with seven controls.",
      text: ["Application form", FAKE_VALUES.slowText],
      elements: formElements(),
    },
    {
      url: FAKE_PAGE_URLS.dynamic,
      title: "Dynamic page",
      summary: "A long page whose details section can be hovered and clicked.",
      contentHeight: 4_000,
      text: ["Dynamic page"],
      elements: [
        {
          ref: "d1",
          role: "button",
          name: FAKE_LABELS.scrollTarget,
          label: FAKE_LABELS.scrollTarget,
        },
        { ref: "d2", role: "heading", name: "Dynamic", label: "Dynamic" },
      ],
    },
    {
      url: FAKE_PAGE_URLS.popup,
      title: "Popup launcher",
      summary: "A page that opens a second tab.",
      elements: [
        {
          ref: "p1",
          role: "button",
          name: FAKE_LABELS.popupTrigger,
          label: FAKE_LABELS.popupTrigger,
          behavior: { kind: "open-tab", url: FAKE_PAGE_URLS.popupTarget },
        },
      ],
    },
    {
      url: FAKE_PAGE_URLS.popupTarget,
      title: "Opened in a new tab",
      summary: "The page a popup lands on.",
      elements: [{ ref: "pt1", role: "heading", name: "Popup", label: "Popup" }],
    },
    {
      url: FAKE_PAGE_URLS.dialog,
      title: "Dialog page",
      summary: "A page that raises a native dialog.",
      elements: [
        {
          ref: "g1",
          role: "button",
          name: FAKE_LABELS.dialogTrigger,
          label: FAKE_LABELS.dialogTrigger,
          behavior: { kind: "dialog", dialogKind: "alert", message: "Your session expires soon." },
        },
      ],
    },
    {
      url: FAKE_PAGE_URLS.upload,
      title: "Upload page",
      summary: "A page with one file input.",
      elements: [
        {
          ref: "u1",
          role: "button",
          name: FAKE_LABELS.fileField,
          label: FAKE_LABELS.fileField,
          inputType: "file",
          value: "",
        },
      ],
    },
    {
      url: FAKE_PAGE_URLS.download,
      title: "Download page",
      summary: "A page offering one file.",
      elements: [
        {
          ref: "w1",
          role: "button",
          name: FAKE_LABELS.downloadTrigger,
          label: FAKE_LABELS.downloadTrigger,
          risk: ["download"],
          behavior: {
            kind: "download",
            download: {
              basename: FAKE_VALUES.downloadBasename,
              bytes: 2_048,
              sha256: "b".repeat(64),
            },
          },
        },
      ],
    },
    {
      url: FAKE_PAGE_URLS.frames,
      title: "Frames page",
      summary: "A page with a same-origin frame and a cross-origin widget.",
      frames: [
        { id: "frame-main", name: "content", url: url("/frames/content") },
        {
          id: "frame-widget",
          parentId: "frame-main",
          name: "widget",
          url: `${FAKE_FRAME_ORIGIN}/widget`,
          crossOrigin: true,
        },
      ],
      elements: [
        {
          ref: "f1",
          role: "heading",
          name: "Frames",
          label: "Frames",
          frameId: "frame-main",
        },
        {
          ref: "f2",
          role: "button",
          name: "Accept widget",
          label: "Accept widget",
          frameId: "frame-widget",
        },
      ],
    },
    {
      url: FAKE_PAGE_URLS.redirect,
      title: "Redirecting",
      summary: "Redirects elsewhere.",
      redirectTo: FAKE_PAGE_URLS.redirectTarget,
      elements: [],
    },
    {
      url: FAKE_PAGE_URLS.redirectTarget,
      title: "Landed",
      summary: "The redirect destination on another origin.",
      elements: [{ ref: "r1", role: "heading", name: "Landed", label: "Landed" }],
    },
    {
      url: FAKE_PAGE_URLS.slow,
      title: "Slow page",
      summary: "A page whose content arrives late.",
      text: [FAKE_VALUES.slowText],
      elements: [{ ref: "s1", role: "heading", name: "Slow", label: "Slow" }],
    },
    {
      url: FAKE_PAGE_URLS.submit,
      title: "Review and submit",
      summary: "A completed application awaiting submission.",
      elements: [
        textbox("m1", FAKE_LABELS.textField),
        {
          ref: "m2",
          role: "button",
          name: FAKE_LABELS.submitButton,
          label: FAKE_LABELS.submitButton,
          inputType: "submit",
          risk: ["submit"],
          behavior: {
            kind: "commit",
            intent: "submit-form",
            confirmation: "confirmed",
            resultUrl: FAKE_PAGE_URLS.submitted,
            confirmationText: FAKE_VALUES.confirmationText,
            externalId: "APP-4711",
          },
        },
      ],
    },
    {
      url: FAKE_PAGE_URLS.guardedSubmit,
      title: "Review and submit, with a confirmation",
      summary: "A completed application whose submit control asks before it sends.",
      elements: [
        textbox("g1", FAKE_LABELS.textField),
        {
          ref: "g2",
          role: "button",
          name: FAKE_LABELS.submitButton,
          label: FAKE_LABELS.submitButton,
          inputType: "submit",
          risk: ["submit"],
          behavior: {
            kind: "commit",
            intent: "submit-form",
            confirmation: "confirmed",
            resultUrl: FAKE_PAGE_URLS.submitted,
            confirmationText: FAKE_VALUES.confirmationText,
            externalId: "APP-4712",
            guard: { dialogKind: "confirm", message: FAKE_GUARD_MESSAGE },
          },
        },
      ],
    },
    {
      url: FAKE_PAGE_URLS.submitted,
      title: "Application received",
      summary: FAKE_VALUES.confirmationText,
      text: [FAKE_VALUES.confirmationText, "APP-4711"],
      elements: [
        {
          ref: "c1",
          role: "heading",
          name: FAKE_VALUES.confirmationText,
          label: FAKE_VALUES.confirmationText,
        },
      ],
    },
    {
      url: FAKE_PAGE_URLS.failedSubmit,
      title: "Review a rejected submission",
      summary: "A form whose server returns an explicit semantic failure.",
      elements: [
        {
          ref: "x1",
          role: "button",
          name: FAKE_LABELS.submitButton,
          label: FAKE_LABELS.submitButton,
          inputType: "submit",
          risk: ["submit"],
          behavior: {
            kind: "commit",
            intent: "submit-form",
            confirmation: "confirmed",
            resultUrl: FAKE_PAGE_URLS.failedSubmitted,
          },
        },
      ],
    },
    {
      url: FAKE_PAGE_URLS.failedSubmitted,
      title: "Application not submitted",
      summary: "The server rejected the application.",
      elements: [
        {
          ref: "x2",
          role: "alert",
          name: "We could not submit your application. No application was created.",
          label: "We could not submit your application. No application was created.",
        },
      ],
    },
    {
      url: FAKE_PAGE_URLS.unknownSubmit,
      title: "Review and submit",
      summary: "A submission whose confirmation never arrives.",
      elements: [
        {
          ref: "a1",
          role: "button",
          name: FAKE_LABELS.submitButton,
          label: FAKE_LABELS.submitButton,
          inputType: "submit",
          risk: ["submit"],
          behavior: {
            kind: "commit",
            intent: "submit-form",
            confirmation: "unknown",
            resultUrl: FAKE_PAGE_URLS.unknownSubmitted,
          },
        },
      ],
    },
    {
      url: FAKE_PAGE_URLS.unknownSubmitted,
      title: "Still processing",
      summary: "The server accepted the request but reported nothing.",
      elements: [],
    },
    {
      url: FAKE_PAGE_URLS.credentials,
      title: "Sign in",
      summary: "A sign-in page. Its password field is a takeover boundary.",
      credential: true,
      elements: [
        textbox("l1", "Email"),
        {
          ref: "l2",
          role: "textbox",
          name: FAKE_LABELS.passwordField,
          label: FAKE_LABELS.passwordField,
          inputType: "password",
          risk: ["password"],
          secretValue: FAKE_VALUES.secretMarker,
        },
      ],
    },
  ];
  return fakeSite(pages, FAKE_PAGE_URLS.blank);
}
