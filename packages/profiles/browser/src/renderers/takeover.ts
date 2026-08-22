// DESIGN.md §Human Takeover: a first-class session state, not an error. The runtime
// owns the connection phase; this owns what the person is told, what automation is
// allowed to do while they hold the browser, and what resuming costs.
//
// SECURITY §8 is enforced here rather than described: automation issues no page
// mutation during a takeover, no screenshot is captured while a secret is on screen,
// and every reference minted before the takeover is invalid afterwards because
// resume re-observes at a new revision.
import type { BrowserElementRef, BrowserObservation } from "../contracts/observation.ts";
import {
  suppressesScreenshots,
  type TakeoverReason,
  type TakeoverState,
} from "../contracts/takeover.ts";
import { resumeRequirements, takeoverInstructions } from "../policy/takeover.ts";
import { clampLine, joinParts, safeLines } from "./text.ts";

/**
 * BD14/SECURITY §8. A takeover exists because the user, not Mu, must supply
 * something — so the composer is never where it is supplied. This line is attached
 * to every credential-class takeover.
 */
export const NEVER_TYPE_HERE =
  "Type it in the browser, never here. Mu will not accept a password, passkey, one-time code or security answer in the composer.";

const REASON_HEADLINE: Record<TakeoverReason, string> = {
  login: "sign in",
  password: "enter your password",
  passkey: "complete the passkey prompt",
  mfa: "enter your one-time code",
  captcha: "complete the challenge",
  "ambiguous-action": "choose the right control",
  "unsupported-ui": "operate this interface",
  "user-requested": "take the browser",
};

export interface TakeoverBeginInput {
  reason: TakeoverReason;
  tabId: string;
  url: string;
  /** Overrides the reason's standard wording; the standard text is used otherwise. */
  instructions?: string | undefined;
  /** Revision of the observation that was current when automation stopped. */
  revision?: number | undefined;
  now?: number | undefined;
}

export interface TakeoverResumeReport {
  reason: TakeoverReason;
  observation: BrowserObservation;
  /** Always true: a resume that did not re-observe is not a resume. */
  reobserved: true;
  previousRevision: number | undefined;
  revision: number;
  durationMs: number;
  /** SECURITY §8: resume observes with password values redacted. */
  screenshotsSuppressedDuring: boolean;
}

export class TakeoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TakeoverError";
  }
}

/**
 * The session's takeover state. It is deliberately not the runtime's phase machine:
 * the runtime knows the connection is paused, this knows what the person was asked
 * to do, which window is waiting, and which references died when they took over.
 */
export class BrowserTakeoverSession {
  #state: TakeoverState | undefined;
  #revisionAtStart: number | undefined;
  #invalidatedRevisions = new Set<number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get state(): TakeoverState | undefined {
    return this.#state;
  }

  get active(): boolean {
    return this.#state !== undefined;
  }

  get reason(): TakeoverReason | undefined {
    return this.#state?.reason;
  }

  /** ARCHITECTURE §7: while the user holds the browser, automation stops mutating it. */
  mayIssuePageMutation(): boolean {
    return !this.active;
  }

  /**
   * SECURITY §8: no screenshot while a secret is being entered. A non-credential
   * takeover — an ambiguous control, an unsupported widget — has nothing to hide,
   * so it keeps the visual help.
   */
  mayCaptureScreenshot(): boolean {
    if (this.#state === undefined) return true;
    return !suppressesScreenshots(this.#state.reason);
  }

  begin(input: TakeoverBeginInput): TakeoverState {
    if (this.#state !== undefined) {
      throw new TakeoverError("automation is already paused; resume before pausing again");
    }
    const instructions = clampLine(input.instructions ?? takeoverInstructions(input.reason), 1_000);
    const state: TakeoverState = {
      reason: input.reason,
      instructions,
      startedAt: input.now ?? this.#now(),
      tabId: input.tabId,
      url: input.url,
    };
    this.#state = state;
    this.#revisionAtStart = input.revision;
    if (input.revision !== undefined) this.#invalidatedRevisions.add(input.revision);
    return state;
  }

  /**
   * The fresh observation is the resume. Passing one is not optional, because the
   * only thing that makes a resumed session safe is that nothing survived from
   * before it.
   */
  resume(observation: BrowserObservation): TakeoverResumeReport {
    const state = this.#state;
    if (state === undefined) {
      throw new TakeoverError("automation is not paused; there is nothing to resume");
    }
    const previous = this.#revisionAtStart;
    if (previous !== undefined && observation.revision === previous) {
      throw new TakeoverError(
        "resume must observe the page again; the revision did not change, so every reference would still be stale",
      );
    }
    for (let revision = 0; revision <= (previous ?? -1); revision += 1) {
      this.#invalidatedRevisions.add(revision);
    }
    this.#state = undefined;
    this.#revisionAtStart = undefined;
    return {
      reason: state.reason,
      observation,
      reobserved: true,
      previousRevision: previous,
      revision: observation.revision,
      durationMs: Math.max(0, this.#now() - state.startedAt),
      screenshotsSuppressedDuring: resumeRequirements(state.reason).suppressScreenshotsDuring,
    };
  }

  /**
   * A reference minted before a takeover is dead even if a later observation
   * happens to land on its revision number again. `refValidity` already rejects a
   * stale revision; this remembers the ones the user's own edits invalidated.
   */
  isRefInvalidated(ref: BrowserElementRef): boolean {
    return this.#invalidatedRevisions.has(ref.revision);
  }

  get invalidatedRevisions(): readonly number[] {
    return [...this.#invalidatedRevisions].sort((left, right) => left - right);
  }
}

/**
 * The `Takeover` row of DESIGN.md's tool-cell table: compact says what is waiting
 * and where, expanded says why, on which origin, and what resuming will do.
 */
export function renderTakeoverCell(
  state: TakeoverState,
  options: { expanded?: boolean; resumeCommand?: string } = {},
): string[] {
  const resume = options.resumeCommand ?? "/browser resume";
  const lines = [
    joinParts(["waiting for you in the browser", REASON_HEADLINE[state.reason]]),
    state.instructions,
  ];
  if (suppressesScreenshots(state.reason)) lines.push(NEVER_TYPE_HERE);
  if (options.expanded === true) {
    lines.push(joinParts(["reason", state.reason]));
    lines.push(joinParts(["tab", state.tabId, state.url]));
    lines.push(
      suppressesScreenshots(state.reason)
        ? "screenshots are suspended until you resume"
        : "screenshots continue; this takeover involves no secret",
    );
  }
  lines.push(
    joinParts([
      `${resume} when you are done`,
      "Mu observes the page again first, so anything you changed is what it sees",
    ]),
  );
  return safeLines(lines, [], "a takeover cell");
}

export function renderResumeReport(report: TakeoverResumeReport): string[] {
  return safeLines(
    [
      joinParts([
        "resumed",
        report.observation.url,
        `revision ${report.revision}`,
        `after ${Math.round(report.durationMs / 1000)}s`,
      ]),
      report.previousRevision === undefined
        ? "the page was observed again; every earlier reference is stale"
        : `the page was observed again; every reference from revision ${report.previousRevision} and earlier is stale`,
      "your manual edits are preserved — Mu will not undo them unless you ask",
    ],
    [],
    "a resume report",
  );
}
