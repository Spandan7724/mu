import {
  type ActionOutcome,
  type ActionStatus,
  mayRetry,
  readDownloadDetails,
} from "../contracts/actions.ts";
import { acceptsModelActions } from "../contracts/connection.ts";
import { type BrowserDriverError, isBrowserDriverError } from "../contracts/driver.ts";
import { assertJsonSerializable, BROWSER_LIMITS } from "../contracts/json.ts";
import {
  type BrowserObservation,
  elementRefOf,
  isCredentialElement,
} from "../contracts/observation.ts";
import { authorizedDocumentId, elementRefId, normalizeOrigin } from "../contracts/primitives.ts";
import { REDACTED } from "../contracts/secret.ts";
import {
  check,
  contains,
  defined,
  equal,
  excludes,
  fail,
  includes,
  oneOf,
  rejects,
} from "./assert.ts";
import type { DriverContractCase, DriverContractContext } from "./conformance-types.ts";

function expectStatus(
  outcome: ActionOutcome,
  allowed: readonly ActionStatus[],
  what: string,
): void {
  oneOf(outcome.status, allowed, `${what} status (${outcome.message})`);
  equal(outcome.ok, outcome.status === "completed", `${what} ok flag`);
}

function driverError(error: unknown, what: string): BrowserDriverError {
  if (!isBrowserDriverError(error)) {
    fail(`${what}: expected a BrowserDriverError, got ${String(error)}`);
  }
  return error;
}

async function submissionCount(ctx: DriverContractContext): Promise<number | undefined> {
  if (!ctx.setup.readSubmissions) return undefined;
  return (await ctx.setup.readSubmissions()).length;
}

const connectionCases: DriverContractCase[] = [
  {
    id: "connection/initial-status",
    group: "connection",
    title: "reports disconnected before any connection is made",
    managesConnection: true,
    async run(ctx) {
      const state = ctx.driver.status();
      equal(state.phase, "disconnected", "initial phase");
      equal(acceptsModelActions(state.phase), false, "disconnected accepts model actions");
      assertJsonSerializable(state, "connection state");
    },
  },
  {
    id: "connection/connect-reaches-ready",
    group: "connection",
    title: "connect resolves to a ready state that status() then reports",
    managesConnection: true,
    async run(ctx) {
      const state = await ctx.driver.connect(ctx.setup.connectOptions, ctx.signal);
      equal(state.phase, "ready", "phase after connect");
      equal(state.mode, ctx.setup.connectOptions.mode, "connection mode");
      equal(state.browser, ctx.setup.connectOptions.browser, "browser family");
      defined(state.connectionId, "connectionId");
      check(state.updatedAt > 0, "updatedAt must be a real timestamp");
      const reported = ctx.driver.status();
      equal(reported.phase, "ready", "status() phase after connect");
      equal(reported.connectionId, state.connectionId, "status() connectionId");
    },
  },
  {
    id: "connection/state-carries-no-secret",
    group: "connection",
    title: "connection state never carries the extension token or an endpoint",
    managesConnection: true,
    async run(ctx) {
      const token = ctx.setup.connectOptions.extensionToken;
      const state = await ctx.driver.connect(ctx.setup.connectOptions, ctx.signal);
      assertJsonSerializable(state, "connection state");
      const serialized = JSON.stringify(state);
      if (token) excludes(serialized, token.reveal(), "serialized connection state");
      excludes(serialized, "ws://", "serialized connection state");
      excludes(serialized, "cookie", "serialized connection state");
    },
  },
  {
    id: "connection/disconnect-is-idempotent",
    group: "connection",
    title: "disconnect returns to disconnected and tolerates a second call",
    managesConnection: true,
    async run(ctx) {
      await ctx.driver.connect(ctx.setup.connectOptions, ctx.signal);
      await ctx.driver.disconnect();
      equal(ctx.driver.status().phase, "disconnected", "phase after disconnect");
      await ctx.driver.disconnect();
      equal(ctx.driver.status().phase, "disconnected", "phase after second disconnect");
    },
  },
  {
    id: "connection/operations-require-a-connection",
    group: "connection",
    title: "operations after disconnect fail with not-connected",
    managesConnection: true,
    async run(ctx) {
      await ctx.driver.connect(ctx.setup.connectOptions, ctx.signal);
      await ctx.driver.disconnect();
      const error = driverError(
        await rejects(() => ctx.driver.observe({}, ctx.signal), "observe after disconnect"),
        "observe after disconnect",
      );
      oneOf(error.code, ["not-connected", "connection-lost"], "error code");
    },
  },
  {
    id: "connection/connect-honours-an-aborted-signal",
    group: "connection",
    title: "connect rejects immediately when its signal is already aborted",
    managesConnection: true,
    async run(ctx) {
      const controller = new AbortController();
      controller.abort();
      const error = await rejects(
        () => ctx.driver.connect(ctx.setup.connectOptions, controller.signal),
        "connect with an aborted signal",
      );
      equal(driverError(error, "aborted connect").code, "aborted", "error code");
      equal(ctx.driver.status().phase, "disconnected", "phase after an aborted connect");
    },
  },
  {
    id: "connection/reconnect-invalidates-references",
    group: "connection",
    title: "a lost connection reconnects and invalidates every earlier reference",
    requires: ["reconnect"],
    managesConnection: true,
    async run(ctx) {
      await ctx.driver.connect(ctx.setup.connectOptions, ctx.signal);
      const before = await ctx.open(ctx.fixture.pages.form);
      const stale = elementRefOf(ctx.find(before, ctx.fixture.labels.textField));
      const lose = defined(ctx.setup.simulateConnectionLoss, "simulateConnectionLoss hook");
      await lose(ctx.driver);
      const error = driverError(
        await rejects(() => ctx.driver.observe({}, ctx.signal), "observe after connection loss"),
        "observe after connection loss",
      );
      oneOf(
        error.code,
        ["connection-lost", "browser-crashed", "not-connected"],
        "error code after connection loss",
      );
      const state = await ctx.driver.connect(ctx.setup.connectOptions, ctx.signal);
      equal(state.phase, "ready", "phase after reconnect");
      const after = await ctx.observe();
      check(after.revision !== stale.revision, "reconnect must produce a new observation revision");
      expectStatus(
        await ctx.act({ kind: "click", target: stale }),
        ["stale", "blocked", "failed"],
        "click on a pre-reconnect reference",
      );
    },
  },
];

