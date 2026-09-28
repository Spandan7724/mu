import type { Stopwatch } from "../actions/types.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { JsDialog, Tab } from "../browser/tabs.ts";
import type { PageModel } from "./model.ts";
import { mergeSeen, renderSnapshot } from "./render.ts";
import { captureScreenshot, type Screenshot, screenshotHeader } from "./screenshot.ts";
import { type CaptureOptions, capturePage } from "./snapshot.ts";

export interface Observation {
  text: string;
  url: string;
  title: string;
  fingerprint: string;
  tokens: number;
  model?: PageModel;
  screenshot?: Screenshot;
}

export interface ObserveOptions {
  scope?: "viewport" | "full";
  budgetTokens?: number;
  screenshot?: boolean;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function fingerprintOf(url: string, body: string): string {
  return `${url}#${Bun.hash(body).toString(36)}`;
}

function describeDialog(dialog: JsDialog | undefined): string {
  if (!dialog) return "none";
  const message = dialog.message.replace(/\s+/g, " ").slice(0, 300);
  return `${dialog.type} ${JSON.stringify(message)} — handle it with the dialog tool before anything else`;
}

interface HeaderFacts {
  title: string;
  url: string;
  scrollY?: number;
  pageHeight?: number;
  viewport?: { width: number; height: number };
  newDocument?: boolean;
}

export function renderHeader(
  facts: HeaderFacts,
  tabs: { count: number; active: string },
  dialog: JsDialog | undefined,
): string {
  const layout = [
    `tabs: ${tabs.count} (active: ${tabs.active})`,
    facts.scrollY !== undefined && facts.pageHeight !== undefined
      ? `scroll: ${facts.scrollY}/${facts.pageHeight} px`
      : "scroll: unknown",
    facts.viewport ? `viewport ${facts.viewport.width}x${facts.viewport.height}` : undefined,
  ].filter(Boolean);
  return [
    `[page] ${facts.title || "(untitled)"}`,
    `url: ${facts.url}${facts.newDocument ? " (new page: refs from earlier observations no longer apply)" : ""}`,
    layout.join(" · "),
    `dialog: ${describeDialog(dialog)}`,
  ].join("\n");
}

export async function observe(
  manager: BrowserManager,
  tab: Tab,
  stopwatch: Stopwatch,
  signal?: AbortSignal,
  options: ObserveOptions = {},
): Promise<Observation> {
  const shot =
    options.screenshot && !tab.dialog
      ? stopwatch.time("screenshotMs", () => captureScreenshot(tab, { signal }))
      : undefined;
  // Keep a rejected screenshot from surfacing as an unhandled rejection before it is awaited.
  shot?.catch(() => {});
  const observation = await stopwatch.time("snapshotMs", async (): Promise<Observation> => {
    const tabs = { count: manager.tabs().length, active: tab.tabId };
    // A pending JS dialog blocks the renderer; only browser-side facts are available.
    if (tab.dialog) {
      const text = `${renderHeader({ title: tab.title, url: tab.url }, tabs, tab.dialog)}\n<page_content untrusted="true">\n(the page is blocked until the dialog is handled)\n</page_content>`;
      return {
        text,
        url: tab.url,
        title: tab.title,
        fingerprint: fingerprintOf(tab.url, text),
        tokens: estimateTokens(text),
      };
    }
    const capture: CaptureOptions = { scope: options.scope ?? "viewport", signal };
    const model = await capturePage(tab, capture);
    const previous =
      tab.previous && tab.previous.documentId === model.documentId ? tab.previous : undefined;
    const rendered = renderSnapshot(model, {
      scope: capture.scope,
      ...(options.budgetTokens !== undefined ? { budgetTokens: options.budgetTokens } : {}),
      previous,
    });
    tab.previous = { documentId: model.documentId, ...mergeSeen(previous, rendered) };
    tab.url = model.url;
    tab.title = model.title;
    const header = renderHeader(
      {
        title: model.title,
        url: model.url,
        scrollY: model.viewport.scrollY,
        pageHeight: model.viewport.pageHeight,
        viewport: { width: model.viewport.width, height: model.viewport.height },
        newDocument: model.newDocument,
      },
      tabs,
      tab.dialog,
    );
    const text = `${header}\n${rendered.text}`;
    return {
      text,
      url: model.url,
      title: model.title,
      fingerprint: fingerprintOf(model.url, rendered.text),
      tokens: estimateTokens(text),
      model,
    };
  });
  if (!shot) return observation;
  const screenshot = await shot.catch(() => undefined);
  if (!screenshot) return observation;
  const [first, ...rest] = observation.text.split("\n<page_content");
  return {
    ...observation,
    text: `${first}\n${screenshotHeader(screenshot)}\n<page_content${rest.join("\n<page_content")}`,
    screenshot,
  };
}
