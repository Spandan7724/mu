// Live task matrix (EVALS.md §3) against a real Codex-plan model:
//   bun packages/profiles/browser/scripts/eval-live.ts [--model ref] [--tasks 1,2,6] [--runs 3]
//     [--google --eval-profile eval --self you@example.com] [--headed] [--out path]
// Non-Google tasks use a temporary signed-out profile; Google tasks (3, 4, 5, 8) need
// --google and the managed profile named by --eval-profile, signed in to a test account.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProvider } from "@mu/ai";
import { createCredentialResolver } from "mu";
import { formatResults, type RunMetrics, runTask, TASKS } from "../src/evals/live.ts";
import { tempUserDataDir, testBrowserPath } from "../src/testing/chrome.ts";
import { startFixtureSite } from "../src/testing/fixture-site.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const modelRef = flag("--model") ?? "openai-codex/gpt-5.6-luna";
const runs = Number(flag("--runs") ?? 3);
const selected = flag("--tasks")?.split(",").map(Number);
const google = argv.includes("--google");
const headed = argv.includes("--headed");
const out =
  flag("--out") ??
  join(import.meta.dir, "..", "..", "..", "..", "docs", "browser-agent", "eval-results.md");

const site = startFixtureSite();
const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
const provider = getProvider(modelRef.split("/")[0] as string);
const getCredentials = createCredentialResolver();
const results: RunMetrics[] = [];
const skipped: string[] = [];
try {
  for (const task of TASKS) {
    if (selected && !selected.includes(task.id)) continue;
    if (task.google && !google) {
      skipped.push(
        `#${task.id} ${task.name}: needs --google and a signed-in eval profile (user-gated, B5.2)`,
      );
      continue;
    }
    for (const mode of task.modes) {
      for (let run = 1; run <= runs; run++) {
        const profileOptions = task.google
          ? {
              browserProfile: flag("--eval-profile") ?? "eval",
              headless: !headed,
              keepOpen: true,
              vision: "auto" as const,
            }
          : {
              home: tempUserDataDir(),
              headless: !headed,
              keepOpen: false,
              vision: "auto" as const,
              ...(testBrowserPath ? { executable: testBrowserPath } : {}),
            };
        const metrics = await runTask(task, mode, run, {
          ctx: { site, selfEmail: flag("--self"), tag: `${stamp}-r${run}` },
          provider,
          modelRef,
          getCredentials,
          profileOptions,
        });
        results.push(metrics);
        console.log(
          `#${task.id} ${mode} run ${run}: ${metrics.pass ? "PASS" : "FAIL"} · ${metrics.turns} turns · ${(metrics.wallMs / 1000).toFixed(1)} s (model ${(metrics.modelMs / 1000).toFixed(1)} s, browser ${(metrics.browserMs / 1000).toFixed(1)} s) · $${metrics.costUsd.toFixed(3)} · ${metrics.error ?? metrics.note}`,
        );
      }
    }
  }
} finally {
  site.stop();
}
writeFileSync(
  out,
  formatResults(results, { model: modelRef, date: new Date().toISOString().slice(0, 16), skipped }),
);
writeFileSync(`${out.replace(/\.md$/, "")}.json`, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${out}`);