const tabCases: DriverContractCase[] = [
  {
    id: "tabs/list-is-consistent",
    group: "tabs",
    title: "list reports at most one active tab and a matching activeTabId",
    async run(ctx) {
      const outcome = await ctx.tabs({ kind: "list" });
      check(outcome.ok, `list must succeed: ${outcome.message}`);
      check(outcome.tabs.length >= 1, "at least one tab must be attached");
      const active = outcome.tabs.filter((tab) => tab.active);
      check(active.length <= 1, "at most one tab may be active");
      if (outcome.activeTabId !== undefined) {
        check(
          outcome.tabs.some((tab) => tab.id === outcome.activeTabId),
          "activeTabId must name a listed tab",
        );
      }
    },
  },
  {
    id: "tabs/open-select-close",
    group: "tabs",
    title: "open, select and close move control between controlled tabs",
    async run(ctx) {
      const before = await ctx.tabs({ kind: "list" });
      const opened = await ctx.tabs({ kind: "open", url: ctx.fixture.pages.blank });
      check(opened.ok, `open must succeed: ${opened.message}`);
      check(opened.tabs.length > before.tabs.length, "open must add a controlled tab");
      const created = defined(
        opened.tabs.find((tab) => !before.tabs.some((old) => old.id === tab.id)),
        "the newly opened tab",
      );
      const selected = await ctx.tabs({ kind: "select", tabId: created.id });
      equal(selected.activeTabId, created.id, "activeTabId after select");
      const closed = await ctx.tabs({ kind: "close", tabId: created.id });
      check(closed.ok, `close must succeed: ${closed.message}`);
      check(
        !closed.tabs.some((tab) => tab.id === created.id),
        "a closed tab must leave the tab list",
      );
    },
  },
  {
    id: "tabs/popup-becomes-a-controlled-tab",
    group: "tabs",
    title: "a popup opened by the page appears as a controlled tab",
    requires: ["popups"],
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.popup);
      const before = await ctx.tabs({ kind: "list" });
      const outcome = await ctx.act({
        kind: "click",
        target: elementRefOf(ctx.find(observation, ctx.fixture.labels.popupTrigger)),
      });
      expectStatus(outcome, ["completed"], "popup trigger click");
      const after = await ctx.tabs({ kind: "list" });
      check(after.tabs.length > before.tabs.length, "the popup must appear as a controlled tab");
    },
  },
  {
    id: "tabs/closing-the-last-attached-tab-disconnects",
    group: "tabs",
    title: "closing the last attached tab disconnects instead of adopting another tab",
    managesConnection: true,
    async run(ctx) {
      await ctx.driver.connect(ctx.setup.connectOptions, ctx.signal);
      let listed = await ctx.tabs({ kind: "list" });
      for (const tab of listed.tabs.filter((entry) => entry.attached)) {
        const outcome = await ctx.tabs({ kind: "close", tabId: tab.id });
        if (!outcome.ok) break;
      }
      const phase = ctx.driver.status().phase;
      oneOf(phase, ["disconnected", "closing", "failed"], "phase after closing every attached tab");
      listed = await ctx.tabs({ kind: "list" }).catch(() => ({ ok: false, tabs: [], message: "" }));
      check(
        listed.tabs.filter((tab) => tab.attached).length === 0,
        "the driver must not adopt an unrelated tab",
      );
    },
  },
];

