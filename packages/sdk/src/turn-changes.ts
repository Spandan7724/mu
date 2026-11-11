import type { AnyTool, CheckpointProvider } from "@mu/core";

// Tools that do not say, and classifiers that fail, count as changing state:
// a skipped capture would make the turn's undo silently incomplete.
export function mayChangeState(tool: AnyTool | undefined, args: unknown): boolean {
  const flag = tool?.changesState;
  if (flag === undefined) return true;
  if (typeof flag === "boolean") return flag;
  try {
    return flag(args) !== false;
  } catch {
    return true;
  }
}

// What a state-changing call declares it changes; undefined when it cannot say.
export function declaredResources(tool: AnyTool | undefined, args: unknown): string[] | undefined {
  const declare = tool?.changedResources;
  if (!declare) return undefined;
  try {
    const resources: unknown = declare(args);
    return Array.isArray(resources) && resources.every((item) => typeof item === "string")
      ? resources
      : undefined;
  } catch {
    return undefined;
  }
}

export interface PendingCheckpoint {
  beforeEntryId: string | null;
  beforeRef: string;
}

// What a turn's allowed tool calls may have changed. `unknown` is set by a call
// that may change state without naming every resource it changes. With
// declared coverage, `uncaptured` holds resources whose prior state could not
// be recorded, and `capture` serializes those pre-change captures.
export class TurnChanges {
  readonly resources = new Set<string>();
  unknown = false;
  readonly uncaptured = new Set<string>();
  capture: Promise<void> = Promise.resolve();

  constructor(
    private readonly provider: CheckpointProvider | undefined,
    private readonly pending: () => PendingCheckpoint | undefined,
  ) {}

  // Called once a call is allowed to run, so a denied call records nothing.
  async record(tool: AnyTool | undefined, args: unknown): Promise<void> {
    if (!mayChangeState(tool, args)) return;
    const resources = declaredResources(tool, args);
    if (!resources) {
      this.unknown = true;
      return;
    }
    await this.captureBeforeChange(resources);
    for (const resource of resources) this.resources.add(resource);
  }

  // A resource's state before its first change in the turn joins the
  // before-turn checkpoint.
  private async captureBeforeChange(resources: string[]): Promise<void> {
    const provider = this.provider;
    if (provider?.coverage !== "declared" || !provider.snapshotResources) return;
    const snapshotResources = provider.snapshotResources.bind(provider);
    const fresh = [...new Set(resources)].filter((resource) => !this.resources.has(resource));
    for (const resource of fresh) this.resources.add(resource);
    if (fresh.length === 0) return;
    this.capture = this.capture.then(async () => {
      const pending = this.pending();
      const ref = pending
        ? await snapshotResources(pending.beforeRef, fresh, "before change").catch(() => undefined)
        : undefined;
      if (pending && ref) pending.beforeRef = ref;
      // Its change would read as a creation, and undo would delete it.
      else for (const resource of fresh) this.uncaptured.add(resource);
    });
    await this.capture;
  }
}
