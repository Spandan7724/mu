// The single owner of browser task state.
//
// Two things live here that cannot live anywhere else. First, observation revisions are
// minted by this session rather than read from the driver, so "the page changed" is
// decided from what was actually observed instead of from a driver's bookkeeping.
// Second, every model-facing element reference is minted here and is opaque: it is a
// session token, not a driver ref, not a DOM id, and not a selector. Translating a token
// back to a driver ref requires a live ledger entry whose element still has the identity
// it had when the token was minted, which is what makes ARCHITECTURE §8's rule —
// a stale ref is rejected, never retargeted — structural rather than aspirational.
import { CommitmentLedger } from "../artifacts/commitment.ts";
import { DisclosureLedger } from "../artifacts/disclosure.ts";
import type { AuthorizedDocumentStore } from "../artifacts/documents.ts";
import type { BrowserArtifactStore } from "../artifacts/store.ts";
import type { ObserveRequest } from "../contracts/actions.ts";
import type { ApplicantPolicy } from "../contracts/applicant.ts";
import type { BrowserCarryover, BrowserCarryoverField } from "../contracts/carryover.ts";
import type { DisclosureRecord } from "../contracts/disclosure.ts";
import type { BrowserDriver } from "../contracts/driver.ts";
import { BROWSER_LIMITS } from "../contracts/json.ts";
import {
  type BrowserElement,
  type BrowserElementRef,
  type BrowserObservation,
  elementRefOf,
  type ObservationRevision,
  type RefValidity,
  refValidityMessage,
} from "../contracts/observation.ts";
import type { AuthorizedDocumentId } from "../contracts/primitives.ts";
import { elementRefId } from "../contracts/primitives.ts";
import type { TakeoverState } from "../contracts/takeover.ts";
import { recordFactDisclosure } from "../data/disclosure.ts";
import type { FactLookup } from "../data/facts.ts";
import { type FillPlan, planFill } from "../data/plan.ts";
import { createQuestionQueue } from "../data/questions.ts";
import type { BrowserTaskStateStore } from "../data/task-state-store.ts";
import type { BrowserPolicyState } from "../policy/decide.ts";
import { type InjectionFinding, scanObservation } from "../policy/untrusted.ts";
import type { TakeoverResumeReport } from "../renderers/takeover.ts";
import { BrowserTakeoverSession } from "../renderers/takeover.ts";
import type { BrowserRuntime } from "../runtime/runtime.ts";
import {
  elementIdentity,
  elementSignature,
  OBSERVATION_BUDGET,
  observationDigest,
  rankElements,
} from "./observation.ts";
import {
  type BrowserTaskCriterionInput,
  BrowserTaskLedger,
  type BrowserTaskState,
} from "./task-ledger.ts";

export interface ObservationTarget {
  element: BrowserElement;
  /** The reference the driver understands. Never model-facing. */
  driverRef: BrowserElementRef;
  signature: string;
  /** Position-independent, so an unrelated change elsewhere does not kill this ref. */
  identity: string;
}

export interface ObservationRecord {
  tabId: string;
  revision: ObservationRevision;
  /** Session-facing: opaque refs, session revision, everything else as observed. */
  observation: BrowserObservation;
  /** Complete bounded source for policy, focus, continuations, and ref validation. */
  sourceObservation: BrowserObservation;
  digest: string;
  targets: ReadonlyMap<string, ObservationTarget>;
  /** Identities as of the revision that minted these refs, for the identity check. */
  minted: ReadonlyMap<string, string>;
  injections: InjectionFinding[];
  observedAt: number;
  /** Immutable session evidence; distinct from actionable element refs. */
  evidenceId: string;
  /** Screenshot geometry represented by this record, when one was requested. */
  screenshotScope?: ObserveRequest["screenshot"] | undefined;
}

export interface SessionObserveRequest extends ObserveRequest {
  /** Opaque continuation issued by an earlier observation of this revision. */
  cursor?: string | undefined;
  /** Semantic search over the complete bounded source, never a selector. */
  focus?: string | undefined;
}

export type TargetResolution =
  | { kind: "resolved"; target: ObservationTarget }
  | { kind: "stale"; validity: RefValidity; message: string };