const navigationCases: DriverContractCase[] = [
  {
    id: "navigation/reports-the-final-url",
    group: "navigation",
    title: "navigating to a URL reports the destination it reached",
    async run(ctx) {
      const outcome = await ctx.navigate({ kind: "url", url: ctx.fixture.pages.form });
      expectStatus(outcome, ["completed"], "navigate");
      const after = defined(outcome.after, "navigate after-snapshot");
      equal(after.url, ctx.fixture.pages.form, "final URL");
      const navigation = defined(outcome.navigation, "navigation report");
      equal(navigation.to, ctx.fixture.pages.form, "navigation.to");
    },
  },
  {
    id: "navigation/reports-redirects",
    group: "navigation",
    title: "a redirect is reported at the URL it ended on",
    async run(ctx) {
      const outcome = await ctx.navigate({ kind: "url", url: ctx.fixture.pages.redirect });
      expectStatus(outcome, ["completed"], "navigate through a redirect");
      const navigation = defined(outcome.navigation, "navigation report");
      equal(navigation.to, ctx.fixture.pages.redirectTarget, "navigation.to after a redirect");
      const from = normalizeOrigin(navigation.from);
      const to = normalizeOrigin(navigation.to);
      if (from !== undefined && to !== undefined && from !== to) {
        equal(navigation.newOrigin, true, "newOrigin flag on a cross-origin redirect");
      }
      const observation = await ctx.observe();
      equal(observation.url, ctx.fixture.pages.redirectTarget, "observed URL after a redirect");
    },
  },
  {
    id: "navigation/history",
    group: "navigation",
    title: "back, forward and reload move through history",
    requires: ["history"],
    async run(ctx) {
      await ctx.open(ctx.fixture.pages.blank);
      await ctx.open(ctx.fixture.pages.form);
      expectStatus(await ctx.navigate({ kind: "back" }), ["completed"], "back");
      equal((await ctx.observe()).url, ctx.fixture.pages.blank, "URL after back");
      expectStatus(await ctx.navigate({ kind: "forward" }), ["completed"], "forward");
      equal((await ctx.observe()).url, ctx.fixture.pages.form, "URL after forward");
      expectStatus(await ctx.navigate({ kind: "reload" }), ["completed"], "reload");
      equal((await ctx.observe()).url, ctx.fixture.pages.form, "URL after reload");
    },
  },
  {
    id: "navigation/rejects-non-web-schemes",
    group: "navigation",
    title: "file:, data: and javascript: URLs are never navigated",
    async run(ctx) {
      for (const url of ["file:///etc/passwd", "data:text/html,<b>x</b>", "javascript:void(0)"]) {
        const attempt = await ctx.driver
          .navigate({ kind: "url", url }, ctx.signal)
          .then((outcome) => outcome)
          .catch((error: unknown) => error);
        if (attempt instanceof Error) continue;
        expectStatus(attempt as ActionOutcome, ["blocked", "failed"], `navigate to ${url}`);
      }
      const observation = await ctx.observe();
      check(
        observation.url.startsWith("http"),
        "the driver must remain on an http(s) page after refusing a non-web scheme",
      );
    },
  },
];

const frameCases: DriverContractCase[] = [
  {
    id: "frames/discovery",
    group: "frames",
    title: "frames are enumerated with resolvable parent links",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.frames);
      check(observation.frames.length >= 1, "the frames page must report its frames");
      const ids = new Set(observation.frames.map((frame) => frame.id));
      for (const frame of observation.frames) {
        if (frame.parentId !== undefined) {
          check(ids.has(frame.parentId), `frame ${frame.id} names an unknown parent`);
        }
      }
    },
  },
  {
    id: "frames/cross-origin-is-flagged",
    group: "frames",
    title: "a cross-origin frame is flagged and keeps its own origin",
    requires: ["crossOriginFrames"],
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.frames);
      const foreign = defined(
        observation.frames.find((frame) => frame.crossOrigin),
        "a cross-origin frame",
      );
      const expected = ctx.fixture.crossOriginFrameOrigin;
      if (expected !== undefined) equal(foreign.origin, expected, "cross-origin frame origin");
      check(
        foreign.origin !== observation.origin,
        "a cross-origin frame must not report the top-level origin",
      );
      for (const element of observation.elements) {
        if (element.frameId === foreign.id) return;
      }
    },
  },
];

