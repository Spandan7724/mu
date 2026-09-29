import { resolveRef } from "../page/resolve.ts";
import { watchSettle } from "../page/settle.ts";
import { type ActionContext, type ActionResult, raceDialog } from "./click.ts";

export const MAX_WAIT_SECONDS = 30;
const MAX_RESULT_CHARS = 4_000;

// Event-driven: a MutationObserver re-checks the page text on every change.
const WAIT_FOR_TEXT = `function (text, gone, capMs) {
  return new Promise(function (resolve) {
    var needle = text.toLowerCase();
    function present() { return ((document.body && document.body.innerText) || "").toLowerCase().indexOf(needle) >= 0; }
    function satisfied() { return gone ? !present() : present(); }
    if (satisfied()) return resolve({ met: true, waited: 0 });
    var started = Date.now();
    var observer = new MutationObserver(function () { if (satisfied()) finish(true); });
    var timer = setTimeout(function () { finish(false); }, capMs);
    function finish(met) { observer.disconnect(); clearTimeout(timer); resolve({ met: met, waited: Date.now() - started }); }
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}`;

export async function waitFor(
  ctx: ActionContext,
  options: { text?: string | undefined; gone?: boolean | undefined; seconds?: number | undefined },
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const seconds = Math.min(
    MAX_WAIT_SECONDS,
    Math.max(0, options.seconds ?? (options.text ? 10 : 1)),
  );
  if (!options.text) {
    // The model asked for an explicit pause; this is the one sanctioned fixed wait.
    await ctx.stopwatch.time(
      "settleMs",
      () =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(done, seconds * 1_000);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          }
          signal.addEventListener("abort", done, { once: true });
        }),
    );
    return { summary: `waited ${seconds} s` };
  }
  const contextId = await tab.frames.isolatedWorld(tab.frames.mainFrameId ?? "", signal);
  const result = await ctx.stopwatch.time("settleMs", () =>
    tab.session.send(
      "Runtime.evaluate",
      {
        expression: `(${WAIT_FOR_TEXT})(${JSON.stringify(options.text)}, ${options.gone === true}, ${seconds * 1_000})`,
        contextId,
        awaitPromise: true,
        returnByValue: true,
      },
      { signal, timeoutMs: seconds * 1_000 + 2_000 },
    ),
  );
  const value = result.result.value as { met: boolean; waited: number } | undefined;
  const what = `${JSON.stringify(options.text)} ${options.gone ? "to disappear" : "to appear"}`;
  if (!value?.met) {
    return {
      ok: false,
      kind: "timeout",
      summary: `waited ${seconds} s for ${what}; it did not happen`,
    };
  }
  return { summary: `waited ${Math.round(value.waited)} ms for ${what}` };
}

export async function evaluateScript(
  ctx: ActionContext,
  source: string,
  ref?: string,
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const trimmed = source.trim();
  const isFunction = /^(async\s+)?(function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(trimmed);
  const watcher = watchSettle(tab, "in-page");
  let result: Awaited<ReturnType<typeof tab.session.send<"Runtime.evaluate">>> | undefined;
  try {
    if (ref) {
      const target = await resolveRef(tab, ref, signal);
      const call = target.session.send(
        "Runtime.callFunctionOn",
        {
          objectId: target.objectId,
          functionDeclaration: isFunction ? trimmed : `function () { return (${trimmed}); }`,
          arguments: [{ objectId: target.objectId }],
          returnByValue: true,
          awaitPromise: true,
        },
        { signal, timeoutMs: 10_000 },
      );
      if ((await raceDialog(tab, call)) === "done") result = await call;
    } else {
      const call = tab.session.send(
        "Runtime.evaluate",
        {
          expression: isFunction ? `(${trimmed})()` : trimmed,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
        { signal, timeoutMs: 10_000 },
      );
      if ((await raceDialog(tab, call)) === "done") result = await call;
    }
  } catch (error) {
    watcher.dispose();
    throw error;
  }
  const settle = await ctx.stopwatch.time("settleMs", () => watcher.settle(signal));
  if (!result) {
    return {
      summary: `ran script${ref ? ` on ${tab.refs.label(ref)}` : ""} → a JavaScript dialog opened`,
    };
  }
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    return { ok: false, kind: "error", summary: `script threw: ${message.split("\n")[0]}` };
  }
  let text: string;
  const value = result.result.value;
  if (result.result.type === "undefined") text = "undefined";
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const clipped =
    text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}… (${text.length} chars)`
      : text;
  return {
    summary: `ran script${ref ? ` on ${tab.refs.label(ref)}` : ""}${settle.navigated ? " → navigated" : ""}`,
    extra: `result (untrusted page data): ${clipped.replace(/<(\/?)page_content/gi, "‹$1page_content")}`,
    settle: `${settle.reason} (${settle.ms} ms)`,
  };
}
