// The reference ledger the browser tools act through.
//
// Two things live here that cannot live anywhere else. First, observation revisions are
// minted by this session rather than read from the driver, so "the page changed" is
// decided from what was actually observed instead of from a driver's bookkeeping.
// Second, every model-facing element reference is minted here and is opaque: it is a
// session token, not a driver ref, not a DOM id, and not a selector. Translating a token
// back to a driver ref requires a live ledger entry whose element still has the identity
// it had when the token was minted, which is what makes ARCHITECTURE §8's rule —
// a stale ref is rejected, never retargeted — structural rather than aspirational.
import type { ObserveRequest } from "../contracts/actions.ts";
import type { BrowserDriver } from "../contracts/driver.ts";
import {
  type BrowserElement,
  type BrowserElementRef,
  type BrowserObservation,
  elementRefOf,
  type ObservationRevision,
  type RefValidity,
  refValidityMessage,
} from "../contracts/observation.ts";
import { elementRefId } from "../contracts/primitives.ts";
import type { TakeoverState } from "../contracts/takeover.ts";
import type { BrowserPolicyState } from "../policy/decide.ts";
import { type InjectionFinding, scanObservation } from "../policy/untrusted.ts";
import type { BrowserRuntime } from "../runtime/runtime.ts";
import {
  elementIdentity,
  elementSignature,
  OBSERVATION_BUDGET,
  observationDigest,
} from "./observation.ts";

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
  digest: string;
  targets: ReadonlyMap<string, ObservationTarget>;
  /** Identities as of the revision that minted these refs, for the identity check. */
  minted: ReadonlyMap<string, string>;
  injections: InjectionFinding[];
  observedAt: number;
}

export type TargetResolution =
  | { kind: "resolved"; target: ObservationTarget }
  | { kind: "stale"; validity: RefValidity; message: string };

export interface BrowserAuditEntry {
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

export interface BrowserToolSessionOptions {
  runtime: BrowserRuntime;
  policy: BrowserPolicyState;
  now?: (() => number) | undefined;
}

export class BrowserToolSession {
  readonly runtime: BrowserRuntime;
  #policy: BrowserPolicyState;
  #takeover: TakeoverState | undefined;
  readonly #now: () => number;
  readonly #records = new Map<string, ObservationRecord>();
  readonly #audit: BrowserAuditEntry[] = [];
  #revisionSeq = 0;
  #refSeq = 0;
  #activeTabId: string | undefined;

  constructor(options: BrowserToolSessionOptions) {
    this.runtime = options.runtime;
    this.#policy = options.policy;
    this.#now = options.now ?? (() => Date.now());
  }

  get policy(): BrowserPolicyState {
    return this.#policy;
  }

  /** Policy state is replaced wholesale by the layer that owns approvals, never edited here. */
  setPolicy(policy: BrowserPolicyState): void {
    this.#policy = policy;
  }

  get takeover(): TakeoverState | undefined {
    return this.#takeover;
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

  /**
   * Observe and file the result. Callers get a record whose refs are safe to hand the
   * model; nothing else in this package mints one.
   */
  async observe(request: ObserveRequest, signal: AbortSignal): Promise<ObservationRecord> {
    const bounded: ObserveRequest = {
      ...request,
      maxNodes: Math.min(
        request.maxNodes ?? OBSERVATION_BUDGET.maxElements,
        OBSERVATION_BUDGET.maxElements,
      ),
      maxTextChars: Math.min(
        request.maxTextChars ?? OBSERVATION_BUDGET.maxTextChars,
        OBSERVATION_BUDGET.maxTextChars,
      ),
    };
    const raw = await this.use((driver) => driver.observe(bounded, signal), signal);
    return this.adopt(raw);
  }

  /** Files an observation the driver produced outside `observe` — a takeover resume, say. */
  adopt(raw: BrowserObservation): ObservationRecord {
    const tabId = raw.tab.id;
    const digest = observationDigest(raw);
    const prior = this.#records.get(tabId);
    const unchanged = prior !== undefined && prior.digest === digest;
    const revision = unchanged ? prior.revision : ++this.#revisionSeq;

    const targets = new Map<string, ObservationTarget>();
    const minted = new Map<string, string>();
    const elements: BrowserElement[] = [];

    // A ref survives a page change when the same underlying node is still there,
    // unchanged. Both halves are required: the driver's own ref proves it is the same
    // node, and the identity proves the node did not become something else. Matching on
    // the whole-page digest instead meant every ref died whenever anything moved.
    const carried = new Map<string, string>();
    for (const [ref, target] of prior?.targets ?? []) {
      carried.set(`${target.driverRef.ref}\u0000${target.identity}`, ref);
    }
    const claimed = new Set<string>();

    raw.elements.forEach((element, index) => {
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
      elements.push(projected);
      targets.set(ref, { element: projected, driverRef, signature, identity });
      minted.set(ref, identity);
    });

    const observation: BrowserObservation = { ...raw, revision, elements };
    const record: ObservationRecord = {
      tabId,
      revision,
      observation,
      digest,
      targets,
      minted,
      injections: scanObservation(observation),
      observedAt: this.#now(),
    };
    this.#records.set(tabId, record);
    this.#activeTabId = tabId;
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
    if (tabId === undefined) this.#records.clear();
    else this.#records.delete(tabId);
  }

  setActiveTab(tabId: string | undefined): void {
    this.#activeTabId = tabId;
  }

  beginTakeover(state: TakeoverState): void {
    this.#takeover = state;
    this.invalidate();
  }

  endTakeover(): void {
    this.#takeover = undefined;
  }

  use<T>(operation: (driver: BrowserDriver) => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.runtime.use(operation, signal);
  }

  note(entry: Omit<BrowserAuditEntry, "at">): BrowserAuditEntry {
    const recorded: BrowserAuditEntry = { at: this.#now(), ...entry };
    this.#audit.push(recorded);
    if (this.#audit.length > MAX_AUDIT_ENTRIES) this.#audit.shift();
    return recorded;
  }

  #mintRef(): string {
    this.#refSeq += 1;
    return `r${this.#refSeq}`;
  }
}