const observationCases: DriverContractCase[] = [
  {
    id: "observation/revision-advances",
    group: "observation",
    title: "observation revisions never move backwards",
    async run(ctx) {
      const first = await ctx.open(ctx.fixture.pages.form);
      const second = await ctx.observe();
      check(second.revision >= first.revision, "revision must not move backwards");
      equal(second.connectionId, first.connectionId, "connectionId across observations");
      const third = await ctx.open(ctx.fixture.pages.dynamic);
      check(third.revision > first.revision, "navigation must produce a newer revision");
    },
  },
  {
    id: "observation/references-are-stable-or-rejected",
    group: "observation",
    title: "an element keeps its reference, or the old reference is rejected as stale",
    async run(ctx) {
      const first = await ctx.open(ctx.fixture.pages.form);
      const before = ctx.find(first, ctx.fixture.labels.textField);
      const second = await ctx.observe();
      const after = ctx.find(second, ctx.fixture.labels.textField);
      if (before.ref === after.ref && before.revision === after.revision) return;
      // A driver may re-mint refs, but it may never silently retarget the old one.
      expectStatus(
        await ctx.act({
          kind: "fill",
          target: elementRefOf(before),
          value: ctx.fixture.values.text,
        }),
        ["stale", "blocked", "failed"],
        "fill through a re-minted reference",
      );
    },
  },
  {
    id: "observation/navigation-invalidates-references",
    group: "observation",
    title: "a reference from before navigation is rejected, never retargeted",
    async run(ctx) {
      const before = await ctx.open(ctx.fixture.pages.form);
      const stale = elementRefOf(ctx.find(before, ctx.fixture.labels.textField));
      await ctx.open(ctx.fixture.pages.dynamic);
      const outcome = await ctx.act({
        kind: "fill",
        target: stale,
        value: ctx.fixture.values.text,
      });
      expectStatus(outcome, ["stale"], "fill through a pre-navigation reference");
      contains(
        outcome.message.toLowerCase(),
        "observ",
        "stale message must tell the caller to observe again",
      );
    },
  },
  {
    id: "observation/rejects-a-reference-from-another-tab",
    group: "observation",
    title: "a reference carrying a foreign tab id is rejected",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.form);
      const element = ctx.find(observation, ctx.fixture.labels.textField);
      const foreign = { ...elementRefOf(element), tabId: `${element.tabId}-other` };
      expectStatus(
        await ctx.act({ kind: "fill", target: foreign, value: ctx.fixture.values.text }),
        ["stale", "blocked", "failed"],
        "fill through a foreign-tab reference",
      );
    },
  },
  {
    id: "observation/rejects-an-invented-reference",
    group: "observation",
    title: "a reference the driver never minted is rejected by index or guess",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.form);
      const invented = {
        ref: elementRefId("not-a-real-ref"),
        revision: observation.revision,
        tabId: observation.tab.id,
      };
      expectStatus(
        await ctx.act({ kind: "click", target: invented }),
        ["stale", "blocked", "failed"],
        "click through an invented reference",
      );
    },
  },
  {
    id: "observation/snapshot-is-bounded",
    group: "observation",
    title: "maxNodes and maxTextChars bound the snapshot and report what was omitted",
    async run(ctx) {
      const observation = await ctx.observe({ tabId: undefined, maxNodes: 5, maxTextChars: 500 });
      check(observation.elements.length <= 5, "maxNodes must bound the element list");
      check(
        observation.snapshot.length <= BROWSER_LIMITS.maxSnapshotChars,
        "the snapshot must stay inside the contract bound",
      );
      const full = await ctx.observe();
      if (full.elements.length > observation.elements.length) {
        defined(observation.truncated, "truncation report when nodes were omitted");
      }
    },
  },
  {
    id: "observation/redacts-credential-fields",
    group: "observation",
    title: "a password field is observed without its value",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.credentials);
      const field = defined(
        observation.elements.find(isCredentialElement),
        "a credential-shaped element on the credentials page",
      );
      if (field.value !== undefined) equal(field.value, REDACTED, "credential field value");
      check(
        observation.risks.includes("password") || observation.risks.includes("authentication"),
        "the observation must flag the credential risk",
      );
      const marker = ctx.fixture.values.secretMarker;
      excludes(JSON.stringify(observation), marker, "serialized observation");
    },
  },
];