export interface BrowserAuditEntry {
  evidenceId: string;
  at: number;
  tool: string;
  action: string;
  tabId?: string | undefined;
  url?: string | undefined;
  origin?: string | undefined;
  revision?: ObservationRevision | undefined;
  outcome: string;
  scope?: string | undefined;
  pattern?: string | undefined;
  detail?: string | undefined;
}

const MAX_AUDIT_ENTRIES = 200;

interface ObservationCursor {
  tabId: string;
  digest: string;
  offset: number;
  order: string[];
  kind: "document" | "relevance";
  sourceOffset: number;
}

export interface BrowserTaskSessionOptions {
  runtime: BrowserRuntime;
  policy: BrowserPolicyState;
  facts?: FactLookup | undefined;
  applicantPolicy?: ApplicantPolicy | undefined;
  documents?: AuthorizedDocumentStore | undefined;
  receipts?: BrowserReceiptSink | undefined;
  taskStateStore?: BrowserTaskStateStore | undefined;
  now?: (() => number) | undefined;
}

export interface BrowserReceiptSink {
  sessionId: string;
  store: BrowserArtifactStore;
  taskId?: string | undefined;
}

export class BrowserTaskSession {
  readonly runtime: BrowserRuntime;
  /** Duplicate-prevention belongs to the task, not to one tool closure. */
  readonly commitments = new CommitmentLedger();
  readonly disclosures = new DisclosureLedger();
  readonly takeoverController: BrowserTakeoverSession;
  readonly task = new BrowserTaskLedger();
  #facts: FactLookup | undefined;
  readonly applicantPolicy: ApplicantPolicy;
  #documents: AuthorizedDocumentStore | undefined;
  #receipts: BrowserReceiptSink | undefined;
  readonly #taskStateStore: BrowserTaskStateStore | undefined;
  #policy: BrowserPolicyState;
  readonly #now: () => number;
  readonly #records = new Map<string, ObservationRecord>();
  readonly #cursors = new Map<string, ObservationCursor>();
  readonly #plans = new Map<string, FillPlan>();
  readonly #audit: BrowserAuditEntry[] = [];
  readonly #filledFields: BrowserCarryoverField[] = [];
  readonly #uploadedDocumentIds = new Set<AuthorizedDocumentId>();
  readonly #completedSteps = new Set<string>();
  readonly #outstandingSteps = new Set<string>();
  #receiptId: string | undefined;
  #revisionSeq = 0;
  #refSeq = 0;
  #cursorSeq = 0;
  #evidenceSeq = 0;
  #taskStateSessionId: string | undefined;
  #taskSave = Promise.resolve();
  #taskSaveError: unknown;
  #activeTabId: string | undefined;

