import type { Usage } from "@mu/ai";

export interface Budget {
  maxTurns?: number;
  maxCostUsd?: number;
  maxTokens?: number;
}

export type BudgetBreach = "maxCostUsd" | "maxTokens";

export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

// maxTurns is enforced by the loop itself; cost/token ceilings are checked
// after each turn, once usage for that turn is known.
export function checkBudget(budget: Budget | undefined, usage: Usage): BudgetBreach | undefined {
  if (!budget) return undefined;
  if (budget.maxCostUsd !== undefined && (usage.costUsd ?? 0) >= budget.maxCostUsd) {
    return "maxCostUsd";
  }
  if (budget.maxTokens !== undefined && totalTokens(usage) >= budget.maxTokens) {
    return "maxTokens";
  }
  return undefined;
}