const interactionCases: DriverContractCase[] = [
  {
    id: "interaction/fill",
    group: "interaction",
    title: "fill replaces a field's value and the change is observable",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.form);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.textField));
      expectStatus(
        await ctx.act({ kind: "fill", target, value: ctx.fixture.values.text }),
        ["completed"],
        "fill",
      );
      const after = await ctx.observe();
      equal(
        ctx.find(after, ctx.fixture.labels.textField).value,
        ctx.fixture.values.text,
        "field value after fill",
      );
    },
  },
  {
    id: "interaction/type",
    group: "interaction",
    title: "type emits keyboard input into a field",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.form);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.textField));
      expectStatus(
        await ctx.act({ kind: "type", target, text: ctx.fixture.values.text }),
        ["completed"],
        "type",
      );
      const after = await ctx.observe();
      contains(
        defined(ctx.find(after, ctx.fixture.labels.textField).value, "field value after type"),
        ctx.fixture.values.text,
        "field value after type",
      );
    },
  },
  {
    id: "interaction/select-by-semantic-value",
    group: "interaction",
    title: "select chooses an option and the selection is observable",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.form);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.select));
      expectStatus(
        await ctx.act({ kind: "select", target, values: [ctx.fixture.values.selectOption] }),
        ["completed"],
        "select",
      );
      const after = ctx.find(await ctx.observe(), ctx.fixture.labels.select);
      const chosen = after.options?.filter((option) => option.selected) ?? [];
      if (chosen.length > 0) {
        check(
          chosen.some(
            (option) =>
              option.value === ctx.fixture.values.selectOption ||
              option.label === ctx.fixture.values.selectOption,
          ),
          "the selected option must be the one that was chosen",
        );
      } else {
        equal(after.value, ctx.fixture.values.selectOption, "select value after select");
      }
    },
  },
  {
    id: "interaction/check-and-uncheck",
    group: "interaction",
    title: "check and uncheck toggle a checkbox in both directions",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.form);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.checkbox));
      expectStatus(await ctx.act({ kind: "check", target }), ["completed"], "check");
      equal(
        ctx.find(await ctx.observe(), ctx.fixture.labels.checkbox).checked,
        true,
        "checked state after check",
      );
      const current = elementRefOf(ctx.find(await ctx.observe(), ctx.fixture.labels.checkbox));
      expectStatus(await ctx.act({ kind: "uncheck", target: current }), ["completed"], "uncheck");
      equal(
        ctx.find(await ctx.observe(), ctx.fixture.labels.checkbox).checked,
        false,
        "checked state after uncheck",
      );
    },
  },
  {
    id: "interaction/click-and-hover",
    group: "interaction",
    title: "click and hover reach a non-committing control",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.dynamic);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.scrollTarget));
      expectStatus(await ctx.act({ kind: "hover", target }), ["completed"], "hover");
      const fresh = elementRefOf(ctx.find(await ctx.observe(), ctx.fixture.labels.scrollTarget));
      expectStatus(await ctx.act({ kind: "click", target: fresh }), ["completed"], "click");
    },
  },
  {
    id: "interaction/press",
    group: "interaction",
    title: "press sends a key to the focused control",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.form);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.textField));
      expectStatus(await ctx.act({ kind: "press", target, key: "a" }), ["completed"], "press");
      const value = ctx.find(await ctx.observe(), ctx.fixture.labels.textField).value ?? "";
      check(value.length > 0, "a key press must reach the focused control");
    },
  },
  {
    id: "interaction/scroll",
    group: "interaction",
    title: "scroll moves the viewport and the new offset is observable",
    async run(ctx) {
      const before = await ctx.open(ctx.fixture.pages.dynamic);
      expectStatus(
        await ctx.act({ kind: "scroll", deltaX: 0, deltaY: 400 }),
        ["completed"],
        "scroll",
      );
      const after = await ctx.observe();
      check(
        after.viewport.scrollY !== before.viewport.scrollY,
        "the viewport offset must change after a scroll",
      );
    },
  },
  {
    id: "interaction/act-refuses-a-commitment-control",
    group: "interaction",
    title: "a generic click on a submitter is blocked and directed to submit",
    async run(ctx) {
      const before = await submissionCount(ctx);
      const observation = await ctx.open(ctx.fixture.pages.submit);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.submitButton));
      const outcome = await ctx.act({ kind: "click", target });
      expectStatus(outcome, ["blocked"], "generic click on a submitter");
      contains(
        outcome.message.toLowerCase(),
        "submit",
        "blocked message must name the submit path",
      );
      const after = await submissionCount(ctx);
      if (before !== undefined && after !== undefined) {
        equal(after, before, "a blocked click must not reach the server");
      }
    },
  },
];

