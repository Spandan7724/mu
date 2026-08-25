// The real BrowserDriver: Mu's contract on one side, the Playwright MCP sidecar on
// the other. It is the only path to the bridge, and it is where the contract is
// enforced — the twenty-four raw MCP tools are never exposed to the model (BD25).
//
// The shared conformance suite keeps this real-browser adapter aligned with the
// deterministic fake driver: neither may invent different semantics for equivalent
// page behaviour.
import {
  type ActionOutcome,
  type ActionResultSnapshot,
  type ActionSnapshot,
  actionTargets,
  type BrowserAction,
  type BrowserDialog,
  type BrowserDownload,
  blockedOutcome,
  completedOutcome,
  type DialogAcceptance,
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
  throwIfAborted,
} from "../../contracts/driver.ts";
import { BROWSER_LIMITS } from "../../contracts/json.ts";
import {
  type BrowserElement,
  type BrowserElementRef,
  type BrowserObservation,
  type BrowserRisk,
  COMMITMENT_RISKS,
  refValidity,
  refValidityMessage,
  type ScreenshotOmissionReason,
} from "../../contracts/observation.ts";
import {
  elementRefId,
  isPathShaped,
  isWebUrl,
  normalizeOrigin,
} from "../../contracts/primitives.ts";
import { REDACTED } from "../../contracts/secret.ts";
import type { BrowserFrame, BrowserTab, TabOutcome, TabRequest } from "../../contracts/tabs.ts";
import type { TakeoverReason } from "../../contracts/takeover.ts";
import { classifyRisks, commitmentIntent, isCredentialControl } from "../../policy/risk.ts";
import { imageOf, type McpSidecar, type McpToolResult, textOf } from "./protocol.ts";
import {
  parseDialogState,
  parseSidecarResponse,
  parseTabList,
  type SidecarResponse,
  sidecarErrorMessage,
} from "./response.ts";
import { assertSupportedServer } from "./sidecar.ts";
import {
  contextualText,
  parseSnapshot,
  type SnapshotNode,
  structuralSignature,
} from "./snapshot.ts";

const DEFAULT_WAIT_MS = 5_000;
const SETTLE_POLL_MS = 100;
const SCROLL_SETTLE_POLL_MS = 200;
const SCROLL_MIN_SETTLE_MS = 600;
const SCROLL_MAX_SETTLE_MS = 1_200;

// Roles whose accessible value the snapshot reports, mapped to the input type the
// contract expects. Everything else is left undeclared rather than guessed.
const INPUT_TYPES: Record<string, string> = {
  textbox: "text",
  spinbutton: "number",
  checkbox: "checkbox",
  radio: "radio",
  combobox: "select-one",
  listbox: "select-multiple",
  slider: "range",
  searchbox: "search",
  switch: "checkbox",
};

export interface McpBrowserDriverOptions {
  sidecar: McpSidecar;
  mode: BrowserConnectionMode;
  browser: BrowserFamily;
  documents?: readonly AuthorizedDocument[] | undefined;
  // Where a freshly launched Mu-owned browser is put. Chrome's own new-tab page
  // fetches remote content into the Mu profile and is not a page Mu chose, so an
  // owned browser never starts there.
  landingUrl?: string | undefined;
  now?: (() => number) | undefined;
  // Present only so the conformance harness can drive the same suite against a
  // deliberately severed connection. Nothing in the product calls it.
  onSevered?: (() => void) | undefined;
}

interface TabState {
  id: string;
  index: number;
  url: string;
  title: string;
  revision: number;
  signature: string;
  // What this driver attached to a file input on the page currently loaded here.
  // Playwright's accessibility snapshot does not report a file input's selection,
  // and the model must still be able to see what is attached before submitting.
  // Basenames only, and dropped the moment the page changes.
  attachments: Map<string, string>;
}

interface PageState {
  tab: TabState;
  nodes: SnapshotNode[];
  url: string;
  title: string;
  response: SidecarResponse;
}

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

