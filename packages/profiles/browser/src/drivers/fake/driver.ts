// A deterministic, in-memory BrowserDriver. It exists so every lane after B2 can
// test connection lifecycle, reference discipline, commitment routing and failure
// handling without a browser, a network, or a clock that varies between runs.
//
// It is a real implementation of the contract, not a stub: it enforces the same
// rules the production adapters must (stale refs are rejected, generic actions
// never commit, credential values are never observed, uncertain commitments are
// reported `unknown` and never retried).
import {
  type ActionOutcome,
  type ActionResultSnapshot,
  type ActionSnapshot,
  actionTargets,
  type BrowserAction,
  type BrowserDialog,
  blockedOutcome,
  completedOutcome,
  downloadDetails,
  failedOutcome,
  type NavigateRequest,
  type ObserveRequest,
  type SubmitRequest,
  staleOutcome,
  type UploadRequest,
  unknownOutcome,
  type WaitRequest,
} from "../../contracts/actions.ts";
import type {
  BrowserConnectionMode,
  BrowserConnectionState,
  BrowserFamily,
  ConnectOptions,
} from "../../contracts/connection.ts";
import type { AuthorizedDocument } from "../../contracts/documents.ts";
import {
  abortError,
  type BrowserDriver,
  BrowserDriverError,
  type BrowserDriverErrorCode,
  throwIfAborted,
} from "../../contracts/driver.ts";
import { BROWSER_LIMITS } from "../../contracts/json.ts";
import {
  type BrowserElement,
  type BrowserElementOption,
  type BrowserElementRef,
  type BrowserObservation,
  type BrowserRisk,
  COMMITMENT_RISKS,
  refValidity,
  refValidityMessage,
} from "../../contracts/observation.ts";
import {
  elementRefId,
  isPathShaped,
  isWebUrl,
  normalizeOrigin,
} from "../../contracts/primitives.ts";

const REDACTED = "[redacted]";

import type { BrowserFrame, BrowserTab, TabOutcome, TabRequest } from "../../contracts/tabs.ts";
import type { TakeoverReason } from "../../contracts/takeover.ts";
import {
  defaultFakeSite,
  FAKE_SCREENSHOT_PNG,
  type FakeElementSpec,
  type FakePageSpec,
  type FakeSite,
} from "./site.ts";

// What the fake's ledger records. Structurally the conformance harness's
// `FixtureSubmission`, declared here so shipped code never imports test scaffolding.
export interface FakeSubmissionRecord {
  path: string;
  fields: Record<string, string>;
  files: { field: string; basename: string; sha256?: string | undefined }[];
}

export interface FakeBrowserDriverOptions {
  site?: FakeSite;
  mode?: BrowserConnectionMode;
  browser?: BrowserFamily;
  // Documents `upload` will accept. Anything else is refused, exactly as the
  // production adapters must refuse an id the runtime never authorized.
  documents?: readonly AuthorizedDocument[];
  now?: () => number;
}

export interface FakeBrowserDriver extends BrowserDriver {
  submissions(): FakeSubmissionRecord[];
  // Severs the connection the way a crashed browser or dropped bridge would.
  simulateConnectionLoss(code?: "connection-lost" | "browser-crashed"): void;
  // The next operation fails with this code, then the injection clears.
  failNext(code: BrowserDriverErrorCode, message?: string): void;
  // The next commitment call fails after pre-submit observation/revalidation.
  failNextSubmit(code: BrowserDriverErrorCode, message?: string): void;
  authorize(document: AuthorizedDocument): void;
  reset(): void;
}

interface FakeTabState {
  id: string;
  attached: boolean;
  history: string[];
  historyIndex: number;
  scrollX: number;
  scrollY: number;
  revision: number;
  values: Map<string, string>;
  checked: Map<string, boolean>;
  selected: Map<string, string[]>;
}

const ok = completedOutcome;
const VIEWPORT = { width: 1_280, height: 720 } as const;
const DEFAULT_WAIT_MS = 5_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isTextLike(spec: FakeElementSpec): boolean {
  return spec.inputType === "text" || spec.role === "textbox";
}

function commits(risk: readonly BrowserRisk[] | undefined): boolean {
  return (risk ?? []).some((entry) => COMMITMENT_RISKS.includes(entry));
}

