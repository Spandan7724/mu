import type { DownloadRecord } from "../browser/downloads.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { Tab, TabInfo } from "../browser/tabs.ts";
import { type ResolvedRef, resolveRef } from "../page/resolve.ts";
import { type SettleResult, watchSettle } from "../page/settle.ts";
import {
  clickablePoint,
  hitTest,
  type Modifier,
  type MouseButton,
  mouseClick,
  mouseDrag,
  mouseMove,
  type Occluder,
  type Point,
  sessionOffset,
} from "./pointer.ts";
import type { OutcomeKind, Stopwatch } from "./types.ts";

export interface ActionContext {
  tab: Tab;
  browser: BrowserManager;
  stopwatch: Stopwatch;
  signal: AbortSignal;
}

export interface ActionResult {
  ok?: boolean;
  summary: string;
  kind?: OutcomeKind;
  settle?: string;
  tab?: Tab;
  extra?: string;
  path?: "mouse" | "js" | "keyboard";
  occludedBy?: Occluder;
  newTab?: TabInfo;
}

interface TargetInfo {
  tag: string;
  type: string;
  disabled: boolean;
  options?: string[];
}

export async function targetInfo(target: ResolvedRef, signal?: AbortSignal): Promise<TargetInfo> {
  const result = await target.session.send(
    "Runtime.callFunctionOn",
    {
      objectId: target.objectId,
      functionDeclaration: `function () {
        var tag = this.tagName ? this.tagName.toLowerCase() : "";
        var info = { tag: tag, type: (this.type || "").toLowerCase(), disabled: !!this.disabled || this.getAttribute && this.getAttribute("aria-disabled") === "true" };
        if (tag === "select") info.options = Array.prototype.map.call(this.options, function (o) { return o.label || o.text; }).slice(0, 30);
        return info;
      }`,
      returnByValue: true,
    },
    { signal, timeoutMs: 3_000 },
  );
  return result.result.value as TargetInfo;
}

export async function viewportSize(tab: Tab, signal?: AbortSignal) {
  const metrics = await tab.session.send("Page.getLayoutMetrics", undefined, {
    signal,
    timeoutMs: 3_000,
  });
  return {
    width: metrics.cssVisualViewport.clientWidth,
    height: metrics.cssVisualViewport.clientHeight,
  };
}

export function describeOccluder(occluder: Occluder): string {
  const cover = `${occluder.role}${occluder.name ? ` ${JSON.stringify(occluder.name)}` : ""}${occluder.ref ? ` [${occluder.ref}]` : ""}`;
  const inside = occluder.inside
    .map((item) => `${item.role} ${JSON.stringify(item.name)}${item.ref ? ` [${item.ref}]` : ""}`)
    .join(", ");
  return `${cover}${inside ? ` (it contains: ${inside})` : ""}`;
}

function settleNote(settle: SettleResult): string {
  if (settle.navigated) return " → navigated";
  if (settle.reason.startsWith("a JavaScript dialog")) return " → a JavaScript dialog opened";
  return "";
}

// Brings a popup opened by the action into focus and reports it.
async function adoptNewTab(
  ctx: ActionContext,
  since: number,
): Promise<{ tab: Tab; info: TabInfo } | undefined> {
  const opened = ctx.browser.openedSince(since, [ctx.tab.targetId]);
  const newest = opened.at(-1);
  if (!newest) return undefined;
  const tab = await ctx.browser.switchTab(newest.tabId, ctx.signal);
  await tab.session
    .send(
      "Runtime.evaluate",
      {
        expression:
          "new Promise(function (r) { if (document.readyState !== 'loading') r(); else addEventListener('DOMContentLoaded', function () { r(); }); })",
        awaitPromise: true,
      },
      { signal: ctx.signal, timeoutMs: 10_000 },
    )
    .catch(() => {});
  return { tab, info: { ...newest, active: true } };
}

// A JS dialog opened by the action blocks the renderer, so the input call that
// triggered it does not return until the dialog is handled; stop waiting then.
export async function raceDialog(tab: Tab, work: Promise<unknown>): Promise<"done" | "dialog"> {
  let off: (() => void) | undefined;
  const dialog = new Promise<"dialog">((resolve) => {
    off = tab.session.on("Page.javascriptDialogOpening", () => resolve("dialog"));
  });
  try {
    const outcome = await Promise.race([work.then(() => "done" as const), dialog]);
    if (outcome === "dialog") work.catch(() => {});
    return outcome;
  } finally {
    off?.();
  }
}

