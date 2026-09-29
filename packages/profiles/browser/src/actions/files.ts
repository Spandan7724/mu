import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Tab } from "../browser/tabs.ts";
import { resolveRef } from "../page/resolve.ts";
import { watchSettle } from "../page/settle.ts";
import { type ActionContext, type ActionResult, clickRef } from "./click.ts";

export function resolveUploadPaths(paths: string[], base = process.cwd()): string[] {
  return paths.map((path) => {
    const absolute = isAbsolute(path) ? path : resolve(base, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`File not found: ${absolute}`);
    }
    return absolute;
  });
}

// A page that rejects the file with alert() holds the call until the alert is
// answered; the dialog is the outcome, so stop waiting when one opens.
function unlessDialog(tab: Tab, call: Promise<unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = tab.session.on("Page.javascriptDialogOpening", () => {
      off();
      call.catch(() => {});
      resolve();
    });
    call.then(
      () => {
        off();
        resolve();
      },
      (error: unknown) => {
        off();
        reject(error);
      },
    );
  });
}

export async function uploadFiles(
  ctx: ActionContext,
  ref: string,
  paths: string[],
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const files = resolveUploadPaths(paths);
  const target = await resolveRef(tab, ref, signal);
  const label = tab.refs.label(ref);
  const isFileInput = await target.session
    .send(
      "Runtime.callFunctionOn",
      {
        objectId: target.objectId,
        functionDeclaration:
          "function () { return this.tagName === 'INPUT' && this.type === 'file'; }",
        returnByValue: true,
      },
      { signal, timeoutMs: 3_000 },
    )
    .then((result) => result.result.value === true);
  const names = files.map((file) => file.split(/[\\/]/).pop()).join(", ");
  if (isFileInput) {
    const watcher = watchSettle(tab, "in-page");
    try {
      await unlessDialog(
        tab,
        target.session.send(
          "DOM.setFileInputFiles",
          { files, backendNodeId: target.backendNodeId },
          { signal, timeoutMs: 10_000 },
        ),
      );
    } catch (error) {
      watcher.dispose();
      throw error;
    }
    const settle = await watcher.settle(signal);
    return {
      summary: `attached ${names} to ${label}`,
      path: "js",
      settle: `${settle.reason} (${settle.ms} ms)`,
    };
  }
  // A button that opens the native file chooser: intercept it and fill the chooser.
  await tab.session.send("Page.setInterceptFileChooserDialog", { enabled: true }, { signal });
  try {
    const opened = tab.session.waitFor("Page.fileChooserOpened", { signal, timeoutMs: 3_000 });
    opened.catch(() => {});
    const clicked = await clickRef(ctx, ref);
    if (clicked.ok === false) return clicked;
    const chooser = await opened.catch(() => undefined);
    if (!chooser?.backendNodeId) {
      return {
        ok: false,
        kind: "not-interactable",
        summary: `clicking ${label} did not open a file chooser; pass the ref of the file input instead`,
      };
    }
    const watcher = watchSettle(tab, "in-page");
    await unlessDialog(
      tab,
      tab.session.send(
        "DOM.setFileInputFiles",
        { files, backendNodeId: chooser.backendNodeId },
        { signal, timeoutMs: 10_000 },
      ),
    );
    const settle = await watcher.settle(signal);
    return {
      summary: `chose ${names} in the file chooser opened by ${label}`,
      path: "mouse",
      settle: `${settle.reason} (${settle.ms} ms)`,
    };
  } finally {
    await tab.session
      .send("Page.setInterceptFileChooserDialog", { enabled: false }, { timeoutMs: 2_000 })
      .catch(() => {});
  }
}

export async function handleDialog(
  ctx: ActionContext,
  action: "accept" | "dismiss",
  text?: string,
): Promise<ActionResult> {
  const { tab, signal } = ctx;
  const dialog = tab.dialog;
  if (!dialog) return { ok: false, kind: "error", summary: "there is no JavaScript dialog open" };
  const watcher = watchSettle(tab, "in-page");
  try {
    await tab.session.send(
      "Page.handleJavaScriptDialog",
      { accept: action === "accept", ...(text !== undefined ? { promptText: text } : {}) },
      { signal, timeoutMs: 5_000 },
    );
  } catch (error) {
    watcher.dispose();
    throw error;
  }
  tab.dialog = undefined;
  const settle = await ctx.stopwatch.time("settleMs", () => watcher.settle(signal));
  const answered =
    dialog.type === "prompt" && action === "accept" && text !== undefined
      ? ` with ${JSON.stringify(text)}`
      : "";
  return {
    summary: `${action === "accept" ? "accepted" : "dismissed"} the ${dialog.type} ${JSON.stringify(dialog.message.slice(0, 80))}${answered}${settle.navigated ? " → navigated" : ""}`,
    settle: `${settle.reason} (${settle.ms} ms)`,
  };
}
