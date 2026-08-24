// A scripted sidecar: it answers the same tool calls as `@playwright/mcp` 0.0.79,
// in the same response shapes, over the deterministic site `drivers/fake/site.ts`
// already describes.
//
// It exists so the real adapter — its parsing, its reference discipline, its
// commitment routing and its failure taxonomy — runs the whole driver conformance
// suite in CI without a browser, and so the same suite can then be pointed at a
// live browser without changing a single case.
import { BrowserDriverError } from "../../contracts/driver.ts";
import type { FakeSubmissionRecord } from "../fake/driver.ts";
import {
  defaultFakeSite,
  FAKE_SCREENSHOT_PNG,
  type FakeElementSpec,
  type FakePageSpec,
  type FakeSite,
} from "../fake/site.ts";
import type { McpCallOptions, McpServerIdentity, McpSidecar, McpToolResult } from "./protocol.ts";
import { PINNED_SERVER_VERSION } from "./sidecar.ts";

export interface ScriptedSidecarOptions {
  site?: FakeSite | undefined;
  serverIdentity?: McpServerIdentity | undefined;
  // Fails the next call with this message, then clears.
  now?: (() => number) | undefined;
}

export interface ScriptedSidecar extends McpSidecar {
  submissions(): FakeSubmissionRecord[];
  // Files the sidecar was asked to upload, by absolute path, so a test can prove
  // a path never came from the model.
  uploadedPaths(): string[];
  // Everything the sidecar wrote, by absolute path. Always inside the output
  // directory it was configured with.
  writtenPaths(): string[];
  failNext(error: BrowserDriverError): void;
  closed(): boolean;
}

interface ScriptedTab {
  history: string[];
  historyIndex: number;
  scrollX: number;
  scrollY: number;
  values: Map<string, string>;
  checked: Map<string, boolean>;
  selected: Map<string, string[]>;
  elementScrolls: Map<string, { x: number; y: number }>;
  focused?: string | undefined;
}

interface RefEntry {
  spec: FakeElementSpec;
  frameIndex?: number | undefined;
}

const VIEWPORT = { width: 1_280, height: 720 };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new BrowserDriverError("aborted", "the call was cancelled"));
      },
      { once: true },
    );
  });
}