// Runs a pointer action between a settle watcher and new-tab detection.
async function withSettle(
  ctx: ActionContext,
  action: () => Promise<void>,
): Promise<{
  settle: SettleResult;
  newTab?: { tab: Tab; info: TabInfo };
  downloads?: DownloadRecord[];
}> {
  const watcher = watchSettle(ctx.tab, "in-page");
  const since = Date.now() - 50;
  try {
    await ctx.stopwatch.time("cdpMs", () => raceDialog(ctx.tab, action()));
  } catch (error) {
    watcher.dispose();
    throw error;
  }
  const settle = await ctx.stopwatch.time("settleMs", () => watcher.settle(ctx.signal));
  const newTab = await adoptNewTab(ctx, since);
  if (settle.reason.includes("download")) {
    await ctx.browser.downloads.waitForStart(since, 2_000, ctx.signal);
  }
  await ctx.browser.downloads.waitForFinished(since, 5_000, ctx.signal);
  const downloads = ctx.browser.downloads.since(since);
  return { settle, ...(newTab ? { newTab } : {}), ...(downloads.length > 0 ? { downloads } : {}) };
}

export async function mainPoint(
  ctx: ActionContext,
  target: ResolvedRef,
  point: Point,
): Promise<Point> {
  if (target.session === ctx.tab.session) return point;
  const offset = await sessionOffset(ctx.tab, target.frameId, ctx.signal);
  return { x: point.x + offset.x, y: point.y + offset.y };
}

export async function clickRef(
  ctx: ActionContext,
  ref: string,
  options: { button?: MouseButton; double?: boolean; modifiers?: Modifier[] } = {},
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const target = await ctx.stopwatch.time("cdpMs", () => resolveRef(tab, ref, signal));
  const label = tab.refs.label(ref);
  const info = await targetInfo(target, signal);
  if (info.tag === "select") {
    return {
      ok: false,
      kind: "not-interactable",
      summary: `${label} is a dropdown: use the select tool with one of its options`,
      extra: `options: ${(info.options ?? []).map((option) => JSON.stringify(option)).join(", ")}`,
    };
  }
  const verb = options.double
    ? "double-clicked"
    : options.button === "right"
      ? "right-clicked"
      : "clicked";
  const viewport = await viewportSize(tab, signal);
  let point = await ctx.stopwatch.time("cdpMs", () => clickablePoint(target, viewport, signal));
  if (!point) {
    // Zero-size custom controls: let the element's own click handler run.
    const { settle, newTab } = await withSettle(ctx, async () => {
      await target.session.send(
        "Runtime.callFunctionOn",
        {
          objectId: target.objectId,
          functionDeclaration:
            "function () { var el = (this.labels && this.labels[0]) || this.closest('label') || this; el.click(); }",
        },
        { signal, timeoutMs: 5_000 },
      );
    });
    return {
      summary: `${verb} ${label} via JavaScript (it has no visible box)${settleNote(settle)}`,
      path: "js",
      settle: `${settle.reason} (${settle.ms} ms)`,
      ...newTabResult(newTab),
    };
  }
  const test = (at: Point) =>
    ctx.stopwatch.time("cdpMs", () =>
      hitTest(
        target,
        at,
        (frameId, backendNodeId) => tab.refs.refOf(frameId, backendNodeId),
        signal,
      ),
    );
  let hit = await test(point);
  if (!hit.ok) {
    // Hover menus opened by where the pointer was left, and overlays still
    // animating out, clear once the pointer moves onto the target.
    const moveTo = await mainPoint(ctx, target, point);
    await withSettle(ctx, async () => {
      await mouseMove(tab.session, moveTo, signal);
    });
    point = (await clickablePoint(target, viewport, signal)) ?? point;
    hit = await test(point);
  }
  if (!hit.ok) {
    return {
      ok: false,
      kind: "occluded",
      occludedBy: hit.occluder,
      summary: `did not click ${label}: it is covered by ${describeOccluder(hit.occluder)}. Close, accept or dismiss that first.`,
    };
  }
  const at = await mainPoint(ctx, target, point);
  const { settle, newTab, downloads } = await withSettle(ctx, () =>
    mouseClick(tab.session, at, {
      ...(options.button ? { button: options.button } : {}),
      clickCount: options.double ? 2 : 1,
      ...(options.modifiers ? { modifiers: options.modifiers } : {}),
      signal,
    }),
  );
  return {
    summary: `${verb} ${label}${newTab ? "" : settleNote(settle)}`,
    path: "mouse",
    settle: `${settle.reason} (${settle.ms} ms)`,
    ...(settle.navigated ? { kind: "navigated" as const } : {}),
    ...newTabResult(newTab),
    ...downloadResult(downloads),
  };
}

