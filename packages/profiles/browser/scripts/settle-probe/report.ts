// Scores settle rules over recorded probe logs:
//   bun packages/profiles/browser/scripts/settle-probe/report.ts /tmp/probe [--detail]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionLog, ProbeSample } from "./run.ts";
import { CURRENT, RULES, type Rule, simulate } from "./simulate.ts";

const dir = process.argv[2] ?? "/tmp/settle-probe";
const detail = process.argv.includes("--detail");
// The rule the recorded browser ran; the simulator is checked against it.
const expectIndex = process.argv.indexOf("--expect");
const expected = expectIndex >= 0 ? process.argv[expectIndex + 1] : "current";
const logs: ActionLog[] = [];
for (const run of readdirSync(dir)) {
  for (const file of readdirSync(join(dir, run)).sort()) {
    if (file.endsWith(".json")) logs.push(JSON.parse(readFileSync(join(dir, run, file), "utf8")));
  }
}

const norm = (line: string) => line.replace(/\d+/g, "#").trim();
function similarity(a: string[] | undefined, b: string[] | undefined): number {
  if (!a || !b) return 0;
  const left = new Set(a.map(norm).filter(Boolean));
  const right = new Set(b.map(norm).filter(Boolean));
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const line of left) if (right.has(line)) shared++;
  return shared / (left.size + right.size - shared);
}

const lastStep = new Map<string, number>();
for (const log of logs)
  lastStep.set(
    `${log.run}|${log.scenario}`,
    Math.max(lastStep.get(`${log.run}|${log.scenario}`) ?? 0, log.step),
  );
const isLast = (log: ActionLog) => lastStep.get(`${log.run}|${log.scenario}`) === log.step;
const good = (samples: ProbeSample[]) => samples.filter((sample) => sample.lines);
// What a capture taken at `at` would have shown: the last sample finished by then.
const seenAt = (log: ActionLog, at: number) =>
  good(log.samples)
    .filter((sample) => sample.tEnd <= at)
    .at(-1);
const hasMarker = (sample: ProbeSample | undefined, marker: string) =>
  sample?.lines?.some((line) => line.includes(marker)) ?? false;

// Synthetic: content is ready once the marker shows; "early" means returned before the
// last sample without it finished, so a capture then could not have shown it.
function markerVerdict(log: ActionLog, at: number): "ok" | "early" | "never" {
  const marker = log.marker as string;
  const samples = good(log.samples);
  const first = samples.findIndex((sample) => hasMarker(sample, marker));
  if (first < 0) return "never";
  const lastWithout = samples[first - 1];
  if (lastWithout && at < lastWithout.tEnd) return "early";
  return "ok";
}

// Real pages: earliest time from which the viewport stays within 0.9 of its final state.
function readyAt(log: ActionLog, after: number): number | undefined {
  const samples = good(log.samples).filter((sample) => sample.t >= after);
  const final = samples.at(-1);
  if (!final) return undefined;
  let ready: number | undefined;
  for (const sample of samples) {
    if (similarity(sample.lines, final.lines) >= 0.9) ready ??= sample.tEnd;
    else ready = undefined;
  }
  return ready;
}

const ms = (value: number | undefined) => (value === undefined ? "—" : `${Math.round(value)}`);
const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

// 1. Does the simulator reproduce real settle times?
const errors: { log: ActionLog; real: number; sim: number }[] = [];
for (const log of logs) {
  const trace = log.traces.at(-1);
  const sim = simulate(log, RULES.find((rule) => rule.name === expected) ?? CURRENT);
  if (!trace || !sim) continue;
  errors.push({ log, real: trace.finishedAt - trace.actionEnd, sim: sim.at - trace.actionEnd });
}
const absErrors = errors.map((e) => Math.abs(e.real - e.sim));
console.log(`## Simulator check (${expected} vs recorded settle), ${errors.length} actions`);
console.log(
  `|error| p50 ${ms(pct(absErrors, 50))} ms · p90 ${ms(pct(absErrors, 90))} ms · within 150 ms: ${absErrors.filter((e) => e <= 150).length}/${absErrors.length}`,
);
for (const e of errors.filter((e) => Math.abs(e.real - e.sim) > 300))
  console.log(
    `  off: [${e.log.run}] ${e.log.scenario} #${e.log.step}: real ${ms(e.real)} sim ${ms(e.sim)} (${e.log.traces.at(-1)?.reason})`,
  );

