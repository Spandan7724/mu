// The loopback web fixture, described in the shape the driver conformance harness
// consumes. Both the persistent and the extension adapter run the identical suite
// against it, which is what stops them inventing different semantics for the same
// page behaviour.
//
// Pages and labels here are the real ones served by `@mu/browser-fixture`; nothing
// is stubbed. It is a data file rather than a test so a release qualification can
// import it too.
export interface LiveFixtureOrigins {
  origin: string;
  crossOrigin: string;
}

export interface LiveContractFixture {
  origin: string;
  pages: Record<string, string>;
  labels: Record<string, string>;
  values: Record<string, string>;
  crossOriginFrameOrigin?: string | undefined;
}

// A marker that appears nowhere on the fixture. An observation that contained it
// would mean the adapter had invented page content.
export const LIVE_SECRET_MARKER = "sekrit-marker-value";

export function liveContractFixture(origins: LiveFixtureOrigins): LiveContractFixture {
  const at = (path: string): string => `${origins.origin}${path}`;
  return {
    origin: origins.origin,
    pages: {
      blank: at("/"),
      // A form with a text field, a select and a toggle, and deliberately no
      // password field: a page carrying one is never screenshotted.
      form: at("/apply"),
      // Long enough to scroll, and carrying a switch that can be hovered and
      // clicked without committing anything.
      dynamic: at("/fields/all"),
      popup: at("/dialogs"),
      dialog: at("/dialogs"),
      upload: at("/uploads"),
      download: at("/uploads"),
      frames: at("/frames/cross-origin"),
      redirect: at("/flaky/redirect"),
      redirectTarget: at("/flaky/redirect-target"),
      slow: at("/flaky/slow"),
      submit: at("/outcome/confirmed"),
      // Records the side effect and then never finishes the response, so the
      // client genuinely cannot know (BD18).
      unknownSubmit: at("/outcome/ambiguous"),
      credentials: at("/auth/login"),
    },
    labels: {
      textField: "First name",
      select: "Country",
      checkbox: "Open to relocation",
      fileField: "Document",
      submitButton: "Submit",
      popupTrigger: "Open in a new tab",
      dialogTrigger: "Show alert",
      downloadTrigger: "ada-testwell-resume.pdf",
      passwordField: "Password",
      scrollTarget: "Enable notifications",
    },
    values: {
      text: "Ada Lovelace",
      selectOption: "India",
      slowText: "Slow page",
      confirmationText: "Application received.",
      downloadBasename: "ada-testwell-resume.pdf",
      secretMarker: LIVE_SECRET_MARKER,
    },
    crossOriginFrameOrigin: origins.crossOrigin,
  };
}