function downloadResult(downloads: DownloadRecord[] | undefined): Partial<ActionResult> {
  if (!downloads || downloads.length === 0) return {};
  return {
    extra: downloads
      .map((record) => `→ download ${record.state}: ${record.filename} → ${record.path}`)
      .join("\n"),
  };
}

function newTabResult(newTab: { tab: Tab; info: TabInfo } | undefined): Partial<ActionResult> {
  if (!newTab) return {};
  return {
    kind: "new-tab",
    tab: newTab.tab,
    newTab: newTab.info,
    extra: `→ opened new tab ${newTab.info.tabId} (${newTab.info.url}); it is now the active tab`,
  };
}

export async function clickPoint(
  ctx: ActionContext,
  point: Point,
  options: { button?: MouseButton; double?: boolean } = {},
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const hit = await tab.session
    .send(
      "DOM.getNodeForLocation",
      { x: Math.round(point.x), y: Math.round(point.y) },
      { signal, timeoutMs: 3_000 },
    )
    .catch(() => undefined);
  const hitRef = hit
    ? tab.refs.refOf(hit.frameId ?? tab.frames.mainFrameId ?? "", hit.backendNodeId)
    : undefined;
  const { settle, newTab } = await withSettle(ctx, () =>
    mouseClick(tab.session, point, {
      ...(options.button ? { button: options.button } : {}),
      clickCount: options.double ? 2 : 1,
      signal,
    }),
  );
  const target = hitRef ? ` on ${tab.refs.label(hitRef)}` : "";
  return {
    summary: `clicked at (${Math.round(point.x)}, ${Math.round(point.y)})${target}${newTab ? "" : settleNote(settle)}`,
    path: "mouse",
    settle: `${settle.reason} (${settle.ms} ms)`,
    ...newTabResult(newTab),
  };
}

export async function hoverRef(ctx: ActionContext, ref: string): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const target = await resolveRef(tab, ref, signal);
  const label = tab.refs.label(ref);
  const point = await clickablePoint(target, await viewportSize(tab, signal), signal);
  if (!point)
    return { ok: false, kind: "not-interactable", summary: `${label} has no visible box to hover` };
  const at = await mainPoint(ctx, target, point);
  let delivered = true;
  const { settle } = await withSettle(ctx, async () => {
    delivered = await mouseMove(tab.session, at, signal);
  });
  if (!delivered)
    return {
      ok: false,
      kind: "timeout",
      summary: `hover over ${label} did not reach the page: the browser window is not being drawn (hidden or on another workspace); ask the user to keep it visible, or click instead`,
    };
  return {
    summary: `hovered ${label}${settleNote(settle)}`,
    path: "mouse",
    settle: `${settle.reason} (${settle.ms} ms)`,
  };
}

export async function dragBetween(
  ctx: ActionContext,
  from: string | Point,
  to: string | Point,
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const viewport = await viewportSize(tab, signal);
  const locate = async (end: string | Point): Promise<{ point: Point; label: string }> => {
    if (typeof end !== "string") return { point: end, label: `(${end.x}, ${end.y})` };
    const target = await resolveRef(tab, end, signal);
    const point = await clickablePoint(target, viewport, signal);
    if (!point) throw new Error(`${tab.refs.label(end)} has no visible box`);
    return { point: await mainPoint(ctx, target, point), label: tab.refs.label(end) };
  };
  const start = await locate(from);
  const end = await locate(to);
  const drag: { mode: "html5" | "pointer" } = { mode: "pointer" };
  const { settle } = await withSettle(ctx, async () => {
    drag.mode = await mouseDrag(tab.session, start.point, end.point, signal);
  });
  return {
    summary: `dragged ${start.label} to ${end.label}${drag.mode === "html5" ? " (drag and drop)" : ""}${settleNote(settle)}`,
    path: "mouse",
    settle: `${settle.reason} (${settle.ms} ms)`,
  };
}
