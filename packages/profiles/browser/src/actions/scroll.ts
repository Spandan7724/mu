import { resolveRef } from "../page/resolve.ts";
import { watchSettle } from "../page/settle.ts";
import type { ActionContext, ActionResult } from "./click.ts";

export interface ScrollOptions {
  direction?: "up" | "down" | "left" | "right";
  to?: "top" | "bottom";
  amount?: "page" | "half" | number;
  ref?: string;
}

interface ScrollState {
  top: number;
  left: number;
  height: number;
  width: number;
  viewHeight: number;
  viewWidth: number;
  what: string;
}

// Scrolls the given element's scroll container, or the page — falling back to the
// largest scrollable element when the document itself does not scroll (app shells).
const SCROLL = `function (dx, dy, to, amount) {
  function scrollable(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    var style = getComputedStyle(el);
    var y = /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
    var x = /(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
    return y || x;
  }
  var target = null;
  if (this && this.nodeType === 1) {
    for (var n = this; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) if (scrollable(n)) { target = n; break; }
  }
  var page = document.scrollingElement || document.documentElement;
  if (!target && page.scrollHeight <= window.innerHeight + 1 && page.scrollWidth <= window.innerWidth + 1) {
    var best = null, area = 0, all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      if (!scrollable(all[i])) continue;
      var r = all[i].getBoundingClientRect();
      var a = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      if (a > area) { area = a; best = all[i]; }
    }
    target = best;
  }
  var el = target || page;
  var viewH = target ? el.clientHeight : window.innerHeight, viewW = target ? el.clientWidth : window.innerWidth;
  function state() {
    return { top: Math.round(el.scrollTop), left: Math.round(el.scrollLeft), height: el.scrollHeight, width: el.scrollWidth,
      viewHeight: viewH, viewWidth: viewW,
      what: target ? (target.getAttribute("aria-label") || target.id || target.tagName.toLowerCase()) : "page" };
  }
  var before = state();
  var stepY = amount === "page" ? viewH * 0.9 : amount === "half" ? viewH / 2 : amount;
  var stepX = amount === "page" ? viewW * 0.9 : amount === "half" ? viewW / 2 : amount;
  if (to === "top") el.scrollTo({ top: 0, behavior: "instant" });
  else if (to === "bottom") el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  else el.scrollBy({ left: dx * stepX, top: dy * stepY, behavior: "instant" });
  return { before: before, after: state() };
}`;

export async function scrollPage(
  ctx: ActionContext,
  options: ScrollOptions,
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const direction = options.direction ?? (options.to ? undefined : "down");
  const dx = direction === "left" ? -1 : direction === "right" ? 1 : 0;
  const dy = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  const amount = options.amount ?? "page";
  const watcher = watchSettle(tab, "in-page");
  let before: ScrollState;
  let moved: ScrollState;
  let session = tab.session;
  let objectId: string | undefined;
  try {
    if (options.ref) {
      const target = await resolveRef(tab, options.ref, signal);
      session = target.session;
      objectId = target.objectId;
    }
    const call = await ctx.stopwatch.time("cdpMs", async () => {
      if (objectId) {
        return session.send(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: SCROLL,
            arguments: [
              { value: dx },
              { value: dy },
              { value: options.to ?? null },
              { value: amount },
            ],
            returnByValue: true,
          },
          { signal, timeoutMs: 5_000 },
        );
      }
      return session.send(
        "Runtime.evaluate",
        {
          expression: `(${SCROLL}).call(null, ${dx}, ${dy}, ${JSON.stringify(options.to ?? null)}, ${JSON.stringify(amount)})`,
          returnByValue: true,
        },
        { signal, timeoutMs: 5_000 },
      );
    });
    ({ before, after: moved } = call.result.value as { before: ScrollState; after: ScrollState });
  } catch (error) {
    watcher.dispose();
    throw error;
  }
  const settle = await ctx.stopwatch.time("settleMs", () => watcher.settle(signal));
  const after = await session
    .send(
      "Runtime.evaluate",
      {
        expression:
          moved.what === "page"
            ? "(function(){var p=document.scrollingElement||document.documentElement;return {top:Math.round(p.scrollTop),height:p.scrollHeight};})()"
            : "null",
        returnByValue: true,
      },
      { signal, timeoutMs: 3_000 },
    )
    .then((result) => result.result.value as { top: number; height: number } | null)
    .catch(() => null);
  const top = after?.top ?? moved.top;
  const height = after?.height ?? moved.height;
  const where =
    moved.what === "page"
      ? ""
      : ` in ${moved.what}${options.ref ? ` (${tab.refs.label(options.ref)})` : ""}`;
  const verb = options.to ? `scrolled to the ${options.to}` : `scrolled ${direction}`;
  const delta = Math.abs(moved.top - before.top) + Math.abs(moved.left - before.left);
  const parts = [`${verb}${where}${options.to ? "" : ` ${delta} px`} (now ${top}/${height} px)`];
  const atEnd = top + moved.viewHeight >= height - 2;
  if (delta === 0 && height === before.height) {
    parts.push(
      dy > 0 || options.to === "bottom"
        ? "already at the end"
        : dy < 0
          ? "already at the top"
          : "nothing to scroll",
    );
  } else if (dy > 0 || options.to === "bottom") {
    if (height > moved.height)
      parts.push(`content grew by ${height - moved.height} px (more loaded)`);
    else if (atEnd) parts.push("reached the end");
  }
  return {
    summary: parts.join("; "),
    settle: `${settle.reason} (${settle.ms} ms)`,
    ...(delta === 0 && height === before.height ? { kind: "no-change" as const } : {}),
  };
}