const dialogCases: DriverContractCase[] = [
  {
    id: "dialogs/are-handled-not-hung-on",
    group: "dialogs",
    title: "a page dialog is handled and the connection stays usable",
    requires: ["dialogs"],
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.dialog);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.dialogTrigger));
      const outcome = await ctx.act({ kind: "click", target });
      expectStatus(outcome, ["completed", "blocked", "takeover"], "click that raises a dialog");
      const after = await ctx.observe();
      equal(after.tab.attached, true, "the tab must remain attached after a dialog");
      // The message is the page's own words. Reporting it as prose inside `message`
      // leaves the caller parsing English to find out what it agreed to.
      const dialog = defined(outcome.dialog, "a structured record of the dialog");
      equal(dialog.handled, "dismissed", "a dialog raised by a generic action");
      check(dialog.message.length > 0, "the dialog must carry the page's own words");
    },
  },
  {
    id: "dialogs/a-dismissed-guard-commits-nothing",
    group: "dialogs",
    title: "dismissing a page's confirmation leaves the commitment undone",
    requires: ["dialogGuard"],
    async run(ctx) {
      const url = defined(ctx.fixture.pages.guardedSubmit, "a guarded submit page");
      const before = await submissionCount(ctx);
      const observation = await ctx.open(url);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.submitButton));
      // No acceptance is supplied, so the driver must dismiss.
      const outcome = await ctx.submit({ target, intent: "submit-form" });
      const dialog = defined(outcome.dialog, "a structured record of the guard");
      equal(dialog.handled, "dismissed", "an unapproved guard");
      equal(outcome.ok, false, "a dismissed guard must not report success");
      if (before !== undefined) {
        equal(await submissionCount(ctx), before, "submissions after a dismissed guard");
      }
    },
  },
  {
    id: "dialogs/an-accepted-guard-commits-once",
    group: "dialogs",
    title: "accepting the exact question the user approved commits, once",
    requires: ["dialogGuard"],
    async run(ctx) {
      const url = defined(ctx.fixture.pages.guardedSubmit, "a guarded submit page");
      const message = defined(ctx.fixture.values.guardMessage, "the guard's message");
      const before = await submissionCount(ctx);
      const observation = await ctx.open(url);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.submitButton));

      // A different question is never the approved one, whoever wrote it.
      const wrong = await ctx.submit({
        target,
        intent: "submit-form",
        dialog: { accept: true, expectedMessage: `${message} (not what was approved)` },
      });
      equal(defined(wrong.dialog, "the guard").handled, "dismissed", "a mismatched guard");
      if (before !== undefined) {
        equal(await submissionCount(ctx), before, "submissions after a mismatched guard");
      }

      const fresh = await ctx.open(url);
      const again = elementRefOf(ctx.find(fresh, ctx.fixture.labels.submitButton));
      const outcome = await ctx.submit({
        target: again,
        intent: "submit-form",
        dialog: { accept: true, expectedMessage: message },
      });
      equal(defined(outcome.dialog, "the guard").handled, "accepted", "the approved guard");
      expectStatus(outcome, ["completed"], "an accepted guarded commitment");
      if (before !== undefined) {
        equal(await submissionCount(ctx), before + 1, "submissions after an accepted guard");
      }
    },
  },
];

const fileCases: DriverContractCase[] = [
  {
    id: "files/upload-accepts-an-authorized-document",
    group: "files",
    title: "upload sends an authorized document to a file input",
    requires: ["fileUpload"],
    async run(ctx) {
      const document = defined(ctx.setup.uploadDocument, "an authorized upload document");
      const observation = await ctx.open(ctx.fixture.pages.upload);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.fileField));
      const outcome = await ctx.upload({ target, documentIds: [document.id] });
      expectStatus(outcome, ["completed"], "upload");
      contains(
        JSON.stringify(await ctx.observe()),
        document.basename,
        "the page must show the uploaded basename",
      );
    },
  },
  {
    id: "files/upload-rejects-an-unknown-document",
    group: "files",
    title: "upload refuses a document id that was never authorized",
    requires: ["fileUpload"],
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.upload);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.fileField));
      const attempt = await ctx
        .upload({ target, documentIds: [authorizedDocumentId("doc-never-authorized")] })
        .catch((error: unknown) => error);
      if (attempt instanceof Error) {
        driverError(attempt, "upload of an unauthorized document");
        return;
      }
      expectStatus(
        attempt as ActionOutcome,
        ["blocked", "failed"],
        "upload of an unknown document",
      );
    },
  },
  {
    id: "files/upload-never-accepts-a-path",
    group: "files",
    title: "a path-shaped document id never reaches the file input",
    requires: ["fileUpload"],
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.upload);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.fileField));
      // Bypasses the schema the way a mis-wired caller would, to prove the driver
      // refuses the value rather than relying on validation upstream.
      const forged = "../../etc/passwd" as ReturnType<typeof authorizedDocumentId>;
      const attempt = await ctx
        .upload({ target, documentIds: [forged] })
        .catch((error: unknown) => error);
      if (attempt instanceof Error) return;
      expectStatus(attempt as ActionOutcome, ["blocked", "failed"], "upload of a path-shaped id");
    },
  },
];

