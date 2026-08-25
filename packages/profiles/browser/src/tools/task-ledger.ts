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
  viewportRange?: { start: number; end: number; total: number } | undefined;
  hasMore?: boolean | undefined;
  sourceIncomplete?: boolean | undefined;
  tool?: string | undefined;
  action?: string | undefined;
  outcome?: string | undefined;
}

export interface BrowserTaskAttachedEvidence {
  evidenceId: string;
  observedItems?: number | undefined;
}

export interface BrowserTaskCriterion extends BrowserTaskCriterionInput {
  evidence: BrowserTaskAttachedEvidence[];
  satisfied: boolean;
}

export interface BrowserTaskState {
  authorityId: string;
  criteria: BrowserTaskCriterion[];
  steps: string[];
  status: "unplanned" | "active" | "satisfied";
}

const COMPLETED_OUTCOMES = new Set(["completed", "confirmed"]);
const MAX_TEXT = 4_096;
const MAX_CRITERIA = 100;
const MAX_STEPS = 100;
const MAX_EVIDENCE = 500;
const MAX_ATTACHMENTS = 100;

export interface BrowserTaskLedgerSnapshot {
  version: 1;
  authorityId?: string | undefined;
  criteria: BrowserTaskCriterionInput[];
  attachments: Record<string, BrowserTaskAttachedEvidence[]>;
  evidence: BrowserTaskEvidence[];
  steps: string[];
  revision: number;
  reviewedRevision: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function criterion(value: unknown): value is BrowserTaskCriterionInput {
  if (!record(value) || !exact(value, ["id", "description", "kind", "requiredCount"])) return false;
  return (
    text(value.id) &&
    text(value.description) &&
    ["fact", "ordered-list", "exhaustive", "action"].includes(value.kind as string) &&
    (value.requiredCount === undefined || integer(value.requiredCount))
  );
}

function validEvidence(value: unknown): value is BrowserTaskEvidence {
  if (
    !record(value) ||
    !exact(value, [
      "id",
      "kind",
      "url",
      "tabId",
      "revision",
      "order",
      "range",
      "viewportRange",
      "hasMore",
      "sourceIncomplete",
      "tool",
      "action",
      "outcome",
    ]) ||
    !text(value.id) ||
    !["observation", "action"].includes(value.kind as string)
  )
    return false;
  for (const key of ["url", "tabId", "tool", "action", "outcome"] as const) {
    if (value[key] !== undefined && !text(value[key])) return false;
  }
  if (value.revision !== undefined && !integer(value.revision)) return false;
  if (value.order !== undefined && value.order !== "document" && value.order !== "relevance")
    return false;
  if (value.hasMore !== undefined && typeof value.hasMore !== "boolean") return false;
  if (value.sourceIncomplete !== undefined && typeof value.sourceIncomplete !== "boolean")
    return false;
  if (value.range !== undefined) {
    if (!record(value.range) || !exact(value.range, ["start", "end", "total"])) return false;
    if (!integer(value.range.start) || !integer(value.range.end) || !integer(value.range.total))
      return false;
    if (value.range.start > value.range.end || value.range.end > value.range.total) return false;
  }
  if (value.viewportRange !== undefined) {
    if (!record(value.viewportRange) || !exact(value.viewportRange, ["start", "end", "total"]))
      return false;
    if (
      !integer(value.viewportRange.start) ||
      !integer(value.viewportRange.end) ||
      !integer(value.viewportRange.total) ||
      value.viewportRange.start > value.viewportRange.end ||
      value.viewportRange.end > value.viewportRange.total
    )
      return false;
  }
  return true;
}

export function parseBrowserTaskLedgerSnapshot(
  value: unknown,
): BrowserTaskLedgerSnapshot | undefined {
  if (
    !record(value) ||
    !exact(value, [
      "version",
      "authorityId",
      "criteria",
      "attachments",
      "evidence",
      "steps",
      "revision",
      "reviewedRevision",
    ])
  )
    return undefined;
  if (value.version !== 1 || (value.authorityId !== undefined && !text(value.authorityId)))
    return undefined;
  if (
    !Array.isArray(value.criteria) ||
    value.criteria.length > MAX_CRITERIA ||
    !value.criteria.every(criterion)
  )
    return undefined;
  if (
    !Array.isArray(value.evidence) ||
    value.evidence.length > MAX_EVIDENCE ||
    !value.evidence.every(validEvidence)
  )
    return undefined;
  if (!Array.isArray(value.steps) || value.steps.length > MAX_STEPS || !value.steps.every(text))
    return undefined;
  if (
    !integer(value.revision) ||
    !Number.isSafeInteger(value.reviewedRevision) ||
    (value.reviewedRevision as number) < -1
  )
    return undefined;
  if (!record(value.attachments)) return undefined;
  const criterionIds = new Set(value.criteria.map((entry) => entry.id));
  const evidenceIds = new Set(value.evidence.map((entry) => entry.id));
  if (criterionIds.size !== value.criteria.length || evidenceIds.size !== value.evidence.length)
    return undefined;
  for (const [id, entries] of Object.entries(value.attachments)) {
    if (!criterionIds.has(id) || !Array.isArray(entries) || entries.length > MAX_ATTACHMENTS)
      return undefined;
    const attachedIds = new Set<string>();
    for (const entry of entries) {
      if (
        !record(entry) ||
        !exact(entry, ["evidenceId", "observedItems"]) ||
        !text(entry.evidenceId) ||
        !evidenceIds.has(entry.evidenceId) ||
        attachedIds.has(entry.evidenceId) ||
        (entry.observedItems !== undefined && !integer(entry.observedItems))
      )
        return undefined;
      attachedIds.add(entry.evidenceId);
    }
  }
  return value as unknown as BrowserTaskLedgerSnapshot;
}

function criterionSatisfied(
  criterion: BrowserTaskCriterionInput,
  attachments: readonly BrowserTaskAttachedEvidence[],
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
      let semanticComplete = false;
      for (const evidence of ordered) {
        const range = evidence.range;
        if (range === undefined || range.start > coveredThrough) break;
        coveredThrough = Math.max(coveredThrough, range.end);
        if (evidence.hasMore === false && evidence.sourceIncomplete === false) {
          semanticComplete = true;
          break;
        }
      }
      if (!semanticComplete) return false;
      const viewportRanges = attached
        .map(({ evidence }) => evidence.viewportRange)
        .filter(
          (range): range is NonNullable<BrowserTaskEvidence["viewportRange"]> =>
            range !== undefined,
        )
        .sort((left, right) => left.start - right.start);
      if (viewportRanges.length === 0 || viewportRanges.every((range) => range.total <= range.end))
        return true;
      let viewportThrough = 0;
      const finalTotal = Math.max(...viewportRanges.map((range) => range.total));
      for (const range of viewportRanges) {
        if (range.start > viewportThrough) return false;
        viewportThrough = Math.max(viewportThrough, range.end);
      }
      return viewportThrough >= finalTotal;
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
  #attachments = new Map<string, BrowserTaskAttachedEvidence[]>();
  #steps: string[] = [];
  #revision = 0;
  #reviewedRevision = -1;

  reset(): void {
    this.#authorityId = undefined;
    this.#criteria = [];
    this.#attachments.clear();
    this.#evidence.clear();
    this.#steps = [];
    this.#revision = 0;
    this.#reviewedRevision = -1;
  }

  begin(authorityId: string): void {
    if (!text(authorityId)) throw new TypeError("invalid task authority");
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
    if (criteria.length > MAX_CRITERIA || !criteria.every(criterion))
      throw new TypeError("invalid task criteria");
    if (steps.length > MAX_STEPS || !steps.every(text)) throw new TypeError("invalid task steps");
    if (new Set(criteria.map((entry) => entry.id)).size !== criteria.length)
      throw new TypeError("task criterion ids must be unique");
    this.#criteria = criteria.map((criterion) => ({ ...criterion }));
    this.#steps = [...steps];
    this.#revision += 1;
    return this.state();
  }

  record(evidence: BrowserTaskEvidence): void {
    if (!validEvidence(evidence)) throw new TypeError("invalid browser evidence");
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
      if (existing.length >= MAX_ATTACHMENTS)
        throw new TypeError(`a criterion may retain at most ${MAX_ATTACHMENTS} evidence records`);
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

  snapshot(): BrowserTaskLedgerSnapshot {
    return {
      version: 1,
      ...(this.#authorityId === undefined ? {} : { authorityId: this.#authorityId }),
      criteria: this.#criteria.map((entry) => ({ ...entry })),
      attachments: Object.fromEntries(
        [...this.#attachments].map(([id, entries]) => [id, entries.map((entry) => ({ ...entry }))]),
      ),
      evidence: [...this.#evidence.values()].map((entry) => ({
        ...entry,
        ...(entry.range === undefined ? {} : { range: { ...entry.range } }),
      })),
      steps: [...this.#steps],
      revision: this.#revision,
      reviewedRevision: this.#reviewedRevision,
    };
  }

  restore(value: unknown): boolean {
    const snapshot = parseBrowserTaskLedgerSnapshot(value);
    if (snapshot === undefined) return false;
    this.#authorityId = snapshot.authorityId;
    this.#criteria = snapshot.criteria.map((entry) => ({ ...entry }));
    this.#attachments = new Map(
      Object.entries(snapshot.attachments).map(([id, entries]) => [
        id,
        entries.map((entry) => ({ ...entry })),
      ]),
    );
    this.#evidence.clear();
    for (const entry of snapshot.evidence)
      this.#evidence.set(entry.id, {
        ...entry,
        ...(entry.range === undefined ? {} : { range: { ...entry.range } }),
      });
    this.#steps = [...snapshot.steps];
    this.#revision = snapshot.revision;
    this.#reviewedRevision = snapshot.reviewedRevision;
    return true;
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