function commits(risks: readonly BrowserRisk[]): boolean {
  return risks.some((risk) => COMMITMENT_RISKS.includes(risk));
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export interface McpBrowserDriver extends BrowserDriver {
  // Severs the bridge the way a crashed browser would, without a clean disconnect.
  sever(): void;
  authorize(document: AuthorizedDocument): void;
  sidecar(): McpSidecar;
}

export function createMcpBrowserDriver(options: McpBrowserDriverOptions): McpBrowserDriver {
  const sidecar = options.sidecar;
  const now = options.now ?? (() => Date.now());
  const documents = new Map<string, AuthorizedDocument>(
    (options.documents ?? []).map((document) => [document.id, document]),
  );

  let phase: BrowserConnectionState["phase"] = "disconnected";
  let connectionSeq = 0;
  let tabSeq = 0;
  let revisionSeq = 0;
  let connectionId: string | undefined;
  let activeTabId: string | undefined;
  let message: string | undefined;
  let severed: "connection-lost" | "browser-crashed" | undefined;
  let tabs: TabState[] = [];

  const state = (): BrowserConnectionState => ({
    phase,
    mode: options.mode,
    browser: options.browser,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(activeTabId === undefined ? {} : { activeTabId }),
    ...(message === undefined ? {} : { message }),
    updatedAt: now(),
  });

  const requireLive = (): void => {
    if (severed) {
      throw new BrowserDriverError(severed, "the browser connection was lost");
    }
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

  // Every sidecar failure is normalised before it leaves this class, so a caller
  // only ever sees the contract's own taxonomy.
  const call = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<SidecarResponse> => {
    throwIfAborted(signal);
    let result: McpToolResult;
    try {
      result = await sidecar.callTool(name, args, {
        signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (error) {
      const failure =
        error instanceof BrowserDriverError
          ? error
          : new BrowserDriverError("connection-lost", String(error));
      if (failure.code === "connection-lost" || failure.code === "browser-crashed") {
        severed = failure.code;
        phase = "failed";
        message = "the browser connection was lost";
      }
      throw failure;
    }
    const text = textOf(result);
    if (result.isError === true) {
      throw new BrowserDriverError("unsupported", bounded(sidecarErrorMessage(text), 2_000));
    }
    // Only the parsed fields travel onwards. Any saved-output path the sidecar
    // mentioned stays behind in `savedPaths`, where nothing reads it.
    const image = imageOf(result);
    return {
      ...parseSidecarResponse(text),
      ...(image === undefined ? {} : { image: { mimeType: image.mimeType, data: image.data } }),
    };
  };

  const reconcileTabs = (response: SidecarResponse): TabState[] => {
    const listed = parseTabList(response.result ?? response.raw);
    const previous = tabs;
    const taken = new Set<string>();
    const next: TabState[] = listed.map((tab) => {
      const match =
        previous.find(
          (old) => !taken.has(old.id) && old.url === tab.url && old.index === tab.index,
        ) ??
        previous.find((old) => !taken.has(old.id) && old.index === tab.index) ??
        previous.find((old) => !taken.has(old.id) && old.url === tab.url);
      if (match) {
        taken.add(match.id);
        // Identity survives a URL change; a URL change is a new revision.
        if (match.url !== tab.url) {
          revisionSeq += 1;
          match.revision = revisionSeq;
          match.signature = "";
          match.attachments.clear();
        }
        match.index = tab.index;
        match.url = tab.url;
        match.title = tab.title;
        return match;
      }
      tabSeq += 1;
      revisionSeq += 1;
      return {
        id: `mu-tab-${tabSeq}`,
        index: tab.index,
        url: tab.url,
        title: tab.title,
        revision: revisionSeq,
        signature: "",
        attachments: new Map(),
      };
    });
    tabs = next;
    const current = listed.find((tab) => tab.current);
    activeTabId =
      current === undefined
        ? next[0]?.id
        : (next.find((tab) => tab.index === current.index)?.id ?? next[0]?.id);
    return next;
  };

  const listTabs = async (signal: AbortSignal): Promise<TabState[]> =>
    reconcileTabs(await call("browser_tabs", { action: "list" }, signal));

  const tabById = (id: string | undefined): TabState => {
    const found = tabs.find((tab) => tab.id === id) ?? tabs.find((tab) => tab.id === activeTabId);
    if (!found) throw new BrowserDriverError("not-connected", "no tab is attached");
    return found;
  };

  const ensureActive = async (
    tabId: string | undefined,
    signal: AbortSignal,
  ): Promise<TabState> => {
    if (tabId === undefined || tabId === activeTabId) return tabById(tabId);
    const target = tabs.find((tab) => tab.id === tabId);
    if (!target) throw new BrowserDriverError("not-connected", `no controlled tab ${tabId}`);
    await call("browser_tabs", { action: "select", index: target.index }, signal);
    activeTabId = target.id;
    return target;
  };

  // The one place a page revision advances. Values deliberately do not advance it:
  // filling a field must not invalidate the reference that was just used, while a
  // control appearing, moving or being relabelled must (BD9).
  const readPage = async (tabId: string | undefined, signal: AbortSignal): Promise<PageState> => {
    const tab = await ensureActive(tabId, signal);
    const response = await call("browser_snapshot", { boxes: true }, signal);
    const nodes = parseSnapshot(response.snapshot ?? "");
    const url = response.url ?? tab.url;
    const title = response.title ?? tab.title;
    const signature = `${url}\n${structuralSignature(nodes)}`;
    if (signature !== tab.signature) {
      revisionSeq += 1;
      tab.revision = revisionSeq;
      tab.signature = signature;
    }
    if (tab.url !== url) tab.attachments.clear();
    tab.url = url;
    tab.title = title;
    return { tab, nodes, url, title, response };
  };

  // The snapshot names frames but not their URLs, and a frame's own origin is what
  // origin policy turns on, so the URLs come from the page metadata read alongside
  // the viewport. Frames the top document cannot enumerate keep the page URL and
  // are not claimed to be cross-origin.
  const frameList = (
    nodes: readonly SnapshotNode[],
    pageUrl: string,
    frameUrls: readonly string[],
  ): BrowserFrame[] => {
    const origin = normalizeOrigin(pageUrl);
    const frames = new Map<string, BrowserFrame>();
    let sequence = 0;
    for (const node of nodes) {
      if (node.role !== "iframe") continue;
      sequence += 1;
      const declared = node.value ?? node.attributes.url;
      const candidate = typeof declared === "string" ? declared : frameUrls[sequence - 1];
      const frameUrl = typeof candidate === "string" && candidate.length > 0 ? candidate : pageUrl;
      const frameOrigin = normalizeOrigin(frameUrl);
      const id = `f${sequence}`;
      frames.set(id, {
        id,
        ...(node.name === undefined ? {} : { name: bounded(node.name, 2_000) }),
        url: frameUrl,
        ...(frameOrigin === undefined ? {} : { origin: frameOrigin }),
        crossOrigin: frameOrigin !== undefined && frameOrigin !== origin,
      });
    }
    // A ref prefixed `f2e7` proves a frame the iframe scan may not have reached.
    for (const node of nodes) {
      const prefix = node.framePrefix;
      if (prefix === undefined || frames.has(prefix)) continue;
      frames.set(prefix, { id: prefix, url: pageUrl, crossOrigin: false });
    }
    return [...frames.values()].slice(0, BROWSER_LIMITS.maxFrames);
  };

  const elementFor = (
    node: SnapshotNode,
    nodes: readonly SnapshotNode[],
    tab: TabState,
    frameIds: Set<string>,
  ): BrowserElement => {
    const inputType = INPUT_TYPES[node.role];
    const attached = node.ref === undefined ? undefined : tab.attachments.get(node.ref);
    const credential = isCredentialControl({ role: node.role, name: node.name, inputType });
    const risks = classifyRisks({
      role: node.role,
      ...(node.name === undefined ? {} : { name: node.name }),
      ...(inputType === undefined ? {} : { inputType }),
    });
    const checked = node.attributes.checked;
    const frameId = node.framePrefix;
    const description = contextualText(node, nodes);
    const options = node.options.slice(0, BROWSER_LIMITS.maxOptionsPerElement).map((option) => ({
      label: bounded(option.label, 2_000),
      value: bounded(option.label, 2_000),
      selected: option.selected,
    }));
    return {
      ref: elementRefId(node.ref as string),
      revision: tab.revision,
      tabId: tab.id,
      ...(frameId !== undefined && frameIds.has(frameId) ? { frameId } : {}),
      role: bounded(node.role, 64),
      ...(node.name === undefined ? {} : { name: bounded(node.name, 2_000) }),
      ...(node.name === undefined ? {} : { label: bounded(node.name, 2_000) }),
      ...(credential || description === undefined
        ? {}
        : { description: bounded(description, 2_000) }),
      // BD14: a credential field's value is never observed, whatever the page shows.
      ...(credential
        ? { value: REDACTED }
        : (node.value ?? attached) === undefined
          ? {}
          : { value: bounded((node.value ?? attached) as string, 2_000) }),
      ...(checked === undefined
        ? {}
        : { checked: checked === "mixed" ? ("mixed" as const) : true }),
      ...(node.attributes.selected === undefined ? {} : { selected: true }),
      ...(node.attributes.disabled === undefined ? {} : { disabled: true }),
      ...(inputType === undefined
        ? attached === undefined
          ? {}
          : { inputType: "file" }
        : { inputType: credential ? "password" : inputType }),
      ...(credential || options.length === 0 ? {} : { options }),
      ...(risks.length === 0 ? {} : { risk: risks }),
      ...(node.box === undefined ? {} : { box: node.box }),
    };
  };

  // Playwright reports an unchecked checkbox by omitting the flag, so an element
  // that can be checked reports `false` rather than nothing.
  const withCheckedDefault = (element: BrowserElement, node: SnapshotNode): BrowserElement => {
    if (element.checked !== undefined) return element;
    if (node.role !== "checkbox" && node.role !== "radio" && node.role !== "switch") return element;
    return { ...element, checked: false };
  };

  interface PageMetadata {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    // "complete" only once the response finished. A commitment that leaves the
    // document short of it is an outcome Mu cannot establish (BD18).
    readyState: string;
    frameUrls: string[];
  }

  const PAGE_METADATA_FUNCTION = String.raw`() => {
    const selector =
      "a,button,input,select,textarea,[role],h1,h2,h3,h4,h5,h6,summary,details";
    const viewport = {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
    const frameUrls = [];
    let rootsVisited = 0;
    let frameSequence = 0;

    const intersects = (rect, clip) =>
      rect.right > clip.left &&
      rect.bottom > clip.top &&
      rect.left < clip.right &&
      rect.top < clip.bottom;
    const globalRect = (element, context) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left + context.offsetX,
        top: rect.top + context.offsetY,
        right: rect.right + context.offsetX,
        bottom: rect.bottom + context.offsetY,
      };
    };
    const rendered = (element) => {
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style?.display !== "none" &&
        style?.visibility !== "hidden" &&
        style?.opacity !== "0" &&
        element.closest('[aria-hidden="true"]') === null
      );
    };
    const roleOf = (element) => {
      const explicit = element.getAttribute("role")?.trim().toLowerCase();
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button" || tag === "summary") return "button";
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return element.hasAttribute("multiple") ? "listbox" : "combobox";
      if (tag === "input") {
        const type = (element.getAttribute("type") ?? "text").toLowerCase();
        if (type === "checkbox" || type === "radio") return type;
        if (type === "range") return "slider";
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "search") return "searchbox";
        return "textbox";
      }
      return tag === "details" ? "group" : "generic";
    };
    const labelOf = (element) => {
      const labels = Array.from(element.labels ?? [])
        .map((label) => label.textContent ?? "")
        .join(" ");
      return String(
        element.getAttribute("aria-label") ||
          labels ||
          element.getAttribute("alt") ||
          element.getAttribute("placeholder") ||
          element.getAttribute("title") ||
          element.innerText ||
          element.textContent ||
          "",
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
    };

    const visitRoot = (root, context) => {
      rootsVisited += 1;
      if (rootsVisited > 100) return;
      for (const element of Array.from(root.querySelectorAll("*"))) {
        const shadow = element.shadowRoot;
        if (shadow) visitRoot(shadow, context);
        if (element.tagName.toLowerCase() !== "iframe") continue;
        const frame = element;
        frameSequence += 1;
        const framePrefix = "f" + frameSequence;
        const rect = globalRect(frame, context);
        const clip = {
          left: Math.max(context.clip.left, rect.left),
          top: Math.max(context.clip.top, rect.top),
          right: Math.min(context.clip.right, rect.right),
          bottom: Math.min(context.clip.bottom, rect.bottom),
        };
        frameUrls.push(frame.src || "");
        try {
          const child = frame.contentDocument;
          if (child) {
            visitRoot(child, {
              offsetX: rect.left,
              offsetY: rect.top,
              clip,
              framePrefix,
            });
          }
        } catch {
          // Cross-origin frames cannot expose DOM geometry. Their visible frame prefix
          // still lets Mu prioritize the referenced accessibility subtree as a unit.
        }
      }
    };
    visitRoot(document, { offsetX: 0, offsetY: 0, clip: viewport });
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      readyState: document.readyState,
      frameUrls,
    };
  }`;

  const pageMetadata = async (signal: AbortSignal): Promise<PageMetadata> => {
    const fallback: PageMetadata = {
      width: 0,
      height: 0,
      scrollX: 0,
      scrollY: 0,
      readyState: "unknown",
      frameUrls: [],
    };
    try {
      // A constant, adapter-authored expression. No model input reaches it;
      // page labels are used only to order the model-visible snapshot.
      const response = await call(
        "browser_evaluate",
        { function: PAGE_METADATA_FUNCTION },
        signal,
        10_000,
      );
      const parsed = JSON.parse(response.result ?? "{}") as Record<string, unknown>;
      const read = (key: string): number => {
        const value = parsed[key];
        return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
      };
      return {
        width: read("width"),
        height: read("height"),
        scrollX: read("scrollX"),
        scrollY: read("scrollY"),
        readyState: typeof parsed.readyState === "string" ? parsed.readyState : "unknown",
        frameUrls: Array.isArray(parsed.frameUrls)
          ? parsed.frameUrls.filter((entry): entry is string => typeof entry === "string")
          : [],
      };
    } catch (error) {
      if (error instanceof BrowserDriverError && error.code === "aborted") throw error;
      return fallback;
    }
  };

  const observationFor = async (
    page: PageState,
    request: ObserveRequest,
    signal: AbortSignal,
  ): Promise<BrowserObservation> => {
    const metadata = await pageMetadata(signal);
    const frames = frameList(page.nodes, page.url, metadata.frameUrls);
    const frameIds = new Set(frames.map((frame) => frame.id));
    const referenced = page.nodes.filter(
      (node) => node.ref !== undefined && node.role !== "iframe",
    );
    const all = referenced.map((node) =>
      withCheckedDefault(elementFor(node, page.nodes, page.tab, frameIds), node),
    );
    const maxNodes = Math.min(
      request.maxNodes ?? BROWSER_LIMITS.maxElements,
      BROWSER_LIMITS.maxElements,
    );
    const elements = all.slice(0, maxNodes);
    const risks = [...new Set(elements.flatMap((element) => element.risk ?? []))];
    const full = elements
      .map(
        (element) =>
          `${element.role ?? "generic"} "${element.label ?? element.name ?? element.ref}"${element.value === undefined ? "" : `: ${element.value}`}`,
      )
      .join("\n");
    const maxText = Math.min(
      request.maxTextChars ?? BROWSER_LIMITS.maxSnapshotChars,
      BROWSER_LIMITS.maxSnapshotChars,
    );
    const snapshot = full.slice(0, maxText);
    const nodesOmitted = all.length - elements.length;
    const textCharsOmitted = full.length - snapshot.length;
    const origin = normalizeOrigin(page.url);
    const viewport = {
      width: metadata.width,
      height: metadata.height,
      scrollX: metadata.scrollX,
      scrollY: metadata.scrollY,
    };
    const credentialPage = all.some((element) => element.inputType === "password");
    const wantsImage = request.screenshot === "viewport" || request.screenshot === "full-page";
    let screenshot: BrowserObservation["screenshot"];
    let screenshotOmitted: ScreenshotOmissionReason | undefined;
    // SECURITY §11: a credential page is never captured, so no rendered password
    // field can be carried in an artifact.
    if (wantsImage && credentialPage) {
      screenshotOmitted = "credential";
    } else if (wantsImage) {
      const shot = await call(
        "browser_take_screenshot",
        { scale: "css", ...(request.screenshot === "full-page" ? { fullPage: true } : {}) },
        signal,
      );
      const image = shot.image;
      if (image === undefined) {
        screenshotOmitted = "unavailable";
      } else if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") {
        screenshotOmitted = "unsupported-format";
      } else if (image.data.length > BROWSER_LIMITS.maxScreenshotBase64Chars) {
        screenshotOmitted = "too-large";
      } else {
        screenshot = { mimeType: image.mimeType, data: image.data, evictable: true };
      }
    }
    return {
      connectionId: connectionId as string,
      tab: tabSummary(page.tab),
      revision: page.tab.revision,
      observedAt: now(),
      title: bounded(page.title, 2_000),
      url: page.url,
      ...(origin === undefined ? {} : { origin }),
      viewport,
      frames,
      summary: bounded(
        `${page.title || page.url} — ${elements.length} control(s)${risks.length === 0 ? "" : `, risks: ${risks.join(", ")}`}`,
        BROWSER_LIMITS.maxSummaryChars,
      ),
      snapshot,
      elements,
      risks,
      ...(screenshot === undefined ? {} : { screenshot }),
      ...(screenshotOmitted === undefined ? {} : { screenshotOmitted }),
      ...(nodesOmitted > 0 || textCharsOmitted > 0
        ? { truncated: { nodesOmitted, textCharsOmitted } }
        : {}),
    };
  };

  function tabSummary(tab: TabState): BrowserTab {
    const origin = normalizeOrigin(tab.url);
    return {
      id: tab.id,
      title: bounded(tab.title, 2_000),
      url: tab.url,
      ...(origin === undefined ? {} : { origin }),
      active: tab.id === activeTabId,
      attached: true,
    };
  }

  const snapshotOf = (tab: TabState): ActionSnapshot => ({
    tabId: tab.id,
    revision: tab.revision,
    url: tab.url,
  });

  const resultOf = (tab: TabState): ActionResultSnapshot => ({
    ...snapshotOf(tab),
    title: bounded(tab.title, 2_000),
  });

  interface Resolved {
    page: PageState;
    node: SnapshotNode;
    element: BrowserElement;
  }

  // A reference is judged against the observation that is current, and a failure is
  // reported as such. It is never repaired by index, position or guess (BD9).
  const resolveRef = async (
    ref: BrowserElementRef,
    signal: AbortSignal,
  ): Promise<Resolved | ActionOutcome> => {
    const known = tabs.find((tab) => tab.id === ref.tabId);
    if (!known) {
      return staleOutcome({
        message: refValidityMessage("wrong-tab"),
        before: snapshotOf(tabById(activeTabId)),
      });
    }
    const page = await readPage(known.id, signal);
    const observation = await observationFor(page, {}, signal);
    const validity = refValidity(ref, observation);
    if (validity !== "current") {
      return staleOutcome({ message: refValidityMessage(validity), before: snapshotOf(page.tab) });
    }
    const node = page.nodes.find((entry) => entry.ref === ref.ref);
    const element = observation.elements.find((entry) => entry.ref === ref.ref);
    if (!node || !element) {
      return staleOutcome({ message: refValidityMessage("unknown"), before: snapshotOf(page.tab) });
    }
    return { page, node, element };
  };

  const navigationOf = (before: ActionSnapshot, after: ActionResultSnapshot) => {
    if (before.url === after.url) return undefined;
    const from = normalizeOrigin(before.url);
    const to = normalizeOrigin(after.url);
    return {
      from: before.url,
      to: after.url,
      ...(from !== to ? { newOrigin: true } : {}),
    };
  };

  const downloadOf = (response: SidecarResponse): BrowserDownload | undefined => {
    const basename = response.downloads[0];
    if (basename === undefined) return undefined;
    // Metadata only. The bytes stay in the private artifact root and their
    // location is deliberately unrepresentable here.
    return { basename };
  };

  /**
   * Answers a dialog inside the action that raised it. A modal blocks every later
   * sidecar call, so it can never be left pending for a caller to decide about; the
   * decision has to have been made in advance. Acceptance is honoured only when the
   * page asked the question the approval was given for.
   */
  const answerDialog = async (
    response: SidecarResponse,
    acceptance: DialogAcceptance | undefined,
    signal: AbortSignal,
  ): Promise<BrowserDialog | undefined> => {
    const raised =
      response.modalState === undefined ? undefined : parseDialogState(response.modalState);
    if (raised === undefined) return undefined;
    const accept = acceptance?.accept === true && acceptance.expectedMessage === raised.message;
    await call(
      "browser_handle_dialog",
      {
        accept,
        ...(accept && acceptance?.promptText !== undefined
          ? { promptText: acceptance.promptText }
          : {}),
      },
      signal,
    ).catch(() => undefined);
    return { ...raised, handled: accept ? "accepted" : "dismissed" };
  };

  const afterAction = async (
    tabId: string,
    signal: AbortSignal,
  ): Promise<{ tab: TabState; page: PageState }> => {
    await listTabs(signal);
    const page = await readPage(tabs.some((tab) => tab.id === tabId) ? tabId : undefined, signal);
    await observationFor(page, {}, signal);
    return { tab: page.tab, page };
  };

  const afterScroll = async (
    tabId: string,
    signal: AbortSignal,
  ): Promise<{ tab: TabState; page: PageState }> => {
    // Settlement is wall-clock behavior. Do not use the injectable receipt clock:
    // tests and embedders may intentionally keep that clock fixed.
    const started = Date.now();
    const deadline = started + SCROLL_MAX_SETTLE_MS;
    let previousSignature: string | undefined;
    let latest = await afterAction(tabId, signal);
    for (;;) {
      const signature = latest.tab.signature;
      const stable = previousSignature !== undefined && signature === previousSignature;
      const currentTime = Date.now();
      if ((stable && currentTime - started >= SCROLL_MIN_SETTLE_MS) || currentTime >= deadline) {
        return latest;
      }
      previousSignature = signature;
      await sleep(SCROLL_SETTLE_POLL_MS, signal);
      latest = await afterAction(tabId, signal);
    }
  };

  const scrollMovement = (response: SidecarResponse): boolean | undefined => {
    try {
      const value = JSON.parse(response.result ?? "{}") as Record<string, unknown>;
      return typeof value.moved === "boolean" ? value.moved : undefined;
    } catch {
      return undefined;
    }
  };

  const afterSubmission = async (
    tabId: string,
    target: SnapshotNode,
    fromUrl: string,
    signal: AbortSignal,
  ): Promise<{ tab: TabState; page: PageState }> => {
    const targetStillExists = (page: PageState): boolean =>
      page.nodes.some(
        (entry) =>
          entry.ref === target.ref && entry.role === target.role && entry.name === target.name,
      );
    const deadline = now() + 5_000;
    for (;;) {
      const settled = await afterAction(tabId, signal);
      if (settled.tab.url !== fromUrl || !targetStillExists(settled.page)) {
        return settled;
      }
      if (now() >= deadline) return settled;
      await sleep(SETTLE_POLL_MS, signal);
    }
  };

  const FAILURE_LANGUAGE =
    /\b(?:could not|cannot|can't|did not|didn't|failed|failure|error|invalid|rejected|unable|not submitted|no application was created|try again)\b/i;

  const failureAlertText = (
    beforeNodes: readonly SnapshotNode[],
    afterPage: PageState,
  ): string | undefined => {
    const beforeAlerts = new Set(
      beforeNodes
        .filter((entry) => entry.role === "alert")
        .map((entry) => `${entry.ref ?? ""}\u0000${entry.name ?? ""}\u0000${entry.value ?? ""}`),
    );
    const alerts = afterPage.nodes.filter(
      (entry) =>
        entry.role === "alert" &&
        !beforeAlerts.has(`${entry.ref ?? ""}\u0000${entry.name ?? ""}\u0000${entry.value ?? ""}`),
    );
    for (const alert of alerts) {
      const belongsToAlert = (entry: SnapshotNode): boolean => {
        for (
          let current: SnapshotNode | undefined = entry;
          current !== undefined;
          current = current.parent
        ) {
          if (current === alert) return true;
        }
        return false;
      };
      const text = afterPage.nodes
        .filter(belongsToAlert)
        .flatMap((entry) => [entry.name, entry.value])
        .filter((entry): entry is string => entry !== undefined && entry.length > 0)
        .join(" ");
      if (FAILURE_LANGUAGE.test(text)) return bounded(text, BROWSER_LIMITS.maxSummaryChars);
    }
    return undefined;
  };

  const settle = async (
    tab: TabState,
    fromUrl: string,
    signal: AbortSignal,
    timeoutMs = 5_000,
  ): Promise<void> => {
    const deadline = now() + timeoutMs;
    for (;;) {
      const listed = await listTabs(signal);
      const current = listed.find((entry) => entry.id === tab.id);
      if (current !== undefined && current.url !== fromUrl) return;
      if (now() >= deadline) return;
      await sleep(SETTLE_POLL_MS, signal);
    }
  };

  const driver: McpBrowserDriver = {
    status: () => state(),

    async connect(connectOptions: ConnectOptions, signal: AbortSignal) {
      throwIfAborted(signal);
      if (connectOptions.mode !== options.mode) {
        throw new BrowserDriverError(
          "unsupported",
          `this driver was created for ${options.mode} mode, not ${connectOptions.mode}`,
        );
      }
      phase = "connecting";
      severed = undefined;
      // BD27: a new connection mints new tab identity and new revisions, so no
      // reference taken before a reconnect can survive it.
      tabs = [];
      activeTabId = undefined;
      try {
        assertSupportedServer(sidecar.serverIdentity());
        // The first tool call is what actually opens or attaches the browser.
        let listed = await listTabs(signal);
        if (listed.length === 0) {
          await call("browser_tabs", { action: "new" }, signal);
          listed = await listTabs(signal);
        }
        if (listed.length === 0) {
          throw new BrowserDriverError("connection-lost", "the browser reported no usable tab");
        }
        const landing = options.landingUrl;
        if (
          landing !== undefined &&
          isWebUrl(landing) &&
          !isWebUrl(listed.find((tab) => tab.id === activeTabId)?.url ?? "")
        ) {
          // A freshly launched browser can abort the first navigation while it is
          // still settling. Retrying a landing page is safe — it commits nothing —
          // and failing to reach it is not a reason to refuse the connection.
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await call("browser_navigate", { url: landing }, signal);
              break;
            } catch (error) {
              if (error instanceof BrowserDriverError && error.code === "aborted") throw error;
              if (attempt === 1) break;
            }
          }
          await listTabs(signal);
        }
      } catch (error) {
        phase = "disconnected";
        tabs = [];
        activeTabId = undefined;
        throw error;
      }
      connectionSeq += 1;
      connectionId = `mcp-conn-${connectionSeq}`;
      message = undefined;
      phase = "ready";
      return state();
    },

    async disconnect() {
      if (phase === "disconnected") return;
      phase = "closing";
      // The Mu-owned browser is closed and awaited so the last profile write is on disk.
      if (severed === undefined) {
        try {
          await sidecar.callTool("browser_close", {}, { signal: AbortSignal.timeout(30_000) });
        } catch {
          // A browser that is already gone is not a shutdown failure.
        }
      }
      tabs = [];
      activeTabId = undefined;
      connectionId = undefined;
      severed = undefined;
      message = undefined;
      phase = "disconnected";
    },

    async observe(request: ObserveRequest, signal: AbortSignal) {
      requireLive();
      throwIfAborted(signal);
      const page = await readPage(request.tabId, signal);
      return observationFor(page, request, signal);
    },

    async navigate(request: NavigateRequest, signal: AbortSignal) {
      requireReady();
      throwIfAborted(signal);
      const tab = await ensureActive(request.tabId, signal);
      const before = snapshotOf(tab);
      if (request.kind === "url") {
        // TOOLS.md: navigation only ever addresses http(s).
        if (!isWebUrl(request.url)) {
          return blockedOutcome({
            message: `Refused to navigate to ${request.url}: only http(s) URLs are permitted.`,
            before,
          });
        }
        try {
          await call("browser_navigate", { url: request.url }, signal);
        } catch (error) {
          if (error instanceof BrowserDriverError && error.code === "timeout") {
            return failedOutcome({
              message: `Navigation to ${request.url} did not complete: ${error.message}`,
              before,
            });
          }
          throw error;
        }
      } else if (request.kind === "back") {
        await call("browser_navigate_back", {}, signal);
      } else if (request.kind === "reload") {
        await call("browser_navigate", { url: tab.url }, signal);
      } else {
        // 0.0.79 has no forward tool. A constant, adapter-authored expression is
        // used rather than inventing a selector or a coordinate.
        await call("browser_evaluate", { function: "() => { history.forward(); }" }, signal);
        await settle(tab, before.url, signal, 3_000);
      }
      const { tab: updated } = await afterAction(tab.id, signal);
      const after = resultOf(updated);
      if (request.kind !== "url" && after.url === before.url && request.kind !== "reload") {
        return failedOutcome({
          message: `No ${request.kind} entry in this tab's history.`,
          before,
          after,
        });
      }
      const navigation = navigationOf(before, after);
      return completedOutcome({
        message: `Opened ${after.url}.`,
        before,
        after,
        ...(navigation === undefined ? {} : { navigation }),
      });
    },

    async act(request: BrowserAction, signal: AbortSignal) {
      requireReady();
      throwIfAborted(signal);
      const targets = actionTargets(request);
      if (targets.length === 0) {
        const tab = await ensureActive(undefined, signal);
        const before = snapshotOf(tab);
        let moved: boolean | undefined;
        if (request.kind === "scroll") {
          const response = await call(
            "browser_evaluate",
            {
              function: `() => { const beforeX = window.scrollX; const beforeY = window.scrollY; window.scrollBy(${Math.trunc(request.deltaX)}, ${Math.trunc(request.deltaY)}); return { moved: window.scrollX !== beforeX || window.scrollY !== beforeY, beforeX, beforeY, afterX: window.scrollX, afterY: window.scrollY }; }`,
            },
            signal,
          );
          moved = scrollMovement(response);
        } else if (request.kind === "press") {
          await call("browser_press_key", { key: request.key }, signal);
        }
        const { tab: updated } =
          request.kind === "scroll" && moved !== false
            ? await afterScroll(tab.id, signal)
            : await afterAction(tab.id, signal);
        if (request.kind === "scroll" && moved === false) {
          return failedOutcome({
            message:
              "The page viewport did not move. It may already be at that edge, or a nested container may be the scrollable surface.",
            before,
            after: resultOf(updated),
          });
        }
        return completedOutcome({
          message: request.kind === "scroll" ? "Scrolled." : "Sent the key to the page.",
          before,
          after: resultOf(updated),
        });
      }

      let resolved: Resolved | undefined;
      let source: Resolved | undefined;
      for (const target of targets) {
        const resolution = await resolveRef(target, signal);
        if ("status" in resolution) return resolution;
        source ??= resolution;
        resolved = resolution;
      }
      const found = resolved as Resolved;
      const before = snapshotOf(found.page.tab);
      // BD12: a generic action never reaches a commitment control, whatever the
      // page calls the button.
      if (commits(found.element.risk ?? [])) {
        return blockedOutcome({
          message: `"${found.element.label ?? found.element.ref}" commits this page; route it through the checked submit path instead of a generic ${request.kind}.`,
          before,
        });
      }
      const ref = found.node.ref as string;
      const label = found.element.label ?? found.element.name ?? ref;
      let outcome: { message: string; response?: SidecarResponse } | undefined;
      let scrollDidMove: boolean | undefined;
      switch (request.kind) {
        case "fill":
        case "type": {
          const text = request.kind === "fill" ? request.value : request.text;
          const response = await call(
            "browser_type",
            {
              target: ref,
              text,
              element: label,
              ...(request.kind === "type" ? { slowly: true } : {}),
            },
            signal,
          );
          outcome = {
            message: request.kind === "fill" ? `Filled "${label}".` : `Typed into "${label}".`,
            response,
          };
          break;
        }
        case "select": {
          const response = await call(
            "browser_select_option",
            { target: ref, values: request.values, element: label },
            signal,
          );
          outcome = { message: `Selected ${request.values.join(", ")}.`, response };
          break;
        }
        case "check":
        case "uncheck": {
          const wanted = request.kind === "check";
          if ((found.element.checked === true) === wanted) {
            outcome = { message: `"${label}" was already ${wanted ? "checked" : "unchecked"}.` };
            break;
          }
          const response = await call("browser_click", { target: ref, element: label }, signal);
          outcome = {
            message: `${wanted ? "Checked" : "Unchecked"} "${label}".`,
            response,
          };
          break;
        }
        case "hover": {
          const response = await call("browser_hover", { target: ref, element: label }, signal);
          outcome = { message: `Hovered "${label}".`, response };
          break;
        }
        case "press": {
          await call(
            "browser_evaluate",
            { target: ref, element: label, function: "(element) => { element.focus(); }" },
            signal,
          );
          const response = await call("browser_press_key", { key: request.key }, signal);
          outcome = { message: `Pressed ${request.key}.`, response };
          break;
        }
        case "scroll": {
          const response = await call(
            "browser_evaluate",
            {
              target: ref,
              element: label,
              function: `(element) => { const beforeX = element.scrollLeft; const beforeY = element.scrollTop; element.scrollBy(${Math.trunc(request.deltaX)}, ${Math.trunc(request.deltaY)}); return { moved: element.scrollLeft !== beforeX || element.scrollTop !== beforeY, beforeX, beforeY, afterX: element.scrollLeft, afterY: element.scrollTop }; }`,
            },
            signal,
          );
          scrollDidMove = scrollMovement(response);
          outcome = { message: "Scrolled.", response };
          break;
        }
        case "drag": {
          const start = source as Resolved;
          const response = await call(
            "browser_drag",
            {
              startTarget: start.node.ref as string,
              startElement: start.element.label ?? "source",
              endTarget: ref,
              endElement: label,
            },
            signal,
          );
          outcome = { message: `Dragged onto "${label}".`, response };
          break;
        }
        case "click": {
          const response = await call(
            "browser_click",
            {
              target: ref,
              element: label,
              ...(request.button === "right" ? { button: "right" } : {}),
            },
            signal,
          );
          outcome = { message: `Clicked "${label}".`, response };
          break;
        }
      }

      const settled = outcome as { message: string; response?: SidecarResponse };

      // Answered before anything else is asked of the browser. While a modal is open
      // every other tool refuses — `browser_snapshot` included — so re-observing first
      // fails on the snapshot instead of dealing with the dialog that caused it.
      // `browser_act` never passes an acceptance: agreeing to a page's question is a
      // commitment, and commitments go through submit() (BD12).
      const raised =
        settled.response === undefined
          ? undefined
          : await answerDialog(settled.response, undefined, signal);
      if (raised !== undefined) {
        return blockedOutcome({
          message: `"${label}" raised a browser dialog; it was dismissed and the tab is still attached.`,
          before,
          after: resultOf((await afterAction(found.page.tab.id, signal)).tab),
          dialog: raised,
        });
      }

      const { tab: updated } =
        request.kind === "scroll" && scrollDidMove !== false
          ? await afterScroll(found.page.tab.id, signal)
          : await afterAction(found.page.tab.id, signal);
      const after = resultOf(updated);
      if (request.kind === "scroll" && scrollDidMove === false) {
        return failedOutcome({
          message: `"${label}" did not scroll. It may already be at that edge or may not be a scrollable container; omit target to scroll the page viewport.`,
          before,
          after,
        });
      }
      const navigation = navigationOf(before, after);
      const download = settled.response === undefined ? undefined : downloadOf(settled.response);
      return completedOutcome({
        message: settled.message,
        before,
        after,
        ...(navigation === undefined ? {} : { navigation }),
        ...(download === undefined ? {} : { details: downloadDetails(download) }),
      });
    },

    async submit(request: SubmitRequest, signal: AbortSignal) {
      requireReady();
      throwIfAborted(signal);
      const resolution = await resolveRef(request.target, signal);
      if ("status" in resolution) return resolution;
      const { page, node, element } = resolution;
      const before = snapshotOf(page.tab);
      const label = element.label ?? element.name ?? (node.ref as string);
      const intent = commitmentIntent({
        role: node.role,
        ...(node.name === undefined ? {} : { name: node.name }),
      });
      if (intent === undefined) {
        return blockedOutcome({
          message: `"${label}" is not a commitment control; use an ordinary action.`,
          before,
        });
      }
      if (intent !== request.intent) {
        return blockedOutcome({
          message: `"${label}" performs ${intent}, not ${request.intent}.`,
          before,
        });
      }
      let clicked: SidecarResponse;
      try {
        clicked = await call(
          "browser_click",
          { target: node.ref as string, element: label },
          signal,
        );
      } catch (error) {
        // BD18: the click reached the page. Whether the server acted on it cannot
        // be established, so it is reported once and never retried.
        const reason = error instanceof Error ? error.message : String(error);
        return unknownOutcome({
          message: `The submission was sent but no confirmation came back (${reason}). Re-observe the page before deciding anything; do not send it again.`,
          before,
        });
      }

      const answered = await answerDialog(clicked, request.dialog, signal);
      if (answered?.handled === "dismissed") {
        const { tab: updated } = await afterAction(page.tab.id, signal);
        const after = resultOf(updated);
        // The page moved anyway, so dismissing did not stop it and Mu cannot tell
        // what reached the server. That is BD18's case, not a clean refusal.
        if (after.url !== before.url) {
          return unknownOutcome({
            message: `"${label}" raised a dialog that was dismissed, and the page navigated regardless. Check the site before doing anything else; do not send it again.`,
            before,
            after,
            dialog: answered,
          });
        }
        return blockedOutcome({
          message: `"${label}" asked for confirmation first, and it was dismissed. The page did not move, so nothing was submitted.`,
          before,
          after,
          dialog: answered,
        });
      }
      let after: ActionResultSnapshot;
      let confirmation: string | undefined;
      let formDisappeared = false;
      let failureText: string | undefined;
      try {
        const { tab: updated, page: settledPage } = await afterSubmission(
          page.tab.id,
          node,
          before.url,
          signal,
        );
        after = resultOf(updated);
        formDisappeared = !settledPage.nodes.some(
          (entry) => entry.ref === node.ref && entry.role === node.role && entry.name === node.name,
        );
        failureText = failureAlertText(page.nodes, settledPage);
        const state = await pageMetadata(signal);
        // BD18: the request reached the server and the response never finished.
        // That is not a failure and not a success; it is an outcome Mu cannot
        // establish, so it is reported once and never retried.
        if (state.readyState !== "complete" && state.readyState !== "unknown") {
          return unknownOutcome({
            message:
              "The submission was sent and the response never finished arriving. Check the site before doing anything else; do not send it again.",
            before,
            after,
            ...(answered === undefined ? {} : { dialog: answered }),
          });
        }
        confirmation = settledPage.nodes
          .map((entry) => entry.value ?? entry.name ?? "")
          .filter((text) => text.length > 0)
          .join(" ");
      } catch (error) {
        if (error instanceof BrowserDriverError && error.code === "aborted") throw error;
        return unknownOutcome({
          message:
            "The submission was sent but the page could not be re-observed afterwards. Check the site before doing anything else; do not send it again.",
          before,
          ...(answered === undefined ? {} : { dialog: answered }),
        });
      }
      const navigation = navigationOf(before, after);
      return completedOutcome({
        message: `Submitted "${label}".`,
        before,
        after,
        ...(navigation === undefined ? {} : { navigation }),
        ...(formDisappeared || failureText !== undefined
          ? {
              details: {
                ...(formDisappeared ? { formDisappeared: true } : {}),
                ...(failureText === undefined ? {} : { failureText }),
              },
            }
          : {}),
        ...(answered === undefined ? {} : { dialog: answered }),
        receiptCandidate: {
          kind: request.intent,
          url: after.url,
          title: after.title,
          ...(confirmation === undefined || confirmation.length === 0
            ? {}
            : { confirmationText: bounded(confirmation, BROWSER_LIMITS.maxSummaryChars) }),
        },
      });
    },

    async upload(request: UploadRequest, signal: AbortSignal) {
      requireReady();
      throwIfAborted(signal);
      const resolution = await resolveRef(request.target, signal);
      if ("status" in resolution) return resolution;
      const { page, node, element } = resolution;
      const before = snapshotOf(page.tab);
      const label = element.label ?? element.name ?? (node.ref as string);
      if (commits(element.risk ?? [])) {
        return blockedOutcome({ message: `"${label}" is not a file input.`, before });
      }
      const paths: string[] = [];
      const basenames: string[] = [];
      for (const id of request.documentIds) {
        // BD16: the model names documents, never paths. A path-shaped id is refused
        // here too, not only by the schema upstream.
        if (isPathShaped(id)) {
          return blockedOutcome({ message: "A document id is never a filesystem path.", before });
        }
        const document = documents.get(id);
        if (!document) {
          return blockedOutcome({ message: `No authorized document with id ${id}.`, before });
        }
        paths.push(document.path);
        basenames.push(document.basename);
      }
      const opened = await call(
        "browser_click",
        { target: node.ref as string, element: label },
        signal,
      );
      if (opened.modalState === undefined || !/file chooser/i.test(opened.modalState)) {
        return blockedOutcome({ message: `"${label}" is not a file input.`, before });
      }
      try {
        await call("browser_file_upload", { paths }, signal);
      } catch (error) {
        if (error instanceof BrowserDriverError && error.code === "aborted") throw error;
        // An open file chooser blocks every other tool, so it is cancelled before
        // the failure is reported. The bridge's own message names the local path
        // and is deliberately not carried into the outcome.
        await call("browser_file_upload", {}, signal).catch(() => undefined);
        return blockedOutcome({
          message: `The browser refused to attach ${basenames.join(", ")}. An authorized document must live inside Mu's own document root.`,
          before,
        });
      }
      page.tab.attachments.set(node.ref as string, basenames.join(", "));
      const { tab: updated } = await afterAction(page.tab.id, signal);
      updated.attachments.set(node.ref as string, basenames.join(", "));
      return completedOutcome({
        message: `Attached ${basenames.join(", ")}.`,
        before,
        after: resultOf(updated),
      });
    },

    async wait(request: WaitRequest, signal: AbortSignal) {
      requireReady();
      throwIfAborted(signal);
      const tab = await ensureActive(undefined, signal);
      const before = snapshotOf(tab);
      const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_MS;
      if (request.condition === "time") {
        await sleep(typeof request.value === "number" ? request.value : 0, signal);
        const { tab: updated } = await afterAction(tab.id, signal);
        return completedOutcome({ message: "Waited.", before, after: resultOf(updated) });
      }
      if (request.condition === "network-idle") {
        const { tab: updated } = await afterAction(tab.id, signal);
        return completedOutcome({ message: "The page is idle.", before, after: resultOf(updated) });
      }
      if (request.condition === "text" && typeof request.value === "string") {
        try {
          await call("browser_wait_for", { text: request.value }, signal, timeoutMs);
        } catch (error) {
          // Only the caller's cancellation is a cancellation. The deadline this
          // method set for itself is a timeout, reported on the page.
          if (error instanceof BrowserDriverError && error.code === "aborted" && signal.aborted) {
            throw error;
          }
          const { tab: updated } = await afterAction(tab.id, signal).catch(() => ({ tab }));
          return failedOutcome({
            message: `Timed out waiting for ${request.condition}.`,
            before,
            after: resultOf(updated),
          });
        }
        const { tab: updated } = await afterAction(tab.id, signal);
        return completedOutcome({
          message: `Waited for ${request.condition}.`,
          before,
          after: resultOf(updated),
        });
      }
      // A deadline, polled — never an unbounded wait.
      const deadline = now() + timeoutMs;
      for (;;) {
        const page = await readPage(tab.id, signal);
        const observation = await observationFor(page, {}, signal);
        const satisfied =
          request.condition === "url"
            ? typeof request.value === "string" && page.url.includes(request.value)
            : typeof request.value === "object" &&
              request.value !== null &&
              refValidity(request.value as BrowserElementRef, observation) === "current";
        if (satisfied) {
          return completedOutcome({
            message: `Waited for ${request.condition}.`,
            before,
            after: resultOf(page.tab),
          });
        }
        if (now() >= deadline) {
          return failedOutcome({
            message: `Timed out waiting for ${request.condition}.`,
            before,
            after: resultOf(page.tab),
          });
        }
        await sleep(SETTLE_POLL_MS, signal);
      }
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
        case "list": {
          const current = await listTabs(signal);
          return listed(true, `${current.length} controlled tab(s).`);
        }
        case "open": {
          if (tabs.length >= BROWSER_LIMITS.maxTabs)
            return listed(false, "Too many controlled tabs.");
          const url = request.url;
          if (url !== undefined && !isWebUrl(url)) {
            return listed(false, "Only http(s) URLs may be opened.");
          }
          await call(
            "browser_tabs",
            { action: "new", ...(url === undefined ? {} : { url }) },
            signal,
          );
          await listTabs(signal);
          return listed(true, "Opened a tab.");
        }
        case "select": {
          const target = tabs.find((tab) => tab.id === request.tabId);
          if (!target) return listed(false, `No controlled tab ${request.tabId}.`);
          await call("browser_tabs", { action: "select", index: target.index }, signal);
          await listTabs(signal);
          activeTabId = request.tabId;
          return listed(true, `Selected ${request.tabId}.`);
        }
        case "close": {
          const target = tabs.find((tab) => tab.id === request.tabId);
          if (!target) return listed(false, `No controlled tab ${request.tabId}.`);
          const survivors = tabs.filter((tab) => tab.id !== target.id);
          await call("browser_tabs", { action: "close", index: target.index }, signal);
          // ARCHITECTURE §13: losing the last controlled tab ends the connection.
          // A browser that opens a replacement page of its own is not an
          // invitation to adopt it.
          if (survivors.length === 0) {
            tabs = [];
            activeTabId = undefined;
            phase = "disconnected";
            message = "the last attached tab was closed";
            return listed(true, `Closed ${request.tabId}.`);
          }
          try {
            await listTabs(signal);
          } catch (error) {
            if (error instanceof BrowserDriverError && error.code === "aborted") throw error;
            tabs = [];
            activeTabId = undefined;
          }
          if (tabs.length === 0) {
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
      throwIfAborted(signal);
      if (phase !== "takeover") {
        throw new BrowserDriverError("unsupported", "the connection is not in takeover");
      }
      phase = "ready";
      message = undefined;
      await listTabs(signal);
      const tab = tabById(activeTabId);
      // Resuming always re-observes, and the fresh observation invalidates every
      // reference minted before the user touched the page (ARCHITECTURE §7).
      revisionSeq += 1;
      tab.revision = revisionSeq;
      tab.signature = "";
      const page = await readPage(tab.id, signal);
      revisionSeq += 1;
      page.tab.revision = revisionSeq;
      return observationFor(page, {}, signal);
    },

    sever() {
      severed = "browser-crashed";
      phase = "failed";
      message = "the browser connection was lost";
      options.onSevered?.();
    },

    authorize(document) {
      documents.set(document.id, document);
    },

    sidecar: () => sidecar,
  };

  return driver;
}
