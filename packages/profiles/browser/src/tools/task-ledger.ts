export type BrowserTaskCriterionKind = "fact" | "ordered-list" | "exhaustive" | "action";

export interface BrowserTaskCriterionInput {
  id: string;
  description: string;
  kind: BrowserTaskCriterionKind;
  requiredCount?: number | undefined;
}

export interface BrowserTaskEvidence {
  id: string;
  kind: "observation" | "action";
  url?: string | undefined;
  tabId?: string | undefined;
  revision?: number | undefined;
  order?: "document" | "relevance" | undefined;
  range?: { start: number; end: number; total: number } | undefined;
  hasMore?: boolean | undefined;
  sourceIncomplete?: boolean | undefined;
  tool?: string | undefined;
  action?: string | undefined;
  outcome?: string | undefined;
}

interface AttachedEvidence {
  evidenceId: string;
  observedItems?: number | undefined;
}

export interface BrowserTaskCriterion extends BrowserTaskCriterionInput {
  evidence: AttachedEvidence[];
  satisfied: boolean;
}

export interface BrowserTaskState {
  authorityId: string;
  criteria: BrowserTaskCriterion[];
  steps: string[];
  status: "unplanned" | "active" | "satisfied";
}

const COMPLETED_OUTCOMES = new Set(["completed", "confirmed"]);

function criterionSatisfied(
  criterion: BrowserTaskCriterionInput,
  attachments: readonly AttachedEvidence[],
  evidenceById: ReadonlyMap<string, BrowserTaskEvidence>,
): boolean {
  const attached = attachments.flatMap((attachment) => {
    const evidence = evidenceById.get(attachment.evidenceId);
    return evidence === undefined ? [] : [{ attachment, evidence }];
  });
  switch (criterion.kind) {
    case "fact":
      return attached.some(({ evidence }) => evidence.kind === "observation");
    case "ordered-list": {
      const ordered = attached
        .filter(({ evidence }) => evidence.kind === "observation" && evidence.order === "document")
        .sort(
          (left, right) => (left.evidence.range?.start ?? 1) - (right.evidence.range?.start ?? 1),
        );
      let coveredThrough = 0;
      for (const { attachment, evidence } of ordered) {
        const range = evidence.range;
        if (range === undefined || range.start > coveredThrough) break;
        coveredThrough = Math.max(coveredThrough, range.end);
        if ((attachment.observedItems ?? 0) >= (criterion.requiredCount ?? 1)) return true;
      }
      return false;
    }
    case "exhaustive": {
      const ordered = attached
        .map(({ evidence }) => evidence)
        .filter((evidence) => evidence.kind === "observation" && evidence.order === "document")
        .sort((left, right) => (left.range?.start ?? 1) - (right.range?.start ?? 1));
      let coveredThrough = 0;
      for (const evidence of ordered) {
        const range = evidence.range;
        if (range === undefined || range.start > coveredThrough) break;
        coveredThrough = Math.max(coveredThrough, range.end);
        if (evidence.hasMore === false && evidence.sourceIncomplete === false) return true;
      }
      return false;
    }
    case "action":
      return attached.some(
        ({ evidence }) =>
          evidence.kind === "action" && COMPLETED_OUTCOMES.has(evidence.outcome ?? ""),
      );
  }
}

export class BrowserTaskLedger {
  readonly #evidence = new Map<string, BrowserTaskEvidence>();
  #authorityId: string | undefined;
  #criteria: BrowserTaskCriterionInput[] = [];
  #attachments = new Map<string, AttachedEvidence[]>();
  #steps: string[] = [];
  #revision = 0;
  #reviewedRevision = -1;

  begin(authorityId: string): void {
    if (authorityId === this.#authorityId) return;
    this.#authorityId = authorityId;
    this.#criteria = [];
    this.#attachments.clear();
    this.#evidence.clear();
    this.#steps = [];
    this.#revision += 1;
  }

  plan(criteria: readonly BrowserTaskCriterionInput[], steps: readonly string[]): BrowserTaskState {
    if (this.#authorityId === undefined) {
      throw new TypeError("no user task is active");
    }
    if (this.#criteria.length > 0) {
      throw new TypeError("task criteria are append-only; start a new user task to replace them");
    }
    this.#criteria = criteria.map((criterion) => ({ ...criterion }));
    this.#steps = [...steps];
    this.#revision += 1;
    return this.state();
  }

  record(evidence: BrowserTaskEvidence): void {
    this.#evidence.set(evidence.id, evidence);
    if (this.#evidence.size > 500) {
      for (const candidate of this.#evidence.keys()) {
        if (this.#isAttached(candidate)) continue;
        this.#evidence.delete(candidate);
        break;
      }
    }
  }

  attach(criterionId: string, evidenceId: string, observedItems?: number): BrowserTaskState {
    const criterion = this.#criteria.find((entry) => entry.id === criterionId);
    if (criterion === undefined) throw new TypeError(`unknown task criterion ${criterionId}`);
    if (!this.#evidence.has(evidenceId)) {
      throw new TypeError(`unknown or expired browser evidence ${evidenceId}`);
    }
    const existing = this.#attachments.get(criterionId) ?? [];
    const attached = existing.find((entry) => entry.evidenceId === evidenceId);
    if (attached === undefined) {
      if (existing.length >= 20)
        throw new TypeError("a criterion may retain at most 20 evidence records");
      existing.push({ evidenceId, ...(observedItems === undefined ? {} : { observedItems }) });
      this.#attachments.set(criterionId, existing);
      this.#revision += 1;
    } else if (
      observedItems !== undefined &&
      (attached.observedItems === undefined || observedItems > attached.observedItems)
    ) {
      attached.observedItems = observedItems;
      this.#revision += 1;
    }
    return this.state();
  }

  state(): BrowserTaskState {
    const criteria = this.#criteria.map((criterion) => {
      const attachments = this.#attachments.get(criterion.id) ?? [];
      return {
        ...criterion,
        evidence: attachments.map((entry) => ({ ...entry })),
        satisfied: criterionSatisfied(criterion, attachments, this.#evidence),
      };
    });
    const status =
      criteria.length === 0
        ? "unplanned"
        : criteria.every((criterion) => criterion.satisfied)
          ? "satisfied"
          : "active";
    return {
      authorityId: this.#authorityId ?? "none",
      criteria,
      steps: [...this.#steps],
      status,
    };
  }

  evidence(): BrowserTaskEvidence[] {
    return [...this.#evidence.values()].slice(-20).map((entry) => ({ ...entry }));
  }

  finishReminder(): string | undefined {
    if (
      this.#authorityId === undefined ||
      this.#reviewedRevision === this.#revision ||
      (this.#criteria.length === 0 && this.#evidence.size === 0)
    )
      return undefined;
    const state = this.state();
    if (state.status === "satisfied") return undefined;
    this.#reviewedRevision = this.#revision;
    if (state.status === "unplanned") {
      return "This browser task has no explicit success criteria. Before finishing, use browser_task to plan the requested outcomes, then attach session-minted evidence. If the task is intentionally incomplete, say so plainly.";
    }
    const unmet = state.criteria
      .filter((criterion) => !criterion.satisfied)
      .map((criterion) => `${criterion.id}: ${criterion.description}`)
      .join("; ");
    return `The browser task still has unmet evidence criteria: ${unmet}. Continue working and attach valid evidence, or report the task as incomplete without claiming success.`;
  }

  #isAttached(evidenceId: string): boolean {
    return [...this.#attachments.values()].some((entries) =>
      entries.some((entry) => entry.evidenceId === evidenceId),
    );
  }
}