  constructor(options: BrowserTaskSessionOptions) {
    this.runtime = options.runtime;
    this.#policy = options.policy;
    this.#now = options.now ?? (() => Date.now());
    this.takeoverController = new BrowserTakeoverSession(this.#now);
    this.#facts = options.facts;
    this.applicantPolicy = options.applicantPolicy ?? {};
    this.#documents = options.documents;
    this.#receipts = options.receipts;
    this.#taskStateStore = options.taskStateStore;
    this.runtime.addShutdownHook(() => this.flushTaskState());
  }

  get policy(): BrowserPolicyState {
    return this.#policy;
  }

  /** Policy state is replaced wholesale by the layer that owns approvals, never edited here. */
  setPolicy(policy: BrowserPolicyState): void {
    this.#policy = policy;
  }

  get takeover(): TakeoverState | undefined {
    return this.takeoverController.state;
  }

  get facts(): FactLookup | undefined {
    return this.#facts;
  }

  get documents(): AuthorizedDocumentStore | undefined {
    return this.#documents;
  }

  get receipts(): BrowserReceiptSink | undefined {
    return this.#receipts;
  }

  /** Migration hook for embedders; resources are adopted once and never replaced. */
  configureResources(resources: {
    facts?: FactLookup | undefined;
    documents?: AuthorizedDocumentStore | undefined;
    receipts?: BrowserReceiptSink | undefined;
  }): void {
    if (resources.facts !== undefined) {
      if (this.#facts !== undefined && this.#facts !== resources.facts) {
        throw new TypeError("the task session already owns a different fact store");
      }
      this.#facts = resources.facts;
    }
    if (resources.documents !== undefined) {
      if (this.#documents !== undefined && this.#documents !== resources.documents) {
        throw new TypeError("the task session already owns a different document store");
      }
      this.#documents = resources.documents;
    }
    if (resources.receipts !== undefined) {
      if (this.#receipts !== undefined && this.#receipts !== resources.receipts) {
        throw new TypeError("the task session already owns a different receipt sink");
      }
      this.#receipts = resources.receipts;
    }
  }

  get audit(): readonly BrowserAuditEntry[] {
    return this.#audit;
  }

  get activeTabId(): string | undefined {
    return this.#activeTabId ?? this.runtime.status().activeTabId;
  }

  record(tabId?: string): ObservationRecord | undefined {
    const id = tabId ?? this.activeTabId;
    return id === undefined ? undefined : this.#records.get(id);
  }

  plan(tabId?: string): FillPlan | undefined {
    const id = tabId ?? this.activeTabId;
    return id === undefined ? undefined : this.#plans.get(id);
  }

  async bindTaskState(sessionId: string): Promise<void> {
    if (sessionId === this.#taskStateSessionId) return;
    await this.flushTaskState();
    this.#taskStateSessionId = sessionId;
    const snapshot = await this.#taskStateStore?.load(sessionId);
    if (snapshot === undefined) this.task.reset();
    else if (!this.task.restore(snapshot)) throw new TypeError("browser task state is invalid");
    this.#evidenceSeq = Math.max(
      0,
      ...(snapshot?.evidence.map((entry) => {
        const match = /^evidence-(\d+)$/.exec(entry.id);
        return match === null ? 0 : Number(match[1]);
      }) ?? []),
    );
  }

  async beginTask(authorityId: string): Promise<void> {
    this.task.begin(authorityId);
    await this.#persistTaskState();
    await this.flushTaskState();
  }

  async planTask(
    criteria: readonly BrowserTaskCriterionInput[],
    steps: readonly string[],
  ): Promise<BrowserTaskState> {
    const state = this.task.plan(criteria, steps);
    await this.#persistTaskState();
    await this.flushTaskState();
    return state;
  }

  async attachTaskEvidence(
    criterionId: string,
    evidenceId: string,
    observedItems?: number,
  ): Promise<BrowserTaskState> {
    const state = this.task.attach(criterionId, evidenceId, observedItems);
    await this.#persistTaskState();
    await this.flushTaskState();
    return state;
  }

  /**
   * Observe and file the result. Callers get a record whose refs are safe to hand the
   * model; nothing else in this package mints one.
   */
  async observe(request: SessionObserveRequest, signal: AbortSignal): Promise<ObservationRecord> {
    const { cursor, focus, ...driverRequest } = request;
    const continuation = cursor === undefined ? undefined : this.#cursors.get(cursor);
    if (cursor !== undefined && continuation === undefined) {
      throw new TypeError("that observation cursor is unknown or expired; observe from the start");
    }
    const bounded: ObserveRequest = {
      ...driverRequest,
      // This is the private source backstop, not the model-facing window. Applying the
      // smaller context budget here made omitted controls semantically nonexistent.
      maxNodes: BROWSER_LIMITS.maxElements,
      maxTextChars: BROWSER_LIMITS.maxSnapshotChars,
      ...(continuation === undefined || continuation.sourceOffset === 0
        ? {}
        : { sourceOffset: continuation.sourceOffset }),
    };
    const raw = await this.use((driver) => driver.observe(bounded, signal), signal);
    const record = this.adopt(raw, { cursor, focus, screenshotScope: driverRequest.screenshot });
    await this.flushTaskState();
    return record;
  }

  /** Files an observation the driver produced outside `observe` — a takeover resume, say. */
  adopt(
    raw: BrowserObservation,
    projection: {
      cursor?: string | undefined;
      focus?: string | undefined;
      screenshotScope?: ObserveRequest["screenshot"] | undefined;
    } = {},
  ): ObservationRecord {
    const tabId = raw.tab.id;
    const prior = this.#records.get(tabId);
    const priorCursor =
      projection.cursor === undefined ? undefined : this.#cursors.get(projection.cursor);
    if (projection.cursor !== undefined && priorCursor === undefined) {
      throw new TypeError("that observation cursor is unknown or expired; observe from the start");
    }
    const continuingSource = priorCursor !== undefined && priorCursor.sourceOffset > 0;
    if (
      priorCursor !== undefined &&
      (priorCursor.tabId !== tabId ||
        prior?.sourceObservation.sourceRevision !== raw.sourceRevision)
    ) {
      this.#cursors.delete(projection.cursor as string);
      throw new TypeError(
        "that observation cursor is stale because the page changed; observe again",
      );
    }
    const mergedRaw: BrowserObservation = continuingSource
      ? {
          ...raw,
          elements: [
            ...(prior?.sourceObservation.elements ?? []).map((element) => {
              const target = prior?.targets.get(element.ref);
              return target === undefined ? element : { ...element, ...target.driverRef };
            }),
            ...raw.elements,
          ].slice(0, BROWSER_LIMITS.maxSemanticSourceElements),
        }
      : raw;
    const digest =
      continuingSource || raw.sourceHasMore === true
        ? (raw.sourceRevision ?? observationDigest(mergedRaw))
        : observationDigest(mergedRaw);
    const unchanged = prior !== undefined && prior.digest === digest;
    const revision = unchanged ? prior.revision : ++this.#revisionSeq;

    const targets = new Map<string, ObservationTarget>();
    const minted = new Map<string, string>();
    const sourceElements: BrowserElement[] = [];

    // A ref survives a page change when the same underlying node is still there,
    // unchanged. Both halves are required: the driver's own ref proves it is the same
    // node, and the identity proves the node did not become something else. Matching on
    // the whole-page digest instead meant every ref died whenever anything moved.
    const carried = new Map<string, string>();
    for (const [ref, target] of prior?.targets ?? []) {
      carried.set(`${target.driverRef.ref}\u0000${target.identity}`, ref);
    }
    const claimed = new Set<string>();

    mergedRaw.elements.forEach((element, index) => {
      const identity = elementIdentity(element);
      const driverRef = elementRefOf(element);
      const carriedRef = carried.get(`${driverRef.ref}\u0000${identity}`);
      const ref =
        carriedRef !== undefined && !claimed.has(carriedRef) ? carriedRef : this.#mintRef();
      claimed.add(ref);
      const signature = elementSignature(element, index);
      const projected: BrowserElement = {
        ...element,
        ref: elementRefId(ref),
        revision,
        tabId,
      };
      sourceElements.push(projected);
      targets.set(ref, { element: projected, driverRef, signature, identity });
      minted.set(ref, identity);
    });

    const sourceObservation: BrowserObservation = {
      ...mergedRaw,
      revision,
      elements: sourceElements,
      risks: [...new Set(sourceElements.flatMap((element) => element.risk ?? []))],
    };
    if (
      priorCursor !== undefined &&
      (priorCursor.tabId !== tabId || priorCursor.digest !== digest)
    ) {
      this.#cursors.delete(projection.cursor as string);
      throw new TypeError(
        "that observation cursor is stale because the page changed; observe again",
      );
    }

    const byDriverRef = new Map<string, BrowserElement>();
    for (const element of sourceElements) {
      const driverRef = targets.get(element.ref)?.driverRef.ref;
      if (driverRef !== undefined) byDriverRef.set(driverRef, element);
    }
    const defaultOrder = (): BrowserElement[] => {
      const needle = projection.focus?.trim().toLowerCase();
      if (needle === undefined || needle.length === 0) return sourceElements;
      const scored = sourceElements.map((element, index) => {
        const text = [
          element.role,
          element.name,
          element.label,
          element.placeholder,
          element.description,
        ]
          .filter((entry): entry is string => entry !== undefined)
          .join(" ")
          .toLowerCase();
        return { element, index, focused: text.includes(needle) };
      });
      return scored
        .sort((a, b) => {
          if (a.focused !== b.focused) return a.focused ? -1 : 1;
          return a.index - b.index;
        })
        .map((entry) => entry.element);
    };
    const cursorElements =
      priorCursor?.order.flatMap((driverRef) => {
        const element = byDriverRef.get(driverRef);
        return element === undefined ? [] : [element];
      }) ?? [];
    if (priorCursor !== undefined && cursorElements.length !== priorCursor.order.length) {
      this.#cursors.delete(projection.cursor as string);
      throw new TypeError(
        "that observation cursor is stale because its controls changed; observe again",
      );
    }
    const knownDriverRefs = new Set(priorCursor?.order ?? []);
    const additions = sourceElements.filter((element) => {
      const driverRef = targets.get(element.ref)?.driverRef.ref;
      return driverRef !== undefined && !knownDriverRefs.has(driverRef);
    });
    const ordered =
      priorCursor === undefined
        ? defaultOrder()
        : [
            ...cursorElements,
            ...(priorCursor.kind === "relevance"
              ? rankElements(additions, projection.focus)
              : additions),
          ];
    const start = priorCursor?.offset ?? 0;
    const end = Math.min(start + OBSERVATION_BUDGET.maxRenderedElements, ordered.length);
    const elements = ordered.slice(start, end);
    const order = ordered.map((element) => targets.get(element.ref)?.driverRef.ref ?? "");
    let nextCursor: string | undefined;
    const aggregateCapped =
      mergedRaw.elements.length >= BROWSER_LIMITS.maxSemanticSourceElements &&
      (raw.sourceHasMore === true || (continuingSource && raw.elements.length > 0));
    const needsSource = end >= ordered.length && raw.sourceHasMore === true && !aggregateCapped;
    if (end < ordered.length || needsSource) {
      nextCursor = `cursor-${++this.#cursorSeq}`;
      this.#cursors.set(nextCursor, {
        tabId,
        digest,
        offset: end,
        order,
        kind: priorCursor?.kind ?? (projection.focus === undefined ? "document" : "relevance"),
        sourceOffset:
          needsSource || mergedRaw.elements.length > BROWSER_LIMITS.maxElements
            ? mergedRaw.elements.length
            : 0,
      });
    }
    const documentHeight = raw.viewport.documentHeight;
    const viewportIncomplete =
      documentHeight !== undefined && raw.viewport.scrollY + raw.viewport.height < documentHeight;
    const sourceIncomplete = aggregateCapped || viewportIncomplete;
    const snapshot = elements
      .map(
        (element) =>
          `${element.role ?? "generic"} "${element.label ?? element.name ?? element.ref}"${element.description === undefined ? "" : ` — ${element.description}`}${element.value === undefined ? "" : `: ${element.value}`}`,
      )
      .join("\n")
      .slice(0, OBSERVATION_BUDGET.maxTextChars);
    const observation: BrowserObservation = {
      ...sourceObservation,
      elements,
      snapshot,
      summary:
        `${raw.summary}\nShowing controls ${start + 1}-${end} of ${ordered.length}${sourceIncomplete ? "+ indexed" : ""}`.slice(
          0,
          OBSERVATION_BUDGET.maxSummaryChars,
        ),
      coverage: {
        start,
        end,
        total: ordered.length,
        order: priorCursor?.kind ?? (projection.focus === undefined ? "document" : "relevance"),
        hasMore: end < ordered.length || sourceIncomplete,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        sourceIncomplete,
      },
    };
    const evidenceId = this.#mintEvidenceId();
    const record: ObservationRecord = {
      tabId,
      revision,
      observation,
      sourceObservation,
      digest,
      targets,
      minted,
      injections: scanObservation(sourceObservation),
      observedAt: this.#now(),
      evidenceId,
      ...(projection.screenshotScope === undefined
        ? {}
        : { screenshotScope: projection.screenshotScope }),
    };
    const coverage = observation.coverage;
    this.task.record({
      id: evidenceId,
      kind: "observation",
      url: observation.url,
      tabId,
      revision,
      ...(coverage === undefined
        ? {}
        : {
            order: coverage.order,
            range: { start: coverage.start, end: coverage.end, total: coverage.total },
            ...(observation.viewport.documentHeight === undefined
              ? {}
              : {
                  viewportRange: {
                    start: observation.viewport.scrollY,
                    end: Math.min(
                      observation.viewport.scrollY + observation.viewport.height,
                      observation.viewport.documentHeight,
                    ),
                    total: observation.viewport.documentHeight,
                  },
                }),
            hasMore: coverage.hasMore,
            sourceIncomplete: coverage.sourceIncomplete,
          }),
    });
    void this.#persistTaskState();
    this.#records.set(tabId, record);
    this.#activeTabId = tabId;
    if (!unchanged && this.facts !== undefined) {
      this.#plans.set(
        tabId,
        planFill({
          url: observation.url,
          elements: sourceObservation.elements,
          facts: this.facts,
          policy: this.applicantPolicy,
          questions: createQuestionQueue(),
        }),
      );
    }
    return record;
  }

  /**
   * BD9/ARCHITECTURE §8. Two independent gates, both of which must pass: the reference
   * must belong to the revision that is current for this tab, and the element it names
   * must still have the identity it had when the reference was minted. The second gate
   * exists so that a bug in revision bookkeeping still cannot let a reference resolve to
   * a different control — the case the fixture's `/stale` page is built to catch.
   */
  resolve(ref: BrowserElementRef, record: ObservationRecord): TargetResolution {
    // Deliberately not `refValidity`: that demands the page's revision be untouched,
    // which on a live page it almost never is. What actually has to hold is that this
    // reference still names the same control — checked below against the identity it
    // was minted with. A reference claiming a revision the session never issued is
    // still refused, because nothing legitimate produces one.
    if (ref.tabId !== record.observation.tab.id) {
      return { kind: "stale", validity: "wrong-tab", message: refValidityMessage("wrong-tab") };
    }
    if (ref.revision > record.observation.revision) {
      return {
        kind: "stale",
        validity: "unknown",
        message: refValidityMessage("unknown"),
      };
    }
    if (ref.frameId !== undefined && !record.observation.frames.some((f) => f.id === ref.frameId)) {
      const validity = "unknown-frame" as const;
      return { kind: "stale", validity, message: refValidityMessage(validity) };
    }
    const target = record.targets.get(ref.ref);
    if (target === undefined) {
      return {
        kind: "stale",
        validity: "stale-revision",
        message: refValidityMessage("stale-revision"),
      };
    }
    if (record.minted.get(ref.ref) !== target.identity) {
      return {
        kind: "stale",
        validity: "unknown",
        message:
          "the control this reference named has been replaced by a different one; observe again and take a new reference",
      };
    }
    return { kind: "resolved", target };
  }

  /** Every reference the tools hand a driver comes from here, with the driver's own revision. */
  driverRef(ref: BrowserElementRef, record: ObservationRecord): BrowserElementRef | undefined {
    const resolution = this.resolve(ref, record);
    return resolution.kind === "resolved" ? resolution.target.driverRef : undefined;
  }

  /**
   * Drop what is known about a tab. Called on navigation, tab switch, popup selection and
   * takeover, so the next reference the model uses has to come from a new observation.
   */
  invalidate(tabId?: string): void {
    if (tabId === undefined) {
      this.#records.clear();
      this.#plans.clear();
      this.#cursors.clear();
    } else {
      this.#records.delete(tabId);
      this.#plans.delete(tabId);
      for (const [cursor, state] of this.#cursors) {
        if (state.tabId === tabId) this.#cursors.delete(cursor);
      }
    }
  }

  setActiveTab(tabId: string | undefined): void {
    this.#activeTabId = tabId;
  }

  beginTakeover(state: TakeoverState): void {
    const revision = this.record(state.tabId)?.revision;
    this.takeoverController.begin({
      reason: state.reason,
      instructions: state.instructions,
      tabId: state.tabId,
      url: state.url,
      now: state.startedAt,
      ...(revision === undefined ? {} : { revision }),
    });
    this.invalidate();
  }

  resumeTakeover(raw: BrowserObservation): TakeoverResumeReport {
    const record = this.adopt(raw);
    return this.takeoverController.resume(record.observation);
  }

  recordFilledField(input: { label: string; origin: string; factId?: string | undefined }): void {
    const field: BrowserCarryoverField = {
      label: input.label,
      origin: input.origin,
      ...(input.factId === undefined ? {} : { factId: input.factId }),
    };
    const existing = this.#filledFields.findIndex(
      (candidate) => candidate.origin === field.origin && candidate.label === field.label,
    );
    if (existing >= 0) this.#filledFields.splice(existing, 1);
    this.#filledFields.push(field);
    this.#completedSteps.add(`filled ${field.label}`);
    this.#outstandingSteps.delete(`fill ${field.label}`);
  }

  recordFactDisclosure(input: { url: string; factId: string; fieldName: string }): void {
    if (this.facts === undefined) return;
    recordFactDisclosure(this.disclosures, this.facts, {
      url: input.url,
      fills: [{ factId: input.factId, fieldName: input.fieldName }],
    });
  }

  recordUploadedDocuments(ids: readonly AuthorizedDocumentId[]): void {
    for (const id of ids) this.#uploadedDocumentIds.add(id);
    if (ids.length > 0) this.#completedSteps.add(`uploaded ${ids.length} document(s)`);
  }

  recordReceipt(id: string): void {
    this.#receiptId = id;
    this.#completedSteps.add(`recorded receipt ${id}`);
  }

  markOutstanding(step: string): void {
    if (step.trim().length > 0) this.#outstandingSteps.add(step.trim());
  }

  disclosureRecords(): DisclosureRecord[] {
    return this.disclosures.records();
  }

  carryover(): BrowserCarryover {
    const connection = this.runtime.status();
    const active = this.record();
    const questions = [...this.#plans.values()].flatMap((plan) =>
      plan.questions.map((question) => question.prompt),
    );
    const taskState = this.task.state();
    return {
      connection: {
        mode: connection.mode,
        browser: connection.browser,
        phase: connection.phase,
      },
      ...(active === undefined
        ? {}
        : {
            active: {
              tabId: active.tabId,
              url: active.observation.url,
              ...(active.observation.origin === undefined
                ? {}
                : { origin: active.observation.origin }),
              title: active.observation.title,
              revision: active.revision,
            },
          }),
      allowedOrigins: [...this.policy.origins.allowed],
      completedSteps: [
        ...new Set([
          ...this.#completedSteps,
          ...taskState.criteria
            .filter((criterion) => criterion.satisfied)
            .map((criterion) => criterion.description),
        ]),
      ],
      outstandingSteps: [
        ...new Set([
          ...this.#outstandingSteps,
          ...taskState.criteria
            .filter((criterion) => !criterion.satisfied)
            .map((criterion) => criterion.description),
        ]),
      ],
      filledFields: this.#filledFields.map((field) => ({ ...field })),
      unresolvedQuestions: [...new Set(questions)],
      uploadedDocumentIds: [...this.#uploadedDocumentIds],
      ...(this.takeover === undefined ? {} : { takeover: this.takeover }),
      ...(this.#receiptId === undefined ? {} : { receiptId: this.#receiptId }),
    };
  }

  use<T>(operation: (driver: BrowserDriver) => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.runtime.use(operation, signal);
  }

  note(entry: Omit<BrowserAuditEntry, "at" | "evidenceId">): BrowserAuditEntry {
    const evidenceId = this.#mintEvidenceId();
    const recorded: BrowserAuditEntry = { at: this.#now(), evidenceId, ...entry };
    this.#audit.push(recorded);
    if (this.#audit.length > MAX_AUDIT_ENTRIES) this.#audit.shift();
    this.task.record({
      id: evidenceId,
      kind: "action",
      ...(entry.url === undefined ? {} : { url: entry.url }),
      ...(entry.tabId === undefined ? {} : { tabId: entry.tabId }),
      ...(entry.revision === undefined ? {} : { revision: entry.revision }),
      tool: entry.tool,
      action: entry.action,
      outcome: entry.outcome,
    });
    void this.#persistTaskState();
    return recorded;
  }

  #mintRef(): string {
    this.#refSeq += 1;
    return `r${this.#refSeq}`;
  }

  #mintEvidenceId(): string {
    this.#evidenceSeq += 1;
    return `evidence-${this.#evidenceSeq}`;
  }

  async flushTaskState(): Promise<void> {
    await this.#taskSave;
    if (this.#taskSaveError !== undefined) {
      const error = this.#taskSaveError;
      this.#taskSaveError = undefined;
      throw error;
    }
  }

  #persistTaskState(): Promise<void> {
    const store = this.#taskStateStore;
    const sessionId = this.#taskStateSessionId;
    if (store === undefined || sessionId === undefined) return Promise.resolve();
    const snapshot = this.task.snapshot();
    this.#taskSave = this.#taskSave
      .catch(() => {})
      .then(() => store.save(sessionId, snapshot))
      .catch((error: unknown) => {
        this.#taskSaveError = error;
      });
    return this.#taskSave;
  }
}

/** @deprecated Use BrowserTaskSession. Kept as a source-compatible migration alias. */
export { BrowserTaskSession as BrowserToolSession };
/** @deprecated Use BrowserTaskSessionOptions. */
export type BrowserToolSessionOptions = BrowserTaskSessionOptions;
