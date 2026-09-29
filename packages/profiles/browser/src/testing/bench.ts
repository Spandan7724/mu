import { navigateTo } from "../actions/navigate.ts";
import { Stopwatch } from "../actions/types.ts";
import type { BrowserManager } from "../browser/manager.ts";
import { observe } from "../page/observe.ts";

export interface BenchResult {
  page: string;
  p50: number;
  p95: number;
  max: number;
  tokens: number;
  title: string;
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round((sorted[Math.max(0, index)] ?? 0) * 10) / 10;
}

// Measures observe() (capture + render) the way tools call it.
export async function benchSnapshots(
  manager: BrowserManager,
  urls: Record<string, string>,
  iterations = 20,
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const tab = await manager.activeTab();
  for (const [page, url] of Object.entries(urls)) {
    await navigateTo(tab, url);
    await tab.session
      .send(
        "Runtime.evaluate",
        {
          expression:
            "new Promise((resolve) => document.readyState === 'complete' ? resolve() : addEventListener('load', () => resolve()))",
          awaitPromise: true,
        },
        { timeoutMs: 5_000 },
      )
      .catch(() => {});
    await observe(manager, tab, new Stopwatch());
    const times: number[] = [];
    let tokens = 0;
    let title = "";
    for (let i = 0; i < iterations; i++) {
      const started = performance.now();
      const observation = await observe(manager, tab, new Stopwatch());
      times.push(performance.now() - started);
      tokens = observation.tokens;
      title = observation.title;
    }
    times.sort((a, b) => a - b);
    results.push({
      page,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      max: Math.round((times.at(-1) ?? 0) * 10) / 10,
      tokens,
      title,
    });
  }
  return results;
}

export function formatBench(results: BenchResult[]): string {
  return [
    "| page | p50 ms | p95 ms | max ms | tokens | title |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.page} | ${r.p50} | ${r.p95} | ${r.max} | ${r.tokens} | ${r.title.slice(0, 40)} |`,
    ),
  ].join("\n");
}

export interface ActionBench {
  action: string;
  p50: number;
  p95: number;
  settleP50: number;
}

// Click/type/press on pages that do no network work, measured end to end
// (resolve → act → settle → observe) from the tool's own timings.
export async function benchActions(home: string, iterations = 20): Promise<ActionBench[]> {
  const { browserProfile } = await import("../index.ts");
  const { startFixtureSite } = await import("./fixture-site.ts");
  const { testBrowserPath } = await import("./chrome.ts");
  const site = startFixtureSite();
  const profile = await browserProfile({
    home,
    headless: true,
    keepOpen: false,
    vision: "off",
    ...(testBrowserPath ? { executable: testBrowserPath } : {}),
  });
  const run = async (name: string, args: Record<string, unknown>) => {
    const found = profile.toolset.find((tool) => tool.name === name);
    const result = await found?.execute("bench", args, new AbortController().signal);
    const details = (result?.details ?? {}) as {
      details?: { timings: { totalMs: number; settleMs: number } };
    };
    const text =
      result?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
    return { timings: details.details?.timings ?? { totalMs: 0, settleMs: 0 }, text };
  };
  const refOf = (text: string, pattern: RegExp) => {
    const match = pattern.exec(text);
    if (!match?.[1]) throw new Error(`no match for ${pattern}`);
    return match[1];
  };
  try {
    const cases: {
      action: string;
      setup: () => Promise<string>;
      step: (page: string) => Promise<{ totalMs: number; settleMs: number }>;
    }[] = [
      {
        action: "click (no change)",
        setup: async () => (await run("navigate", { url: site.url("custom-select") })).text,
        step: async (page) =>
          (await run("click", { ref: refOf(page, /clickable "Settings" \[ref=(e\d+)\]/) })).timings,
      },
      {
        action: "click (opens menu)",
        setup: async () => (await run("navigate", { url: site.url("custom-select") })).text,
        step: async (page) =>
          (await run("click", { ref: refOf(page, /clickable "Select size ▾" \[ref=(e\d+)\]/) }))
            .timings,
      },
      {
        action: "type (text field)",
        setup: async () => (await run("navigate", { url: site.url("form-basic") })).text,
        step: async (page) =>
          (
            await run("type", {
              ref: refOf(page, /textbox "Full name" \[ref=(e\d+)\]/),
              text: "Ada Lovelace",
            })
          ).timings,
      },
      {
        action: "press Tab",
        setup: async () => (await run("navigate", { url: site.url("form-basic") })).text,
        step: async () => (await run("press", { keys: "Tab" })).timings,
      },
    ];
    const results: ActionBench[] = [];
    for (const benchCase of cases) {
      const page = await benchCase.setup();
      await benchCase.step(page);
      const totals: number[] = [];
      const settles: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const timings = await benchCase.step(page);
        totals.push(timings.totalMs);
        settles.push(timings.settleMs);
      }
      totals.sort((a, b) => a - b);
      settles.sort((a, b) => a - b);
      results.push({
        action: benchCase.action,
        p50: percentile(totals, 50),
        p95: percentile(totals, 95),
        settleP50: percentile(settles, 50),
      });
    }
    return results;
  } finally {
    await profile.browser.shutdown({ close: true });
    site.stop();
  }
}

export function formatActionBench(results: ActionBench[]): string {
  return [
    "| action | p50 ms | p95 ms | settle p50 ms |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.action} | ${r.p50} | ${r.p95} | ${r.settleP50} |`),
  ].join("\n");
}