const downloadCases: DriverContractCase[] = [
  {
    id: "downloads/are-reported-as-metadata",
    group: "downloads",
    title: "a download is reported by basename and size, never by local path",
    requires: ["downloads"],
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.download);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.downloadTrigger));
      const outcome = await ctx.act({ kind: "click", target });
      expectStatus(outcome, ["completed"], "download trigger click");
      const download = defined(readDownloadDetails(outcome.details), "download report");
      equal(download.basename, ctx.fixture.values.downloadBasename, "download basename");
      // The invariant is "no filesystem path", not "no slash anywhere": a legitimate
      // mimeType such as image/png contains one. The shape is what enforces it.
      excludes(download.basename, "/", "download basename must be a bare filename");
      excludes(download.basename, "\\", "download basename must be a bare filename");
      for (const key of Object.keys(download)) {
        includes(
          ["basename", "mimeType", "bytes", "sha256"],
          key,
          "download details carry only metadata fields",
        );
      }
      for (const leaked of ["path", "localPath", "filePath", "directory"]) {
        equal(
          readDownloadDetails({ download: { ...download, [leaked]: "/tmp/x" } } as never),
          undefined,
          `a ${leaked} property must fail download validation`,
        );
      }
      equal(
        readDownloadDetails({ download: { basename: "a.png", mimeType: "image/png" } } as never)
          ?.mimeType,
        "image/png",
        "a valid mime type is accepted",
      );
    },
  },
];

const screenshotCases: DriverContractCase[] = [
  {
    id: "screenshots/are-bounded-and-evictable",
    group: "screenshots",
    title: "a requested screenshot is evictable and inside the size bound",
    requires: ["screenshots"],
    async run(ctx) {
      await ctx.open(ctx.fixture.pages.form);
      const observation = await ctx.observe({ screenshot: "viewport" });
      const screenshot = defined(observation.screenshot, "screenshot");
      equal(screenshot.evictable, true, "screenshot evictable flag");
      oneOf(screenshot.mimeType, ["image/png", "image/jpeg"], "screenshot mime type");
      check(
        screenshot.data.length <= BROWSER_LIMITS.maxScreenshotBase64Chars,
        "the screenshot must stay inside the contract size bound",
      );
    },
  },
  {
    id: "screenshots/are-omitted-when-not-requested",
    group: "screenshots",
    title: "no screenshot is produced unless one was asked for",
    async run(ctx) {
      await ctx.open(ctx.fixture.pages.form);
      const observation = await ctx.observe({ screenshot: "none" });
      check(observation.screenshot === undefined, "screenshot: none must return no image");
    },
  },
  {
    id: "screenshots/skip-credential-pages",
    group: "screenshots",
    title: "a screenshot of a credential page carries no credential value",
    requires: ["screenshots"],
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.credentials);
      const withImage = await ctx.observe({ screenshot: "viewport" });
      excludes(
        JSON.stringify(withImage.elements),
        ctx.fixture.values.secretMarker,
        "observation elements alongside a screenshot",
      );
      if (withImage.screenshot) equal(withImage.screenshot.evictable, true, "evictable flag");
      equal(withImage.tab.id, observation.tab.id, "tab identity across observations");
    },
  },
];

const errorCases: DriverContractCase[] = [
  {
    id: "errors/wait-times-out-without-hanging",
    group: "errors",
    title: "an unsatisfiable wait ends at its deadline and leaves the connection usable",
    async run(ctx) {
      await ctx.open(ctx.fixture.pages.blank);
      const started = Date.now();
      const attempt = await ctx.driver
        .wait({ condition: "text", value: "text-that-never-appears", timeoutMs: 2_000 }, ctx.signal)
        .then((outcome) => outcome)
        .catch((error: unknown) => error);
      const elapsed = Date.now() - started;
      check(elapsed < 15_000, `a bounded wait must not hang (took ${elapsed}ms)`);
      if (attempt instanceof Error) {
        equal(driverError(attempt, "timed-out wait").code, "timeout", "error code");
      } else {
        expectStatus(attempt as ActionOutcome, ["failed"], "timed-out wait");
      }
      await ctx.observe();
    },
  },
  {
    id: "errors/abort-cancels-promptly",
    group: "errors",
    title: "aborting a running operation returns promptly and leaves the connection reusable",
    async run(ctx) {
      await ctx.open(ctx.fixture.pages.slow);
      const controller = new AbortController();
      const started = Date.now();
      const pending = ctx.driver
        .wait({ condition: "time", value: 30_000 }, controller.signal)
        .then((outcome) => outcome)
        .catch((error: unknown) => error);
      setTimeout(() => controller.abort(), 100);
      const attempt = await pending;
      const elapsed = Date.now() - started;
      check(elapsed < 10_000, `abort must cancel promptly (took ${elapsed}ms)`);
      if (attempt instanceof Error) {
        equal(driverError(attempt, "aborted wait").code, "aborted", "error code");
      } else {
        expectStatus(attempt as ActionOutcome, ["failed"], "aborted wait");
      }
      await ctx.observe();
    },
  },
  {
    id: "errors/crash-is-a-typed-failure",
    group: "errors",
    title: "a browser crash surfaces as a typed, reconnectable driver error",
    requires: ["crashSimulation"],
    managesConnection: true,
    async run(ctx) {
      await ctx.driver.connect(ctx.setup.connectOptions, ctx.signal);
      await ctx.open(ctx.fixture.pages.form);
      const crash = defined(ctx.setup.simulateConnectionLoss, "simulateConnectionLoss hook");
      await crash(ctx.driver);
      const error = driverError(
        await rejects(() => ctx.driver.observe({}, ctx.signal), "observe after a crash"),
        "observe after a crash",
      );
      oneOf(error.code, ["browser-crashed", "connection-lost"], "crash error code");
      equal(error.reconnectable, true, "a crash must be reported as reconnectable");
      oneOf(
        ctx.driver.status().phase,
        ["failed", "reconnecting", "disconnected"],
        "phase after a crash",
      );
      assertJsonSerializable(error.toDetails(), "driver error details");
    },
  },
];

