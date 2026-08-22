import { describe, expect, test } from "bun:test";
import { elementRefOf, refValidity } from "../contracts/observation.ts";
import { SAMPLE_TAB_ID, SAMPLE_URL, sampleObservation } from "../testing/samples.ts";
import {
  BrowserTakeoverSession,
  NEVER_TYPE_HERE,
  renderResumeReport,
  renderTakeoverCell,
  TakeoverError,
} from "./takeover.ts";

const observation = sampleObservation();

function session(): BrowserTakeoverSession {
  let clock = 1_700_000_000_000;
  return new BrowserTakeoverSession(() => {
    clock += 1_000;
    return clock;
  });
}

describe("takeover is a session state, not an error", () => {
  test("beginning it records the reason, the tab and what to do", () => {
    const takeover = session();
    const state = takeover.begin({
      reason: "login",
      tabId: SAMPLE_TAB_ID,
      url: `${SAMPLE_URL}/login`,
      revision: observation.revision,
    });
    expect(takeover.active).toBe(true);
    expect(state.reason).toBe("login");
    expect(state.tabId).toBe(SAMPLE_TAB_ID);
    expect(state.instructions).toContain("visible browser");
  });

  test("automation stops issuing page mutations while it is active", () => {
    const takeover = session();
    expect(takeover.mayIssuePageMutation()).toBe(true);
    takeover.begin({ reason: "captcha", tabId: SAMPLE_TAB_ID, url: SAMPLE_URL, revision: 3 });
    expect(takeover.mayIssuePageMutation()).toBe(false);
    takeover.resume(sampleObservation({ revision: 4 }));
    expect(takeover.mayIssuePageMutation()).toBe(true);
  });

  test("a second takeover is refused rather than silently replacing the first", () => {
    const takeover = session();
    takeover.begin({ reason: "login", tabId: SAMPLE_TAB_ID, url: SAMPLE_URL });
    expect(() => takeover.begin({ reason: "mfa", tabId: SAMPLE_TAB_ID, url: SAMPLE_URL })).toThrow(
      TakeoverError,
    );
  });

  test("resuming without a takeover is refused", () => {
    expect(() => session().resume(observation)).toThrow(TakeoverError);
  });
});

describe("no secret is captured or solicited", () => {
  test("screenshots are suspended for every credential-class reason", () => {
    for (const reason of ["password", "passkey", "mfa", "captcha", "login"] as const) {
      const takeover = session();
      takeover.begin({ reason, tabId: SAMPLE_TAB_ID, url: SAMPLE_URL });
      expect(takeover.mayCaptureScreenshot()).toBe(false);
    }
  });

  test("a non-credential takeover keeps its visual help", () => {
    const takeover = session();
    takeover.begin({ reason: "unsupported-ui", tabId: SAMPLE_TAB_ID, url: SAMPLE_URL });
    expect(takeover.mayCaptureScreenshot()).toBe(true);
  });

  test("a credential takeover says explicitly not to type it into Mu", () => {
    const takeover = session();
    const state = takeover.begin({ reason: "password", tabId: SAMPLE_TAB_ID, url: SAMPLE_URL });
    const rendered = renderTakeoverCell(state).join("\n");
    expect(rendered).toContain(NEVER_TYPE_HERE);
    expect(rendered).toContain("never here");
  });

  test("the cell never echoes a value, only the reason and the destination", () => {
    const takeover = session();
    const state = takeover.begin({
      reason: "mfa",
      tabId: SAMPLE_TAB_ID,
      url: `${SAMPLE_URL}/verify`,
      instructions: "Enter the code we sent you: 123456",
    });
    const rendered = renderTakeoverCell(state, { expanded: true }).join("\n");
    expect(rendered).toContain("one-time code");
    expect(rendered).toContain("screenshots are suspended");
    expect(rendered).toContain(NEVER_TYPE_HERE);
  });
});

describe("resume forces a fresh observation and invalidates every prior ref", () => {
  test("an observation at the same revision is refused as not a re-observation", () => {
    const takeover = session();
    takeover.begin({
      reason: "login",
      tabId: SAMPLE_TAB_ID,
      url: SAMPLE_URL,
      revision: observation.revision,
    });
    expect(() => takeover.resume(observation)).toThrow(/observe the page again/);
    expect(takeover.active).toBe(true);
  });

  test("refs minted before the takeover are invalid against the resumed observation", () => {
    const takeover = session();
    const beforeRef = elementRefOf(observation.elements[0] as never);
    takeover.begin({
      reason: "login",
      tabId: SAMPLE_TAB_ID,
      url: SAMPLE_URL,
      revision: observation.revision,
    });
    const resumed = sampleObservation({
      revision: observation.revision + 1,
      elements: observation.elements.map((element) => ({
        ...element,
        revision: observation.revision + 1,
      })),
    });
    const report = takeover.resume(resumed);
    expect(report.reobserved).toBe(true);
    expect(report.revision).toBe(observation.revision + 1);
    expect(refValidity(beforeRef, resumed)).toBe("stale-revision");
    expect(takeover.isRefInvalidated(beforeRef)).toBe(true);
    expect(takeover.invalidatedRevisions).toContain(observation.revision);
  });

  test("a ref from the resumed observation is current again", () => {
    const takeover = session();
    takeover.begin({ reason: "login", tabId: SAMPLE_TAB_ID, url: SAMPLE_URL, revision: 3 });
    const resumed = sampleObservation({
      revision: 4,
      elements: observation.elements.map((element) => ({ ...element, revision: 4 })),
    });
    takeover.resume(resumed);
    expect(refValidity(elementRefOf(resumed.elements[0] as never), resumed)).toBe("current");
    expect(takeover.isRefInvalidated(elementRefOf(resumed.elements[0] as never))).toBe(false);
  });

  test("the report says what the user must know and preserves their edits", () => {
    const takeover = session();
    takeover.begin({
      reason: "user-requested",
      tabId: SAMPLE_TAB_ID,
      url: SAMPLE_URL,
      revision: 3,
    });
    const rendered = renderResumeReport(takeover.resume(sampleObservation({ revision: 4 }))).join(
      "\n",
    );
    expect(rendered).toContain("resumed");
    expect(rendered).toContain("revision 4");
    expect(rendered).toContain("stale");
    expect(rendered).toContain("preserved");
  });
});

describe("the takeover cell says which window is waiting", () => {
  const takeover = session();
  const state = takeover.begin({
    reason: "captcha",
    tabId: SAMPLE_TAB_ID,
    url: `${SAMPLE_URL}/check`,
    revision: 3,
  });

  test("compact names the wait and how to come back", () => {
    const lines = renderTakeoverCell(state);
    expect(lines[0]).toContain("waiting for you in the browser");
    expect(lines.at(-1)).toContain("/browser resume");
  });

  test("expanded names the reason, the tab and the affected origin", () => {
    const rendered = renderTakeoverCell(state, { expanded: true }).join("\n");
    expect(rendered).toContain("reason · captcha");
    expect(rendered).toContain(SAMPLE_TAB_ID);
    expect(rendered).toContain(`${SAMPLE_URL}/check`);
  });

  test("the resume affordance is a command, so it works without a mouse", () => {
    const rendered = renderTakeoverCell(state, { resumeCommand: "/resume-browser" }).join("\n");
    expect(rendered).toContain("/resume-browser");
  });

  test("Mu never claims to solve the challenge itself", () => {
    expect(state.instructions).toContain("does not solve or bypass");
  });
});
