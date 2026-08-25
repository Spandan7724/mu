import type { ToolResult } from "@mu/core";
import type { BrowserDriver } from "../contracts/driver.ts";
import type { BrowserTaskSession } from "./session.ts";

export type BrowserStage<T> = { ok: true; value: T } | { ok: false; result: ToolResult };

export function stage<T>(value: T): BrowserStage<T> {
  return { ok: true, value };
}

export function stop(result: ToolResult): BrowserStage<never> {
  return { ok: false, result };
}

export interface BrowserOperationStages<
  Validated,
  Refreshed,
  Classified,
  Projected,
  Driven,
  Settled,
> {
  session: BrowserTaskSession;
  signal: AbortSignal;
  validate: () => BrowserStage<Validated> | Promise<BrowserStage<Validated>>;
  refresh: (validated: Validated) => BrowserStage<Refreshed> | Promise<BrowserStage<Refreshed>>;
  classify: (
    refreshed: Refreshed,
    validated: Validated,
  ) => BrowserStage<Classified> | Promise<BrowserStage<Classified>>;
  /** Recomputes the pure scope/pattern projection Mu evaluated before execute. */
  project: (
    classified: Classified,
    refreshed: Refreshed,
    validated: Validated,
  ) => BrowserStage<Projected> | Promise<BrowserStage<Projected>>;
  drive: (
    driver: BrowserDriver,
    projected: Projected,
    classified: Classified,
    refreshed: Refreshed,
    validated: Validated,
  ) => Promise<Driven>;
  settle: (
    driven: Driven,
    projected: Projected,
    classified: Classified,
    refreshed: Refreshed,
    validated: Validated,
  ) => Promise<Settled>;
  update: (
    settled: Settled,
    driven: Driven,
    projected: Projected,
    classified: Classified,
    refreshed: Refreshed,
    validated: Validated,
  ) => void | Promise<void>;
  render: (
    settled: Settled,
    driven: Driven,
    projected: Projected,
    classified: Classified,
    refreshed: Refreshed,
    validated: Validated,
  ) => ToolResult | Promise<ToolResult>;
  renderError: (error: unknown) => ToolResult;
}

/**
 * One execution order for browser operations. Structural classification can stop an
 * operation, but no stage returns allow/ask/deny: Mu has already made that decision.
 */
export async function runBrowserOperation<V, R, C, P, D, S>(
  stages: BrowserOperationStages<V, R, C, P, D, S>,
): Promise<ToolResult> {
  try {
    const validated = await stages.validate();
    if (!validated.ok) return validated.result;
    const refreshed = await stages.refresh(validated.value);
    if (!refreshed.ok) return refreshed.result;
    const classified = await stages.classify(refreshed.value, validated.value);
    if (!classified.ok) return classified.result;
    const projected = await stages.project(classified.value, refreshed.value, validated.value);
    if (!projected.ok) return projected.result;
    const driven = await stages.session.use(
      (driver) =>
        stages.drive(driver, projected.value, classified.value, refreshed.value, validated.value),
      stages.signal,
    );
    const settled = await stages.settle(
      driven,
      projected.value,
      classified.value,
      refreshed.value,
      validated.value,
    );
    await stages.update(
      settled,
      driven,
      projected.value,
      classified.value,
      refreshed.value,
      validated.value,
    );
    return await stages.render(
      settled,
      driven,
      projected.value,
      classified.value,
      refreshed.value,
      validated.value,
    );
  } catch (error) {
    return stages.renderError(error);
  }
}
