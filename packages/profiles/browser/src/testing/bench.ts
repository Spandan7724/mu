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
    await tab.session.send("Runtime.evaluate", {
      expression:
        "new Promise((resolve) => document.readyState === 'complete' ? resolve() : addEventListener('load', () => resolve()))",
      awaitPromise: true,
    });
    await observe(manager, tab, new Stopwatch());
    const times: number[] = [];
    let tokens = 0;
    for (let i = 0; i < iterations; i++) {
      const started = performance.now();
      const observation = await observe(manager, tab, new Stopwatch());
      times.push(performance.now() - started);
      tokens = observation.tokens;
    }
    times.sort((a, b) => a - b);
    results.push({
      page,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      max: Math.round((times.at(-1) ?? 0) * 10) / 10,
      tokens,
    });
  }
  return results;
}

export function formatBench(results: BenchResult[]): string {
  return [
    "| page | p50 ms | p95 ms | max ms | tokens |",
    "|---|---|---|---|---|",
    ...results.map((r) => `| ${r.page} | ${r.p50} | ${r.p95} | ${r.max} | ${r.tokens} |`),
  ].join("\n");
}
