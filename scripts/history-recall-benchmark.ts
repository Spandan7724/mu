import { historyScenario } from "../packages/sdk/src/testing/history-scenario.ts";

const trials = 24;
const rows = [];
for (const history of [false, true]) {
  const started = performance.now();
  const results = [];
  for (let i = 0; i < trials; i++) results.push(await historyScenario(history));
  rows.push({
    mode: history ? "recoverable history" : "existing summary-only context",
    trials,
    exactRecoveries: results.filter((result) => result.recovered).length,
    sourceReruns: results.reduce((sum, result) => sum + result.sourceReruns, 0),
    meanRecoveryModelCalls:
      results.reduce((sum, result) => sum + result.recoveryModelCalls, 0) / trials,
    meanRetrievalChars: results.reduce((sum, result) => sum + result.retrievalChars, 0) / trials,
    meanRetrievalEstimatedTokens:
      results.reduce((sum, result) => sum + result.retrievalEstimatedTokens, 0) / trials,
    evidenceHiddenInEveryTrial: results.every(
      (result) => result.evidenceHiddenAfterCompaction && !result.summarizerSawAnswer,
    ),
    durationMs: Math.round(performance.now() - started),
  });
}
console.log(
  JSON.stringify(
    {
      benchmark: "Exact historical evidence recovery; adaptive deterministic policy, no live LLM",
      rows,
    },
    null,
    2,
  ),
);
if (
  rows[0]?.exactRecoveries !== 0 ||
  rows[1]?.exactRecoveries !== trials ||
  rows[1]?.sourceReruns !== 0
)
  process.exitCode = 1;
