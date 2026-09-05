import { compactionScenario } from "../packages/sdk/src/testing/compaction-scenario.ts";

const rows = [];
for (const improved of [false, true]) {
  const trials = [];
  for (let i = 0; i < 24; i++) trials.push(await compactionScenario(improved));
  rows.push({
    mode: improved ? "task-aware original evidence" : "old input policy (controlled baseline)",
    trials: trials.length,
    correctNextActions: trials.reduce((sum, trial) => sum + trial.correctActions, 0),
    historyLookups: trials.reduce((sum, trial) => sum + trial.historyCalls, 0),
    meanCompactorCallsForThreeCompactions:
      trials.reduce((sum, trial) => sum + trial.compactorCalls, 0) / trials.length,
    meanRetainedContextTokens:
      trials.reduce((sum, trial) => sum + trial.contextTokens, 0) / trials.length,
  });
}
console.log(
  JSON.stringify(
    {
      benchmark:
        "Evidence-dependent next action after three compactions and a task correction; deterministic policy, no live LLM",
      rows,
    },
    null,
    2,
  ),
);
if (
  rows[0]?.correctNextActions !== 0 ||
  rows[1]?.correctNextActions !== 24 ||
  rows[1]?.historyLookups !== 0
)
  process.exitCode = 1;
