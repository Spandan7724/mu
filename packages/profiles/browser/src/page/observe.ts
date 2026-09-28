import type { Stopwatch } from "../actions/types.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { JsDialog, Tab } from "../browser/tabs.ts";

export interface Observation {
  text: string;
  url: string;
  title: string;
  fingerprint: string;
  tokens: number;
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

interface PageFacts {
  title: string;
  url: string;
  scrollY?: number;
  pageHeight?: number;
  viewport?: { width: number; height: number };
}

async function pageFacts(tab: Tab, signal?: AbortSignal): Promise<PageFacts> {
  // A pending JS dialog blocks the renderer, so only browser-side facts are available.
  if (tab.dialog) return { title: tab.title, url: tab.url };
  const options = { signal, timeoutMs: 3_000 };
  const [metrics, evaluated] = await Promise.all([
    tab.session.send("Page.getLayoutMetrics", undefined, options),
    tab.session.send(
      "Runtime.evaluate",
      {
        expression: "[document.title, location.href, innerWidth, innerHeight]",
        returnByValue: true,
      },
      options,
    ),
  ]);
  const [title, url, width, height] = (evaluated.result.value as
    | [string, string, number, number]
    | undefined) ?? [tab.title, tab.url, 0, 0];
  return {
    title,
    url,
    scrollY: Math.round(metrics.cssVisualViewport.pageY),
    pageHeight: Math.round(metrics.cssContentSize.height),
    viewport: {
      width: width || Math.round(metrics.cssVisualViewport.clientWidth),
      height: height || Math.round(metrics.cssVisualViewport.clientHeight),
    },
  };
}

export function renderHeader(
  facts: PageFacts,
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
    `url: ${facts.url}`,
    layout.join(" · "),
    `dialog: ${describeDialog(dialog)}`,
  ].join("\n");
}

export async function observe(
  manager: BrowserManager,
  tab: Tab,
  stopwatch: Stopwatch,
  signal?: AbortSignal,
): Promise<Observation> {
  return stopwatch.time("snapshotMs", async () => {
    const facts = await pageFacts(tab, signal);
    tab.url = facts.url;
    tab.title = facts.title;
    const text = renderHeader(
      facts,
      { count: manager.tabs().length, active: tab.tabId },
      tab.dialog,
    );
    return {
      text,
      url: facts.url,
      title: facts.title,
      fingerprint: fingerprintOf(facts.url, text),
      tokens: estimateTokens(text),
    };
  });
}