function text(value: string): McpToolResult {
  return { content: [{ type: "text", text: value }] };
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function createScriptedSidecar(options: ScriptedSidecarOptions = {}): ScriptedSidecar {
  const site = options.site ?? defaultFakeSite();
  const now = options.now ?? (() => Date.now());
  const identity = options.serverIdentity ?? { name: "Playwright", version: PINNED_SERVER_VERSION };
  const outputDir = "/mu-artifacts/sidecar";

  let tabs: ScriptedTab[] = [];
  let launched = false;
  let current = 0;
  let closed = false;
  let dialog: { kind: string; message: string } | undefined;
  let fileChooser: string | undefined;
  // A commitment whose page raised a confirmation first, and the control whose guard
  // has already been accepted. A commitment happens only once its guard is answered.
  let pendingCommit: { tab: ScriptedTab; found: RefEntry } | undefined;
  let acceptedGuard: string | undefined;
  let injected: BrowserDriverError | undefined;
  const submissions: FakeSubmissionRecord[] = [];
  const uploads: string[] = [];
  const written: string[] = [];

  const newTab = (url: string): ScriptedTab => ({
    history: [url],
    historyIndex: 0,
    scrollX: 0,
    scrollY: 0,
    values: new Map(),
    checked: new Map(),
    selected: new Map(),
    elementScrolls: new Map(),
  });

  // The browser opens on the first call and stays open. Closing its last page
  // does not reopen one: that is the state a driver has to notice.
  const launch = (): void => {
    if (launched) return;
    launched = true;
    tabs = [newTab(site.landingUrl)];
    current = 0;
  };

  const tab = (): ScriptedTab => {
    launch();
    const found = tabs[current] ?? tabs[0];
    if (!found) throw new BrowserDriverError("connection-lost", "the browser has no page");
    return found;
  };

  const urlOf = (entry: ScriptedTab): string => entry.history[entry.historyIndex] as string;

  const pageOf = (entry: ScriptedTab): FakePageSpec => {
    const url = urlOf(entry);
    return (
      site.pages.get(url) ?? { url, title: "Not found", summary: "No such page.", elements: [] }
    );
  };

  // Refs are minted by the sidecar, exactly as Playwright mints them: stable for
  // an unchanged page, prefixed by frame ordinal inside a frame.
  const refsOf = (page: FakePageSpec): Map<string, RefEntry> => {
    const frames = page.frames ?? [];
    const map = new Map<string, RefEntry>();
    const counters = new Map<string, number>();
    for (const spec of page.elements) {
      const frameIndex =
        spec.frameId === undefined
          ? undefined
          : frames.findIndex((frame) => frame.id === spec.frameId) + 1;
      const prefix = frameIndex === undefined || frameIndex <= 0 ? "" : `f${frameIndex}`;
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      map.set(`${prefix}e${next}`, {
        spec,
        ...(frameIndex === undefined || frameIndex <= 0 ? {} : { frameIndex }),
      });
    }
    return map;
  };

  const findRef = (entry: ScriptedTab, ref: string): RefEntry | undefined =>
    refsOf(pageOf(entry)).get(ref);

  const currentValue = (entry: ScriptedTab, spec: FakeElementSpec): string | undefined => {
    if (spec.secretValue !== undefined) return spec.secretValue;
    return entry.values.get(spec.ref) ?? spec.value;
  };

  const renderSnapshot = (entry: ScriptedTab): string => {
    const page = pageOf(entry);
    const lines: string[] = ["- generic [active] [ref=e0]:"];
    for (const frame of page.frames ?? []) {
      lines.push(
        `  - iframe${frame.name === undefined ? "" : ` ${quote(frame.name)}`} [ref=fr${(page.frames ?? []).indexOf(frame) + 1}]: ${frame.url}`,
      );
    }
    for (const [ref, entryRef] of refsOf(page)) {
      const spec = entryRef.spec;
      const attributes: string[] = [];
      const checked = entry.checked.get(spec.ref) ?? spec.checked;
      if (checked === true) attributes.push("[checked]");
      if (spec.disabled === true) attributes.push("[disabled]");
      if (entry.focused === spec.ref) attributes.push("[active]");
      attributes.push(`[ref=${ref}]`);
      const value = currentValue(entry, spec);
      const name = spec.name ?? spec.label;
      const head = `  - ${spec.role ?? "generic"}${name === undefined ? "" : ` ${quote(name)}`} ${attributes.join(" ")}`;
      const chosen = entry.selected.get(spec.ref);
      if (spec.options !== undefined && spec.options.length > 0) {
        lines.push(`${head}:`);
        for (const option of spec.options) {
          const key = option.value ?? option.label;
          const selected = chosen?.includes(key) === true ? " [selected]" : "";
          lines.push(`    - option ${quote(option.label)}${selected}`);
        }
        continue;
      }
      lines.push(value === undefined || value.length === 0 ? head : `${head}: ${value}`);
    }
    return lines.join("\n");
  };

  const pageSection = (entry: ScriptedTab): string =>
    ["### Page", `- Page URL: ${urlOf(entry)}`, `- Page Title: ${pageOf(entry).title}`].join("\n");

  const snapshotResponse = (entry: ScriptedTab, extra: string[] = []): McpToolResult => {
    // A real sidecar writes the snapshot into its output directory. Recording the
    // path here is what lets a test prove it is never the process cwd.
    written.push(`${outputDir}/page-${now()}.yml`);
    return text(
      [
        pageSection(entry),
        "### Snapshot",
        "```yaml",
        renderSnapshot(entry),
        "```",
        // A raised dialog stays in the response until it is handled, exactly as a
        // real browser keeps its modal state.
        ...(dialog === undefined
          ? []
          : [
              "### Modal state",
              `- ["${dialog.kind}" dialog with message "${dialog.message}"]: can be handled by the "browser_handle_dialog" tool`,
            ]),
        ...extra,
      ].join("\n"),
    );
  };

  const goTo = (entry: ScriptedTab, target: string): void => {
    let url = target;
    for (let hop = 0; hop < 5; hop++) {
      const next = site.pages.get(url)?.redirectTo;
      if (next === undefined) break;
      url = next;
    }
    if (url === urlOf(entry)) {
      // Navigating to the current URL is a reload, not a new history entry.
      entry.values = new Map();
      entry.checked = new Map();
      entry.selected = new Map();
      entry.elementScrolls = new Map();
      entry.scrollX = 0;
      entry.scrollY = 0;
      return;
    }
    entry.history = [...entry.history.slice(0, entry.historyIndex + 1), url];
    entry.historyIndex = entry.history.length - 1;
    entry.values = new Map();
    entry.checked = new Map();
    entry.selected = new Map();
    entry.elementScrolls = new Map();
    entry.scrollX = 0;
    entry.scrollY = 0;
    entry.focused = undefined;
  };

  const recordSubmission = (entry: ScriptedTab): void => {
    const page = pageOf(entry);
    const fields: Record<string, string> = {};
    const files: FakeSubmissionRecord["files"] = [];
    for (const spec of page.elements) {
      const label = spec.label ?? spec.name ?? spec.ref;
      if (spec.inputType === "file") {
        for (const basename of (entry.values.get(spec.ref) ?? "").split(", ").filter(Boolean)) {
          files.push({ field: label, basename });
        }
        continue;
      }
      const value = entry.values.get(spec.ref);
      if (value !== undefined && value.length > 0) fields[label] = value;
    }
    submissions.push({ path: new URL(page.url).pathname, fields, files });
  };

  const tabList = (): McpToolResult => {
    launch();
    const lines = tabs.map(
      (entry, index) =>
        `- ${index}: ${index === current ? "(current) " : ""}[${pageOf(entry).title}](${urlOf(entry)})`,
    );
    return text(["### Result", ...lines].join("\n"));
  };

  const numbers = (source: string): number[] =>
    [...source.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));

  const evaluate = (entry: ScriptedTab, fn: string, target: string | undefined): McpToolResult => {
    if (/window\.innerWidth/.test(fn)) {
      return text(
        [
          "### Result",
          JSON.stringify({
            width: VIEWPORT.width,
            height: VIEWPORT.height,
            scrollX: entry.scrollX,
            scrollY: entry.scrollY,
            readyState: "complete",
            frameUrls: (pageOf(entry).frames ?? []).map((frame) => frame.url),
            visibleControls: [],
            visibleFramePrefixes: [],
          }),
        ].join("\n"),
      );
    }
    if (/scrollBy/.test(fn)) {
      const [deltaX = 0, deltaY = 0] = numbers(fn);
      if (target !== undefined) {
        const before = entry.elementScrolls.get(target) ?? { x: 0, y: 0 };
        const after = {
          x: Math.max(0, before.x + deltaX),
          y: Math.max(0, before.y + deltaY),
        };
        entry.elementScrolls.set(target, after);
        return text(
          `### Result\n${JSON.stringify({
            moved: after.x !== before.x || after.y !== before.y,
            beforeX: before.x,
            beforeY: before.y,
            afterX: after.x,
            afterY: after.y,
          })}`,
        );
      }
      const before = { x: entry.scrollX, y: entry.scrollY };
      const height = pageOf(entry).contentHeight ?? VIEWPORT.height;
      entry.scrollX = Math.max(0, entry.scrollX + deltaX);
      entry.scrollY = Math.min(
        Math.max(0, height - VIEWPORT.height),
        Math.max(0, entry.scrollY + deltaY),
      );
      return text(
        `### Result\n${JSON.stringify({
          moved: entry.scrollX !== before.x || entry.scrollY !== before.y,
          beforeX: before.x,
          beforeY: before.y,
          afterX: entry.scrollX,
          afterY: entry.scrollY,
        })}`,
      );
    }
    if (/history\.forward/.test(fn)) {
      if (entry.historyIndex + 1 < entry.history.length) entry.historyIndex += 1;
      return text("### Result\nundefined");
    }
    if (/element\.focus/.test(fn)) {
      const found = target === undefined ? undefined : findRef(entry, target);
      entry.focused = found?.spec.ref;
      return text("### Result\nundefined");
    }
    return text("### Result\nundefined");
  };

  const clickOutcome = (entry: ScriptedTab, found: RefEntry): McpToolResult => {
    const spec = found.spec;
    const behavior = spec.behavior;
    if (spec.inputType === "file") {
      fileChooser = spec.ref;
      return text(
        [
          pageSection(entry),
          "### Modal state",
          '- [File chooser]: can be handled by the "browser_file_upload" tool',
        ].join("\n"),
      );
    }
    if (behavior?.kind === "open-tab") {
      tabs.push(newTab(behavior.url));
      current = tabs.length - 1;
      return snapshotResponse(tab());
    }
    if (behavior?.kind === "dialog") {
      dialog = { kind: behavior.dialogKind, message: behavior.message };
      return text(
        [
          pageSection(entry),
          "### Modal state",
          `- ["${behavior.dialogKind}" dialog with message "${behavior.message}"]: can be handled by the "browser_handle_dialog" tool`,
        ].join("\n"),
      );
    }
    if (behavior?.kind === "download") {
      written.push(`${outputDir}/${behavior.download.basename}`);
      return text(
        [
          pageSection(entry),
          "### Events",
          `- Downloaded file ${behavior.download.basename} to ${outputDir}/${behavior.download.basename}`,
        ].join("\n"),
      );
    }
    if (behavior?.kind === "commit") {
      if (behavior.guard !== undefined && acceptedGuard !== spec.ref) {
        // The page asks before it commits. Nothing is sent until the dialog is
        // accepted; dismissing it leaves the page exactly where it was.
        pendingCommit = { tab: entry, found };
        dialog = { kind: behavior.guard.dialogKind, message: behavior.guard.message };
        return text(
          [
            pageSection(entry),
            "### Modal state",
            `- ["${behavior.guard.dialogKind}" dialog with message "${behavior.guard.message}"]: can be handled by the "browser_handle_dialog" tool`,
          ].join("\n"),
        );
      }
      acceptedGuard = undefined;
      recordSubmission(entry);
      goTo(entry, behavior.resultUrl);
      if (behavior.confirmation === "unknown") {
        // The ambiguous endpoint stalls rather than resetting the connection, so
        // the sidecar reports a navigation timeout after the effect happened.
        throw new BrowserDriverError(
          "timeout",
          "Timeout 5000ms exceeded while waiting for navigation to settle",
        );
      }
      return snapshotResponse(entry);
    }
    if (spec.role === "checkbox" || spec.role === "radio" || spec.role === "switch") {
      const state = entry.checked.get(spec.ref) ?? spec.checked === true;
      entry.checked.set(spec.ref, !state);
    }
    return snapshotResponse(entry);
  };

  const requireRef = (entry: ScriptedTab, target: unknown): RefEntry => {
    const ref = typeof target === "string" ? findRef(entry, target) : undefined;
    if (!ref) {
      throw new BrowserDriverError(
        "unsupported",
        `Ref ${String(target)} not found in the current page snapshot. Try capturing new snapshot.`,
      );
    }
    return ref;
  };

  const handle = async (
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<McpToolResult> => {
    if (closed) {
      throw new BrowserDriverError("connection-lost", "Connection closed");
    }
    if (injected) {
      const failure = injected;
      injected = undefined;
      throw failure;
    }
    switch (name) {
      case "browser_tabs": {
        launch();
        const action = args.action;
        if (action === "new") {
          tabs.push(newTab(typeof args.url === "string" ? args.url : site.landingUrl));
          current = tabs.length - 1;
          return tabList();
        }
        if (action === "select") {
          const index = Number(args.index);
          if (!Number.isInteger(index) || index < 0 || index >= tabs.length) {
            throw new BrowserDriverError(
              "unsupported",
              `Tab index ${String(args.index)} not found`,
            );
          }
          current = index;
          return tabList();
        }
        if (action === "close") {
          const index = Number(args.index);
          if (Number.isInteger(index) && index >= 0 && index < tabs.length) {
            tabs.splice(index, 1);
            current = Math.max(0, Math.min(current, tabs.length - 1));
          }
          if (tabs.length === 0) return text("### Result");
          return tabList();
        }
        return tabList();
      }
      case "browser_snapshot":
        return snapshotResponse(tab());
      case "browser_navigate": {
        const entry = tab();
        goTo(entry, String(args.url));
        return snapshotResponse(entry);
      }
      case "browser_navigate_back": {
        const entry = tab();
        if (entry.historyIndex > 0) entry.historyIndex -= 1;
        return snapshotResponse(entry);
      }
      case "browser_evaluate": {
        const entry = tab();
        return evaluate(
          entry,
          String(args.function ?? ""),
          typeof args.target === "string" ? args.target : undefined,
        );
      }
      case "browser_click": {
        const entry = tab();
        return clickOutcome(entry, requireRef(entry, args.target));
      }
      case "browser_hover": {
        const entry = tab();
        requireRef(entry, args.target);
        return snapshotResponse(entry);
      }
      case "browser_drag": {
        const entry = tab();
        requireRef(entry, args.startTarget);
        requireRef(entry, args.endTarget);
        return snapshotResponse(entry);
      }
      case "browser_type": {
        const entry = tab();
        const found = requireRef(entry, args.target);
        const value = String(args.text ?? "");
        entry.values.set(
          found.spec.ref,
          args.slowly === true ? `${currentValue(entry, found.spec) ?? ""}${value}` : value,
        );
        entry.focused = found.spec.ref;
        return snapshotResponse(entry);
      }
      case "browser_select_option": {
        const entry = tab();
        const found = requireRef(entry, args.target);
        const values = Array.isArray(args.values) ? args.values.map(String) : [];
        const known = new Set(
          (found.spec.options ?? []).map((option) => option.value ?? option.label),
        );
        const unknown = values.filter((value) => !known.has(value));
        if (unknown.length > 0) {
          throw new BrowserDriverError(
            "unsupported",
            `Option ${unknown.join(", ")} not found in the select`,
          );
        }
        entry.selected.set(found.spec.ref, values);
        entry.values.set(found.spec.ref, values[0] ?? "");
        return snapshotResponse(entry);
      }
      case "browser_press_key": {
        const entry = tab();
        const key = String(args.key ?? "");
        const focused = entry.focused;
        if (focused !== undefined && key.length === 1) {
          const spec = pageOf(entry).elements.find((element) => element.ref === focused);
          if (spec && (spec.role === "textbox" || spec.inputType === "text")) {
            entry.values.set(focused, `${currentValue(entry, spec) ?? ""}${key}`);
          }
        }
        return snapshotResponse(entry);
      }
      case "browser_wait_for": {
        const entry = tab();
        const wanted = typeof args.text === "string" ? args.text : undefined;
        const page = pageOf(entry);
        const haystack = [page.title, page.summary, ...(page.text ?? [])];
        if (wanted === undefined || haystack.some((line) => line.includes(wanted))) {
          return snapshotResponse(entry);
        }
        await sleep(options.timeoutMs ?? 5_000, options.signal);
        throw new BrowserDriverError(
          "timeout",
          `Timeout ${options.timeoutMs ?? 5_000}ms exceeded while waiting for text ${wanted}`,
        );
      }
      case "browser_take_screenshot": {
        const entry = tab();
        written.push(`${outputDir}/page-${now()}.png`);
        return {
          content: [
            { type: "image", mimeType: "image/png", data: FAKE_SCREENSHOT_PNG },
            { type: "text", text: pageSection(entry) },
          ],
        };
      }
      case "browser_file_upload": {
        const entry = tab();
        if (fileChooser === undefined) {
          throw new BrowserDriverError("unsupported", "No file chooser is visible");
        }
        const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
        uploads.push(...paths);
        entry.values.set(
          fileChooser,
          paths.map((path) => path.split(/[/\\]/).pop() ?? path).join(", "),
        );
        fileChooser = undefined;
        return snapshotResponse(entry);
      }
      case "browser_handle_dialog": {
        dialog = undefined;
        const guarded = pendingCommit;
        pendingCommit = undefined;
        if (guarded !== undefined && args.accept === true) {
          acceptedGuard = guarded.found.spec.ref;
          return clickOutcome(guarded.tab, guarded.found);
        }
        return snapshotResponse(tab());
      }
      case "browser_close": {
        tabs = [];
        launched = false;
        current = 0;
        dialog = undefined;
        pendingCommit = undefined;
        acceptedGuard = undefined;
        fileChooser = undefined;
        return text("### Result");
      }
      default:
        throw new BrowserDriverError("unsupported", `Unknown tool: ${name}`);
    }
  };

  return {
    async callTool(name, args, callOptions) {
      if (callOptions.signal.aborted) {
        throw new BrowserDriverError("aborted", `${name} was cancelled before it started`);
      }
      return handle(name, args, callOptions);
    },
    serverIdentity: () => identity,
    async close() {
      closed = true;
      tabs = [];
    },
    submissions: () => submissions.map((entry) => ({ ...entry })),
    uploadedPaths: () => [...uploads],
    writtenPaths: () => [...written],
    failNext(error) {
      injected = error;
    },
    closed: () => closed,
  };
}