export function createFakeBrowserDriver(options: FakeBrowserDriverOptions = {}): FakeBrowserDriver {
  const site = options.site ?? defaultFakeSite();
  const mode = options.mode ?? "persistent";
  const browser = options.browser ?? "chrome";
  const now = options.now ?? (() => Date.now());
  const documents = new Map<string, AuthorizedDocument>(
    (options.documents ?? []).map((document) => [document.id, document]),
  );

  let phase: BrowserConnectionState["phase"] = "disconnected";
  let connectionSeq = 0;
  let tabSeq = 0;
  let revisionSeq = 0;
  let connectionId: string | undefined;
  let lostCode: "connection-lost" | "browser-crashed" | undefined;
  let injected: { code: BrowserDriverErrorCode; message: string } | undefined;
  let injectedSubmit: { code: BrowserDriverErrorCode; message: string } | undefined;
  let message: string | undefined;
  let tabs: FakeTabState[] = [];
  let activeTabId: string | undefined;
  const submissions: FakeSubmissionRecord[] = [];

  const state = (): BrowserConnectionState => ({
    phase,
    mode,
    browser,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(activeTabId === undefined ? {} : { activeTabId }),
    ...(message === undefined ? {} : { message }),
    updatedAt: now(),
  });

  const newTab = (url: string, attached = true): FakeTabState => {
    tabSeq += 1;
    revisionSeq += 1;
    return {
      id: `fake-tab-${tabSeq}`,
      attached,
      history: [url],
      historyIndex: 0,
      scrollX: 0,
      scrollY: 0,
      revision: revisionSeq,
      values: new Map(),
      checked: new Map(),
      selected: new Map(),
    };
  };

  const pageFor = (tab: FakeTabState): FakePageSpec => {
    const url = tab.history[tab.historyIndex] as string;
    const page = site.pages.get(url);
    if (page) return page;
    return { url, title: "Not found", summary: "No such page.", elements: [] };
  };

  const takeInjected = (): void => {
    if (!injected) return;
    const failure = injected;
    injected = undefined;
    throw new BrowserDriverError(failure.code, failure.message);
  };

  const requireLive = (): void => {
    takeInjected();
    if (lostCode) throw new BrowserDriverError(lostCode, "the fake browser is no longer reachable");
    if (phase === "disconnected" || phase === "failed" || phase === "closing") {
      throw new BrowserDriverError("not-connected", "connect before using the browser");
    }
  };

  const requireReady = (): void => {
    requireLive();
    if (phase !== "ready") {
      throw new BrowserDriverError(
        "unsupported",
        `the browser is ${phase}; only a ready connection accepts actions`,
      );
    }
  };

  const tabById = (id: string | undefined): FakeTabState => {
    const found = tabs.find((tab) => tab.id === id) ?? tabs.find((tab) => tab.id === activeTabId);
    if (!found) throw new BrowserDriverError("not-connected", "no tab is attached");
    return found;
  };

  const frameList = (page: FakePageSpec): BrowserFrame[] =>
    (page.frames ?? []).map((frame) => ({
      id: frame.id,
      ...(frame.parentId === undefined ? {} : { parentId: frame.parentId }),
      ...(frame.name === undefined ? {} : { name: frame.name }),
      url: frame.url,
      ...(normalizeOrigin(frame.url) === undefined
        ? {}
        : { origin: normalizeOrigin(frame.url) as string }),
      crossOrigin: frame.crossOrigin === true,
    }));

  const elementFor = (spec: FakeElementSpec, tab: FakeTabState): BrowserElement => {
    const credential = spec.secretValue !== undefined || spec.inputType === "password";
    const chosen = tab.selected.get(spec.ref);
    const options_: BrowserElementOption[] | undefined = spec.options?.map((option) => ({
      label: option.label,
      ...(option.value === undefined ? {} : { value: option.value }),
      ...(chosen ? { selected: chosen.includes(option.value ?? option.label) } : {}),
    }));
    const value = credential ? REDACTED : (tab.values.get(spec.ref) ?? spec.value);
    return {
      ref: elementRefId(spec.ref),
      revision: tab.revision,
      tabId: tab.id,
      ...(spec.frameId === undefined ? {} : { frameId: spec.frameId }),
      ...(spec.role === undefined ? {} : { role: spec.role }),
      ...(spec.name === undefined ? {} : { name: spec.name }),
      ...(spec.label === undefined ? {} : { label: spec.label }),
      ...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder }),
      ...(value === undefined ? {} : { value }),
      ...(spec.description === undefined ? {} : { description: spec.description }),
      ...(spec.checked === undefined && !tab.checked.has(spec.ref)
        ? {}
        : { checked: tab.checked.get(spec.ref) ?? spec.checked === true }),
      ...(spec.disabled === undefined ? {} : { disabled: spec.disabled }),
      ...(spec.required === undefined ? {} : { required: spec.required }),
      ...(spec.inputType === undefined ? {} : { inputType: spec.inputType }),
      ...(credential || options_ === undefined ? {} : { options: options_ }),
      ...(spec.risk === undefined ? {} : { risk: [...spec.risk] }),
    };
  };

  const observationFor = (tab: FakeTabState, request: ObserveRequest): BrowserObservation => {
    const page = pageFor(tab);
    const all = page.elements.map((spec) => elementFor(spec, tab));
    const maxNodes = request.maxNodes ?? BROWSER_LIMITS.maxElements;
    const elements = all.slice(0, maxNodes);
    const risks = [...new Set(elements.flatMap((element) => element.risk ?? []))];
    const lines = elements.map(
      (element) => `${element.role ?? "generic"} "${element.label ?? element.name ?? element.ref}"`,
    );
    const full = [page.title, ...lines].join("\n");
    const maxText = Math.min(
      request.maxTextChars ?? BROWSER_LIMITS.maxSnapshotChars,
      BROWSER_LIMITS.maxSnapshotChars,
    );
    const snapshot = full.slice(0, maxText);
    const nodesOmitted = all.length - elements.length;
    const textCharsOmitted = full.length - snapshot.length;
    const url = tab.history[tab.historyIndex] as string;
    const origin = normalizeOrigin(url);
    const wantsImage = request.screenshot === "viewport" || request.screenshot === "full-page";
    return {
      connectionId: connectionId as string,
      tab: tabSummary(tab),
      revision: tab.revision,
      observedAt: now(),
      title: page.title,
      url,
      ...(origin === undefined ? {} : { origin }),
      viewport: {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        scrollX: tab.scrollX,
        scrollY: tab.scrollY,
      },
      frames: frameList(page),
      summary: page.summary,
      snapshot,
      elements,
      risks,
      // A credential page is never captured, so no screenshot can carry a
      // password field's rendered value (SECURITY §11).
      ...(wantsImage && page.credential !== true
        ? {
            screenshot: {
              mimeType: "image/png" as const,
              data: FAKE_SCREENSHOT_PNG,
              evictable: true as const,
            },
          }
        : {}),
      ...(wantsImage && page.credential === true
        ? { screenshotOmitted: "credential" as const }
        : {}),
      ...(nodesOmitted > 0 || textCharsOmitted > 0
        ? { truncated: { nodesOmitted, textCharsOmitted } }
        : {}),
    };
  };

  function tabSummary(tab: FakeTabState): BrowserTab {
    const page = pageFor(tab);
    const url = tab.history[tab.historyIndex] as string;
    const origin = normalizeOrigin(url);
    return {
      id: tab.id,
      title: page.title,
      url,
      ...(origin === undefined ? {} : { origin }),
      active: tab.id === activeTabId,
      attached: tab.attached,
    };
  }

  const snapshotOf = (tab: FakeTabState): ActionSnapshot => ({
    tabId: tab.id,
    revision: tab.revision,
    url: tab.history[tab.historyIndex] as string,
  });

  const resultOf = (tab: FakeTabState): ActionResultSnapshot => ({
    ...snapshotOf(tab),
    title: pageFor(tab).title,
  });

  const goTo = (tab: FakeTabState, url: string): void => {
    let target = url;
    for (let hops = 0; hops < 5; hops++) {
      const next = site.pages.get(target)?.redirectTo;
      if (next === undefined) break;
      target = next;
    }
    tab.history = [...tab.history.slice(0, tab.historyIndex + 1), target];
    tab.historyIndex = tab.history.length - 1;
    tab.scrollX = 0;
    tab.scrollY = 0;
    revisionSeq += 1;
    tab.revision = revisionSeq;
    tab.values = new Map();
    tab.checked = new Map();
    tab.selected = new Map();
  };

  // A ref is judged against the observation that is current. It is never repaired
  // by index, position or guess (BD9).
  const resolveRef = (
    ref: BrowserElementRef,
  ): { tab: FakeTabState; spec: FakeElementSpec } | ActionOutcome => {
    const before = snapshotOf(tabById(activeTabId));
    const owning = tabs.find((tab) => tab.id === ref.tabId);
    if (!owning) {
      return staleOutcome({ message: refValidityMessage("wrong-tab"), before });
    }
    const observation = observationFor(owning, {});
    const validity = refValidity(ref, observation);
    if (validity !== "current") {
      return staleOutcome({ message: refValidityMessage(validity), before: snapshotOf(owning) });
    }
    const spec = pageFor(owning).elements.find((entry) => entry.ref === ref.ref);
    if (!spec) return staleOutcome({ message: refValidityMessage("unknown"), before });
    return { tab: owning, spec };
  };

  const recordSubmission = (tab: FakeTabState): void => {
    const page = pageFor(tab);
    const fields: Record<string, string> = {};
    const files: FakeSubmissionRecord["files"] = [];
    for (const entry of page.elements) {
      const label = entry.label ?? entry.name ?? entry.ref;
      if (entry.inputType === "file") {
        for (const basename of (tab.values.get(entry.ref) ?? "").split(", ").filter(Boolean)) {
          files.push({ field: label, basename });
        }
        continue;
      }
      const value = tab.values.get(entry.ref);
      if (value !== undefined && value.length > 0) fields[label] = value;
    }
    submissions.push({ path: new URL(page.url).pathname, fields, files });
  };

  const openTab = (url: string): FakeTabState => {
    const tab = newTab(url);
    tabs.push(tab);
    activeTabId = tab.id;
    return tab;
  };

  const applyAction = (
    action: BrowserAction,
    tab: FakeTabState,
    spec: FakeElementSpec,
    before: ActionSnapshot,
  ): ActionOutcome => {
    const label = spec.label ?? spec.name ?? spec.ref;
    switch (action.kind) {
      case "fill":
        tab.values.set(spec.ref, action.value);
        return ok({ message: `Filled "${label}".`, before, after: resultOf(tab) });
      case "type":
        tab.values.set(spec.ref, (tab.values.get(spec.ref) ?? spec.value ?? "") + action.text);
        return ok({ message: `Typed into "${label}".`, before, after: resultOf(tab) });
      case "press":
        if (isTextLike(spec)) {
          tab.values.set(
            spec.ref,
            (tab.values.get(spec.ref) ?? spec.value ?? "") +
              (action.key.length === 1 ? action.key : ""),
          );
        }
        return ok({ message: `Pressed ${action.key}.`, before, after: resultOf(tab) });
      case "select": {
        const known = new Set((spec.options ?? []).map((option) => option.value ?? option.label));
        const unknown = action.values.filter((value) => !known.has(value));
        if (unknown.length > 0) {
          return blockedOutcome({
            message: `"${label}" has no option ${unknown.join(", ")}; observe again.`,
            before,
          });
        }
        tab.selected.set(spec.ref, [...action.values]);
        tab.values.set(spec.ref, action.values[0] as string);
        return ok({
          message: `Selected ${action.values.join(", ")}.`,
          before,
          after: resultOf(tab),
        });
      }
      case "check":
      case "uncheck":
        tab.checked.set(spec.ref, action.kind === "check");
        return ok({
          message: `${action.kind === "check" ? "Checked" : "Unchecked"} "${label}".`,
          before,
          after: resultOf(tab),
        });
      case "hover":
        return ok({ message: `Hovered "${label}".`, before, after: resultOf(tab) });
      case "drag":
        return ok({ message: `Dragged onto "${label}".`, before, after: resultOf(tab) });
      case "scroll":
        return ok({ message: "Scrolled.", before, after: resultOf(tab) });
      case "click":
        return clickOutcome(tab, spec, before, label);
    }
  };

  const clickOutcome = (
    tab: FakeTabState,
    spec: FakeElementSpec,
    before: ActionSnapshot,
    label: string,
  ): ActionOutcome => {
    const behavior = spec.behavior;
    if (behavior?.kind === "open-tab") {
      openTab(behavior.url);
      return ok({ message: `Opened "${label}" in a new tab.`, before, after: resultOf(tab) });
    }
    if (behavior?.kind === "dialog") {
      // Dismissed, never accepted: agreeing to a page's question is a commitment, and
      // browser_act cannot reach a commitment (BD12).
      return blockedOutcome({
        message: `"${label}" raised a browser dialog; it was dismissed and the tab is still attached.`,
        before,
        after: resultOf(tab),
        dialog: { kind: behavior.dialogKind, message: behavior.message, handled: "dismissed" },
      });
    }
    if (behavior?.kind === "download") {
      return ok({
        message: `Downloaded ${behavior.download.basename}.`,
        before,
        after: resultOf(tab),
        details: downloadDetails(behavior.download),
      });
    }
    return ok({ message: `Clicked "${label}".`, before, after: resultOf(tab) });
  };

  const reset = (): void => {
    phase = "disconnected";
    connectionId = undefined;
    activeTabId = undefined;
    message = undefined;
    lostCode = undefined;
    injected = undefined;
    injectedSubmit = undefined;
    tabs = [];
    submissions.length = 0;
  };

  const driver: FakeBrowserDriver = {
    status: () => state(),

    async connect(connectOptions: ConnectOptions, signal: AbortSignal) {
      throwIfAborted(signal);
      takeInjected();
      if (connectOptions.mode !== mode) {
        throw new BrowserDriverError(
          "unsupported",
          `this fake driver was created for ${mode} mode, not ${connectOptions.mode}`,
        );
      }
      phase = "connecting";
      try {
        await sleep(0, signal);
      } catch (error) {
        phase = "disconnected";
        throw error;
      }
      connectionSeq += 1;
      connectionId = `fake-conn-${connectionSeq}`;
      lostCode = undefined;
      message = undefined;
      tabs = [];
      const tab = newTab(site.landingUrl);
      tabs.push(tab);
      activeTabId = tab.id;
      phase = "ready";
      return state();
    },

    async disconnect() {
      if (phase !== "disconnected") phase = "closing";
      tabs = [];
      activeTabId = undefined;
      connectionId = undefined;
      lostCode = undefined;
      phase = "disconnected";
    },

    async observe(request: ObserveRequest, signal: AbortSignal) {
      requireLive();
      throwIfAborted(signal);
      return observationFor(tabById(request.tabId), request);
    },

    async navigate(request: NavigateRequest, signal: AbortSignal) {
      requireReady();
      throwIfAborted(signal);
      const tab = tabById(request.tabId);
      const before = snapshotOf(tab);
      if (request.kind === "url") {
        if (!isWebUrl(request.url)) {
          return blockedOutcome({
            message: `Refused to navigate to ${request.url}: only http(s) URLs are permitted.`,
            before,
          });
        }
        goTo(tab, request.url);
      } else if (request.kind === "reload") {
        revisionSeq += 1;
        tab.revision = revisionSeq;
      } else {
        const next = tab.historyIndex + (request.kind === "back" ? -1 : 1);
        if (next < 0 || next >= tab.history.length) {
          return failedOutcome({
            message: `No ${request.kind} entry in this tab's history.`,
            before,
          });
        }
        tab.historyIndex = next;
        revisionSeq += 1;
        tab.revision = revisionSeq;
      }
      const after = resultOf(tab);
      const fromOrigin = normalizeOrigin(before.url);
      const toOrigin = normalizeOrigin(after.url);
      return completedOutcome({
        message: `Opened ${after.url}.`,
        before,
        after,
        navigation: {
          from: before.url,
          to: after.url,
          ...(fromOrigin !== toOrigin ? { newOrigin: true } : {}),
        },
      });
    },

    async act(request: BrowserAction, signal: AbortSignal) {
      requireReady();
      throwIfAborted(signal);
      const targets = actionTargets(request);
      if (targets.length === 0) {
        const tab = tabById(activeTabId);
        const before = snapshotOf(tab);
        if (request.kind === "scroll") {
          tab.scrollX += request.deltaX;
          tab.scrollY = Math.max(0, tab.scrollY + request.deltaY);
          return ok({ message: "Scrolled.", before, after: resultOf(tab) });
        }
        return ok({ message: "Sent the key to the page.", before, after: resultOf(tab) });
      }
      let resolvedTab: FakeTabState | undefined;
      let resolvedSpec: FakeElementSpec | undefined;
      for (const target of targets) {
        const resolution = resolveRef(target);
        if ("status" in resolution) return resolution;
        resolvedTab = resolution.tab;
        resolvedSpec = resolution.spec;
      }
      const tab = resolvedTab as FakeTabState;
      const spec = resolvedSpec as FakeElementSpec;
      const before = snapshotOf(tab);
      // BD12: a generic action never reaches a commitment control, whatever the
      // page calls the button.
      if (commits(spec.risk)) {
        return blockedOutcome({
          message: `"${spec.label ?? spec.ref}" commits this page; route it through the checked submit path instead of a generic ${request.kind}.`,
          before,
        });
      }
      if (request.kind === "scroll") {
        tab.scrollX += request.deltaX;
        tab.scrollY = Math.max(0, tab.scrollY + request.deltaY);
      }
      return applyAction(request, tab, spec, before);
    },

    async submit(request: SubmitRequest, signal: AbortSignal) {
      if (injectedSubmit !== undefined) {
        const failure = injectedSubmit;
        injectedSubmit = undefined;
        throw new BrowserDriverError(failure.code, failure.message);
      }
      requireReady();
      throwIfAborted(signal);
      const resolution = resolveRef(request.target);
      if ("status" in resolution) return resolution;
      const { tab, spec } = resolution;
      const before = snapshotOf(tab);
      const behavior = spec.behavior;
      if (behavior?.kind !== "commit") {
        return blockedOutcome({
          message: `"${spec.label ?? spec.ref}" is not a commitment control; use an ordinary action.`,
          before,
        });
      }
      if (behavior.intent !== request.intent) {
        return blockedOutcome({
          message: `"${spec.label ?? spec.ref}" performs ${behavior.intent}, not ${request.intent}.`,
          before,
        });
      }
      const guard = behavior.guard;
      let answered: BrowserDialog | undefined;
      if (guard !== undefined) {
        const accepted =
          request.dialog?.accept === true && request.dialog.expectedMessage === guard.message;
        answered = {
          kind: guard.dialogKind,
          message: guard.message,
          handled: accepted ? "accepted" : "dismissed",
        };
        if (!accepted) {
          // Dismissing the guard leaves the page exactly as it was. Nothing was sent,
          // so this is a plain block and not an unproven outcome.
          return blockedOutcome({
            message: `"${spec.label ?? spec.ref}" asked for confirmation first, and it was dismissed. Nothing was submitted.`,
            before,
            after: resultOf(tab),
            dialog: answered,
          });
        }
      }
      recordSubmission(tab);
      goTo(tab, behavior.resultUrl);
      const after = resultOf(tab);
      // BD18: the request reached the server; the confirmation did not come back.
      // Reported once, never retried.
      if (behavior.confirmation === "unknown") {
        return unknownOutcome({
          message:
            "The submission was sent but no confirmation was returned. Re-observe the page before deciding anything; do not send it again.",
          before,
          after,
          ...(answered === undefined ? {} : { dialog: answered }),
        });
      }
      return completedOutcome({
        message: `Submitted "${spec.label ?? spec.ref}".`,
        before,
        after,
        ...(answered === undefined ? {} : { dialog: answered }),
        receiptCandidate: {
          kind: behavior.intent,
          url: after.url,
          title: after.title,
          ...(behavior.confirmationText === undefined
            ? {}
            : { confirmationText: behavior.confirmationText }),
          ...(behavior.externalId === undefined ? {} : { externalId: behavior.externalId }),
        },
      });
    },

    async upload(request: UploadRequest, signal: AbortSignal) {
      requireReady();
      throwIfAborted(signal);
      const resolution = resolveRef(request.target);
      if ("status" in resolution) return resolution;
      const { tab, spec } = resolution;
      const before = snapshotOf(tab);
      if (spec.inputType !== "file") {
        return blockedOutcome({
          message: `"${spec.label ?? spec.ref}" is not a file input.`,
          before,
        });
      }
      const basenames: string[] = [];
      for (const id of request.documentIds) {
        // BD16: the model names documents, never paths. A path-shaped id is
        // refused here too, not only by the schema upstream.
        if (isPathShaped(id)) {
          return blockedOutcome({
            message: "A document id is never a filesystem path.",
            before,
          });
        }
        const document = documents.get(id);
        if (!document) {
          return blockedOutcome({
            message: `No authorized document with id ${id}.`,
            before,
          });
        }
        basenames.push(document.basename);
      }
      tab.values.set(spec.ref, basenames.join(", "));
      return completedOutcome({
        message: `Attached ${basenames.join(", ")}.`,
        before,
        after: resultOf(tab),
      });
    },

    async wait(request: WaitRequest, signal: AbortSignal) {
      requireReady();
      throwIfAborted(signal);
      const tab = tabById(undefined);
      const before = snapshotOf(tab);
      if (request.condition === "time") {
        await sleep(typeof request.value === "number" ? request.value : 0, signal);
        return ok({ message: "Waited.", before, after: resultOf(tab) });
      }
      if (request.condition === "network-idle") {
        return ok({ message: "The page is idle.", before, after: resultOf(tab) });
      }
      const satisfied = (): boolean => {
        const page = pageFor(tab);
        if (request.condition === "url") {
          return typeof request.value === "string" && page.url.includes(request.value);
        }
        if (request.condition === "element") {
          const ref = request.value as BrowserElementRef | undefined;
          return ref !== undefined && !("status" in resolveRef(ref));
        }
        const needle = typeof request.value === "string" ? request.value : "";
        return [page.title, page.summary, ...(page.text ?? [])].some((entry) =>
          entry.includes(needle),
        );
      };
      const deadline = now() + (request.timeoutMs ?? DEFAULT_WAIT_MS);
      while (!satisfied()) {
        if (now() >= deadline) {
          return failedOutcome({
            message: `Timed out waiting for ${request.condition}.`,
            before,
            after: resultOf(tab),
          });
        }
        await sleep(Math.min(25, Math.max(1, deadline - now())), signal);
      }
      return ok({ message: `Waited for ${request.condition}.`, before, after: resultOf(tab) });
    },

    async tabs(request: TabRequest, signal: AbortSignal): Promise<TabOutcome> {
      requireLive();
      throwIfAborted(signal);
      const listed = (okFlag: boolean, text: string): TabOutcome => ({
        ok: okFlag,
        tabs: tabs.map(tabSummary),
        ...(activeTabId === undefined ? {} : { activeTabId }),
        message: text,
      });
      switch (request.kind) {
        case "list":
          return listed(true, `${tabs.length} controlled tab(s).`);
        case "open":
          if (tabs.length >= BROWSER_LIMITS.maxTabs) {
            return listed(false, "Too many controlled tabs.");
          }
          openTab(request.url ?? site.landingUrl);
          return listed(true, "Opened a tab.");
        case "select": {
          if (!tabs.some((tab) => tab.id === request.tabId)) {
            return listed(false, `No controlled tab ${request.tabId}.`);
          }
          activeTabId = request.tabId;
          return listed(true, `Selected ${request.tabId}.`);
        }
        case "close": {
          const index = tabs.findIndex((tab) => tab.id === request.tabId);
          if (index < 0) return listed(false, `No controlled tab ${request.tabId}.`);
          tabs.splice(index, 1);
          const remaining = tabs.filter((tab) => tab.attached);
          activeTabId = remaining[0]?.id;
          // BD-consistent with ARCHITECTURE §13: losing the last attached tab
          // ends the connection rather than adopting an unrelated one.
          if (remaining.length === 0) {
            phase = "disconnected";
            message = "the last attached tab was closed";
          }
          return listed(true, `Closed ${request.tabId}.`);
        }
      }
    },

    async takeover(reason: TakeoverReason) {
      requireLive();
      phase = "takeover";
      message = `the user has control (${reason})`;
    },

    async resumeFromTakeover(signal: AbortSignal) {
      takeInjected();
      throwIfAborted(signal);
      if (phase !== "takeover") {
        throw new BrowserDriverError("unsupported", "the connection is not in takeover");
      }
      phase = "ready";
      message = undefined;
      const tab = tabById(activeTabId);
      // Resuming always re-observes, and the fresh observation invalidates every
      // reference minted before the user touched the page (ARCHITECTURE §7).
      revisionSeq += 1;
      tab.revision = revisionSeq;
      return observationFor(tab, {});
    },

    submissions: () => submissions.map((entry) => ({ ...entry })),

    simulateConnectionLoss(code = "browser-crashed") {
      lostCode = code;
      phase = "failed";
      message = "the browser connection was lost";
    },

    failNext(code, text) {
      injected = { code, message: text ?? `injected ${code} failure` };
    },

    failNextSubmit(code, text) {
      injectedSubmit = { code, message: text ?? `injected ${code} failure` };
    },

    authorize(document) {
      documents.set(document.id, document);
    },

    reset,
  };

  return driver;
}