// 2. Does sampling change settle? (warm vs plain, same scenario and step)
const byKey = new Map<string, ActionLog>();
for (const log of logs) byKey.set(`${log.run}|${log.scenario}|${log.step}`, log);
const perturb: number[] = [];
for (const log of logs.filter((l) => l.run === "warm")) {
  const plain = byKey.get(`plain|${log.scenario}|${log.step}`);
  const a = log.traces.at(-1);
  const b = plain?.traces.at(-1);
  if (a && b) perturb.push(a.finishedAt - a.actionEnd - (b.finishedAt - b.actionEnd));
}
if (perturb.length)
  console.log(
    `\n## Sampling effect (warm − plain settle ms): p50 ${ms(pct(perturb, 50))} · p10 ${ms(pct(perturb, 10))} · p90 ${ms(pct(perturb, 90))}`,
  );

// 3. Rules over sampled runs.
const RECORDED: Rule = {
  ...CURRENT,
  name: "recorded",
  description: "what the browser actually did",
};
const scored = [RECORDED, ...RULES];
const sampled = logs.filter(
  (log) => log.run !== "plain" && log.traces.length && log.samples.length,
);
console.log(`\n## Rules over ${sampled.length} sampled actions`);
for (const rule of scored) console.log(`- ${rule.name}: ${rule.description}`);
const rows: string[] = [];
const totals = new Map<
  string,
  { settle: number[]; early: string[]; worse: string[]; caps: number }
>();
for (const rule of scored) totals.set(rule.name, { settle: [], early: [], worse: [], caps: 0 });
for (const log of sampled) {
  const trace = log.traces.at(-1);
  if (!trace) continue;
  const label = `[${log.run}] ${log.scenario} #${log.step} ${log.tool}`;
  const base = simulate(log, CURRENT);
  const final = good(log.samples).at(-1);
  const baseScore = base ? similarity(seenAt(log, base.at)?.lines, final?.lines) : 0;
  const ready = log.kind === "real" ? readyAt(log, trace.actionEnd) : undefined;
  const cells: string[] = [];
  for (const rule of scored) {
    const result =
      rule === RECORDED
        ? {
            at: trace.finishedAt,
            reason: /observed anyway/.test(trace.reason) ? "cap" : trace.reason,
          }
        : simulate(log, rule);
    const total = totals.get(rule.name);
    if (!result || !total) continue;
    const settle = result.at - trace.actionEnd;
    total.settle.push(settle);
    if (result.reason.startsWith("cap")) total.caps++;
    let verdict = "";
    if (log.marker && isLast(log)) {
      const v = markerVerdict(log, result.at);
      const baseV = base ? markerVerdict(log, base.at) : "never";
      if (v === "early") total.early.push(`${label}${baseV === "early" ? "" : " (new)"}`);
      verdict = v === "ok" ? "" : v;
    } else if (log.kind === "real") {
      const score = similarity(seenAt(log, result.at)?.lines, final?.lines);
      if (score < baseScore - 0.05 && score < 0.95)
        total.worse.push(`${label} (${score.toFixed(2)} vs ${baseScore.toFixed(2)})`);
      verdict = score.toFixed(2);
    }
    cells.push(
      `${ms(settle)}${result.reason.startsWith("cap") ? "^" : ""}${verdict ? ` ${verdict}` : ""}`,
    );
  }
  rows.push(
    `| ${label} | ${ms(trace.finishedAt - trace.actionEnd)} | ${ready === undefined ? "—" : ms(ready - trace.actionEnd)} | ${cells.join(" | ")} |`,
  );
}
console.log(
  "\n| rule | settle p50 | p90 | total s | hit cap | early (synthetic) | worse view (real) |",
);
console.log("|---|---|---|---|---|---|---|");
for (const rule of scored) {
  const t = totals.get(rule.name);
  if (!t) continue;
  console.log(
    `| ${rule.name} | ${ms(pct(t.settle, 50))} | ${ms(pct(t.settle, 90))} | ${(t.settle.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} | ${t.caps} | ${t.early.length} | ${t.worse.length} |`,
  );
}
for (const rule of scored) {
  const t = totals.get(rule.name);
  if (!t || (!t.early.length && !t.worse.length)) continue;
  console.log(`\n${rule.name}:`);
  for (const item of t.early) console.log(`  early: ${item}`);
  for (const item of t.worse) console.log(`  worse: ${item}`);
}
if (detail) {
  console.log(
    `\n| action | real ms | ready ms | ${scored.map((r) => r.name).join(" | ")} |\n|---|---|---|${scored.map(() => "---").join("|")}|`,
  );
  for (const row of rows) console.log(row);
  console.log(
    "(^ = hit a cap; synthetic: early/never; real: viewport similarity to the final state)",
  );
}