const evidenceCases: DriverContractCase[] = [
  {
    id: "evidence/every-outcome-carries-a-before-snapshot",
    group: "evidence",
    title: "outcomes record the tab, revision and URL they acted from",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.form);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.textField));
      const outcome = await ctx.act({ kind: "fill", target, value: ctx.fixture.values.text });
      equal(outcome.before.tabId, observation.tab.id, "before.tabId");
      equal(outcome.before.url, observation.url, "before.url");
      equal(outcome.before.revision, observation.revision, "before.revision");
      const after = defined(outcome.after, "after-snapshot of a completed action");
      check(after.revision >= outcome.before.revision, "after.revision must not move backwards");
    },
  },
  {
    id: "evidence/submit-confirms-with-a-receipt-candidate",
    group: "evidence",
    title: "a confirmed submission returns the evidence a receipt is built from",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.submit);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.submitButton));
      const outcome = await ctx.submit({ target, intent: "submit-form" });
      expectStatus(outcome, ["completed"], "submit");
      const candidate = defined(outcome.receiptCandidate, "receipt candidate");
      equal(candidate.kind, "submit-form", "receipt candidate intent");
      contains(
        defined(candidate.confirmationText, "confirmation text"),
        ctx.fixture.values.confirmationText,
        "confirmation text",
      );
      const submissions = await submissionCount(ctx);
      if (submissions !== undefined) equal(submissions, 1, "recorded submissions");
    },
  },
  {
    id: "evidence/unknown-outcomes-are-representable-and-not-retried",
    group: "evidence",
    title: "a lost confirmation is reported unknown and is never retried automatically",
    async run(ctx) {
      const observation = await ctx.open(ctx.fixture.pages.unknownSubmit);
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.submitButton));
      const outcome = await ctx.submit({ target, intent: "submit-form" });
      equal(outcome.status, "unknown", `submit with a lost confirmation (${outcome.message})`);
      equal(outcome.ok, false, "an unknown outcome is never ok");
      equal(mayRetry(outcome), false, "an unknown outcome must not be retryable");
      const submissions = await submissionCount(ctx);
      if (submissions !== undefined) {
        equal(submissions, 1, "the driver must not retry an uncertain commitment");
      }
    },
  },
  {
    id: "evidence/outcomes-are-serializable-and-secret-free",
    group: "evidence",
    title: "every outcome is plain JSON with no handle, function or token in it",
    async run(ctx) {
      const observation: BrowserObservation = await ctx.open(ctx.fixture.pages.form);
      assertJsonSerializable(observation, "observation");
      const target = elementRefOf(ctx.find(observation, ctx.fixture.labels.textField));
      const outcome = await ctx.act({ kind: "fill", target, value: ctx.fixture.values.text });
      assertJsonSerializable(outcome, "action outcome");
      const token = ctx.setup.connectOptions.extensionToken;
      if (token) excludes(JSON.stringify(outcome), token.reveal(), "serialized outcome");
    },
  },
];

export const BROWSER_DRIVER_CONTRACT_CASES: readonly DriverContractCase[] = [
  ...connectionCases,
  ...tabCases,
  ...navigationCases,
  ...frameCases,
  ...observationCases,
  ...interactionCases,
  ...dialogCases,
  ...fileCases,
  ...downloadCases,
  ...screenshotCases,
  ...errorCases,
  ...evidenceCases,
];
