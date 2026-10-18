import { randomUUID } from "node:crypto";
import {
  addUsage,
  type Credential,
  defaultModelRef,
  findModel,
  getProvider,
  type ModelInfo,
  type PromptSection,
  type Provider,
  supportedThinkingLevels,
  type ThinkingLevel,
  thinkingLevelForModel,
  type Usage,
  zeroUsage,
} from "@mu/ai";
import {
  type AgentContext,
  type AgentEvent,
  type AgentMessage,
  type AnyTool,
  AUTO_COMPACT_THRESHOLD,
  applyCompaction,
  type CheckpointDiffFile,
  type CheckpointEntry,
  CheckpointHistory,
  type CheckpointProvider,
  CompactionError,
  type CompactionTrigger,
  type CustomMessage,
  compact as compactContext,
  contextState,
  DEFAULT_KEEP_RECENT_TOKENS,
  type EventSink,
  type ExtensionHost,
  estimateTextTokens,
  estimateTokens,
  evaluate,
  isContextTooLongResult,
  type LoopConfig,
  MemorySessionStore,
  MICROCOMPACT_THRESHOLD,
  microcompact,
  type PermissionRequest,
  type PermissionRule,
  type ProfileRuntime,
  runLoop,
  SESSION_VERSION,
  type SessionStore,
  SessionTree,
  SUPERSEDE_WITHIN_TURNS,
  shouldCompact,
  type TurnInfo,
  type UserContent,
  userMessage,
} from "@mu/core";
import type { z } from "zod";
import { type Budget, type BudgetBreach, checkBudget, totalTokens } from "./budget.ts";
import {
  STRUCTURED_OUTPUT_REMINDERS,
  STRUCTURED_OUTPUT_TOOL,
  StructuredOutputError,
  structuredOutputPrompt,
  structuredOutputReminder,
  structuredOutputTool,
} from "./structured-output.ts";
import { resolveWebSearchBackend } from "./web-search.ts";

const DEFAULT_PERMISSIONS: PermissionRule[] = [{ permission: "*", pattern: "*", action: "allow" }];

const DEFAULT_SYSTEM_PROMPT =
  "You are mu, a capable and direct assistant. Use the tools available to you to complete the user's task. Be concise: answer what was asked without padding. When a task is done, say so plainly.";

export type HaltReason = "done" | "aborted" | "error" | "maxTurns" | "maxCostUsd" | "maxTokens";

export interface AgentOptions {
  model?: string | ModelInfo;
  provider?: Provider;
  systemPrompt?: string | PromptSection[];
  tools?: AnyTool[];
  permissions?: PermissionRule[];
  // Library default is DENY: an unattended process must never hang on a prompt.
  onPermission?: (request: PermissionRequest) => Promise<"allow" | "deny">;
  budget?: Budget;
  session?: SessionStore;
  sessionId?: string;
  // Stored in the session header so every surface can identify and reconstruct
  // the profile-specific conversation environment.
  sessionProfile?: string;
  sessionEnvironment?: Record<string, string>;
  thinkingLevel?: ThinkingLevel;
  apiKey?: string;
  // Resolved for the active provider before every model request. Returning
  // undefined preserves that provider's explicit/env API-key fallback.
  getCredentials?: (provider: string) => Promise<Credential | undefined>;
  // Typed context messages seeded once at the start of a session (profiles use
  // this for environment + project instructions — never a system-prompt edit).
  initialMessages?: AgentMessage[];
  // Domain-neutral refresh seam for profile-owned context. Returned messages
  // are persisted before the next run, including after session resume.
  refreshContext?: (
    messages: AgentMessage[],
    context: { sessionId: string },
  ) => Promise<AgentMessage[]> | AgentMessage[];
  // Compaction (M7). Auto-compaction runs when the context crosses the
  // threshold; the profile supplies what its domain must not lose.
  carryoverExtractor?: (messages: AgentMessage[]) => unknown;
  autoCompact?: boolean;
  compactThreshold?: number;
  // Transient images expire after three subsequent model responses by default.
  imageRetentionTurns?: number;
  // Estimated image allowance; defaults to 10% of the model window.
  imageBudgetTokens?: number;
  // Snapshot/restore backing for /undo and /redo (profiles supply it).
  checkpointProvider?: CheckpointProvider;
  // Why there is no checkpointProvider here, reported by undo and redo.
  checkpointUnavailable?: string;
  // Why the checkpointProvider records only part of what can change here.
  checkpointNotice?: string;
  // Session-owned resources supplied by a profile (background processes,
  // browser sessions, etc.). The Agent owns their event and cleanup lifecycle.
  runtime?: ProfileRuntime;
  // Extensions registered on this host observe events and may block/modify
  // tool calls, results and the pre-LLM context.
  extensions?: ExtensionHost;
}

export interface RunResult {
  text: string;
  messages: AgentMessage[];
  usage: Usage;
  reason: HaltReason;
  sessionId: string;
  // The provider's explanation when reason is "error".
  error?: string;
}

export interface CheckpointActionData {
  kind: "checkpoint";
  action: "undo" | "redo";
  files: CheckpointDiffFile[];
  turnCount?: number;
  messageCount: number;
  prompt?: string;
}

export interface CheckpointActionResult {
  ok: boolean;
  message: string;
  data?: CheckpointActionData;
}

export interface UndoPoint {
  steps: number;
  prompt: string;
  messageCount: number;
}

export interface ManualCompactionResult {
  status: "completed" | "queued" | "failed" | "cancelled" | "noop";
  message: string;
  tokensBefore?: number;
  tokensAfter?: number;
  tokensFreed?: number;
  toolResultsCleared?: number;
  summaryEntryId?: string;
}

export interface AgentRunOptions<T = unknown> {
  output?: z.ZodType<T>;
  model?: string | ModelInfo;
  allowedTools?: string[];
}

export interface ChildAgentOptions {
  model?: ModelInfo;
  thinkingLevel?: ThinkingLevel;
  systemPrompt: string;
  tools: AnyTool[];
  permissions?: PermissionRule[];
  budget?: Budget;
  // History-only children must not run profile context loaders or inherit
  // instructions that direct them to external resources.
  inheritContext?: boolean;
  // Replaces the inherited context refresh (a profile's per-child context).
  refreshContext?: AgentOptions["refreshContext"];
  // Names the child in the permission requests it raises through the parent; read
  // per request, since a child moved to the background gains a name mid-run.
  permissionLabel?: string | (() => string | undefined);
}

export interface BackgroundWork {
  label: string;
  // Settles once the work's result has been delivered or recorded.
  done: Promise<unknown>;
  stop: (reason: "user" | "session") => void;
}

function resolveModel(model: AgentOptions["model"], extensions?: ExtensionHost): ModelInfo {
  if (model && typeof model !== "string") return model;
  const ref = model ?? defaultModelRef();
  const found = extensions?.findModel(ref) ?? findModel(ref);
  if (!found) throw new Error(`Unknown model: ${ref}. Pass a ModelInfo to use a custom model.`);
  return found;
}

function resolveSystemPrompt(prompt: AgentOptions["systemPrompt"]): PromptSection[] {
  if (prompt === undefined) return [{ text: DEFAULT_SYSTEM_PROMPT }];
  return typeof prompt === "string" ? [{ text: prompt }] : prompt;
}

function lastText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.trim().length > 0) return text;
  }
  return "";
}

function lastError(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.stopReason === "error") {
      return message.errorMessage ?? "the provider returned an error";
    }
  }
  return undefined;
}

function createSessionId(): string {
  return `s${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

// Tools that do not say, and classifiers that fail, count as changing state:
// a skipped capture would make the turn's undo silently incomplete.
function mayChangeState(tool: AnyTool | undefined, args: unknown): boolean {
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
function declaredResources(tool: AnyTool | undefined, args: unknown): string[] | undefined {
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

// What a turn's allowed tool calls may have changed. `unknown` is set by a call
// that may change state without naming every resource it changes. With
// declared coverage, `uncaptured` holds resources whose prior state could not
// be recorded, and `capture` serializes those pre-change captures.
interface TurnChanges {
  resources: Set<string>;
  unknown: boolean;
  uncaptured: Set<string>;
  capture: Promise<void>;
}

export class Agent {
  private readonly options: AgentOptions;
  private model: ModelInfo;
  private provider: Provider;
  private readonly store: SessionStore;
  private tree: SessionTree;
  private _sessionId: string;
  private controller = new AbortController();
  private steering: AgentMessage[] = [];
  private followUps: AgentMessage[] = [];
  private totals: Usage = zeroUsage();
  private compactRequested = false;
  private compactRequestedFocus: string | undefined;
  private queuedManualCompactionFocus: string | undefined;
  private manualCompactionQueued = false;
  private compacting = false;
  private compactorOverride: { model: ModelInfo; provider: Provider } | undefined;
  private lastContextPercent = 0;
  private lastContextTokens = 0;
  private lastContextUsage: { usage: Usage; estimatedTokensAtUsage: number } | undefined;
  private readonly checkpoints = new CheckpointHistory();
  private recoveryAttempted = false;
  private reactiveRecoveryPending = false;
  private pendingCheckpoint: { beforeEntryId: string | null; beforeRef: string } | undefined;
  // Profile-runtime tasks still running; they may change state outside any tool call.
  private readonly runningTasks = new Set<string>();
  private readonly backgroundCalls = new Map<string, AbortController>();
  private currentThinking: ThinkingLevel;
  // What the caller selected, before reconciling it with the model's levels.
  private requestedThinking: ThinkingLevel | undefined;
  private readonly thinkingNotices = new Set<string>();
  private running = false;
  private stopping = false;
  private activeEmit: ((event: AgentEvent) => void) | undefined;
  private activeExecution: Promise<unknown> | undefined;
  private autonomousScheduled = false;
  private readonly subscribers = new Set<EventSink>();
  private readonly subscriberQueues = new Map<EventSink, Promise<void>>();
  private readonly idleWaiters = new Set<() => void>();
  private shutdownPromise: Promise<void> | undefined;
  private sessionStarted = false;
  private permissionRules: PermissionRule[];
  private parentAgent: Agent | undefined;
  // A child created without its own rules follows the parent's current rules,
  // so a live permission-mode change also governs work already delegated.
  private inheritsPermissions = false;
  private readonly children = new Set<Agent>();
  private readonly background = new Map<BackgroundWork, Promise<void>>();

  constructor(options: AgentOptions = {}) {
    this.options = options;
    this.permissionRules = [...(options.permissions ?? DEFAULT_PERMISSIONS)];
    this.model = resolveModel(options.model, options.extensions);
    this.requestedThinking = options.thinkingLevel;
    this.currentThinking = thinkingLevelForModel(this.model, options.thinkingLevel);
    this.provider = this.providerFor(this.model);
    this.store = options.session ?? new MemorySessionStore();
    this._sessionId = options.sessionId ?? createSessionId();
    this.tree = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: this._sessionId,
      createdAt: new Date().toISOString(),
      profile: options.sessionProfile ?? "default",
      environment: { ...(options.sessionEnvironment ?? {}) },
    });
    options.runtime?.attach({
      emit: (event) => this.emitTaskEvent(event),
      followUp: (message) => this.followUp(message),
      record: (message) =>
        this.trackBackground({
          label: "record",
          done: this.recordMessage(message),
          stop: () => {},
        }),
    });
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get checkpointUnavailable(): string | undefined {
    return this.options.checkpointProvider ? undefined : this.options.checkpointUnavailable;
  }

  get checkpointNotice(): string | undefined {
    return this.options.checkpointProvider ? this.options.checkpointNotice : undefined;
  }

  get usage(): Usage {
    return this.totals;
  }

  get session(): SessionTree {
    return this.tree;
  }

  get sessionStore(): SessionStore {
    return this.store;
  }

  get modelRef(): string {
    return `${this.model.provider}/${this.model.id}`;
  }

  get modelInfo(): ModelInfo {
    return this.model;
  }

  get contextWindow(): number {
    return this.model.contextWindow;
  }

  get thinking(): ThinkingLevel {
    return this.currentThinking;
  }

  get thinkingLevels(): ThinkingLevel[] {
    return supportedThinkingLevels(this.model);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isCompacting(): boolean {
    return this.compacting;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  get permissions(): PermissionRule[] {
    return [...this.effectivePermissionRules()];
  }

  get backgroundWork(): string[] {
    return [...this.background.keys()].map((work) => work.label);
  }

  get tools(): AnyTool[] {
    return [
      ...(this.options.tools ?? []),
      ...(this.options.extensions ? [...this.options.extensions.tools.values()] : []),
    ];
  }

  availableModel(ref: string): ModelInfo | undefined {
    return this.options.extensions?.findModel(ref) ?? findModel(ref);
  }

  createChild(options: ChildAgentOptions): Agent {
    const model = options.model ?? this.model;
    const parentBudget = this.options.budget;
    const childBudget: Budget = { ...options.budget };
    if (parentBudget?.maxCostUsd !== undefined) {
      childBudget.maxCostUsd = Math.min(
        childBudget.maxCostUsd ?? Number.POSITIVE_INFINITY,
        Math.max(0, parentBudget.maxCostUsd - (this.totals.costUsd ?? 0)),
      );
    }
    if (parentBudget?.maxTokens !== undefined) {
      childBudget.maxTokens = Math.min(
        childBudget.maxTokens ?? Number.POSITIVE_INFINITY,
        Math.max(0, parentBudget.maxTokens - totalTokens(this.totals)),
      );
    }
    const hasChildBudget = Object.values(childBudget).some((value) => value !== undefined);
    const child = new Agent({
      model,
      provider: this.providerFor(model),
      systemPrompt: [
        ...(options.inheritContext === false ? [] : resolveSystemPrompt(this.options.systemPrompt)),
        { text: options.systemPrompt },
      ],
      tools: options.tools,
      ...(this.options.imageRetentionTurns !== undefined
        ? { imageRetentionTurns: this.options.imageRetentionTurns }
        : {}),
      ...(this.options.imageBudgetTokens !== undefined
        ? { imageBudgetTokens: this.options.imageBudgetTokens }
        : {}),
      permissions: options.permissions ?? this.permissions,
      onPermission: (request) => {
        const label =
          typeof options.permissionLabel === "function"
            ? options.permissionLabel()
            : options.permissionLabel;
        return this.resolveChildPermission(
          label ? { ...request, description: `${label} · ${request.description}` } : request,
        );
      },
      ...(hasChildBudget ? { budget: childBudget } : {}),
      session: new MemorySessionStore(),
      ...(this.options.sessionProfile ? { sessionProfile: this.options.sessionProfile } : {}),
      ...(this.options.sessionEnvironment
        ? { sessionEnvironment: this.options.sessionEnvironment }
        : {}),
      thinkingLevel: options.thinkingLevel ?? this.currentThinking,
      ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
      ...(this.options.getCredentials ? { getCredentials: this.options.getCredentials } : {}),
      ...(options.refreshContext
        ? { refreshContext: options.refreshContext }
        : options.inheritContext !== false && this.options.refreshContext
          ? { refreshContext: this.options.refreshContext }
          : {}),
    });
    child.parentAgent = this;
    child.inheritsPermissions = options.permissions === undefined;
    this.children.add(child);
    return child;
  }

  setPermissions(rules: PermissionRule[]): void {
    this.permissionRules = [...rules];
    this.inheritsPermissions = false;
  }

  addPermissionRule(rule: PermissionRule): void {
    if (this.inheritsPermissions) this.setPermissions(this.effectivePermissionRules());
    this.permissionRules.push(rule);
  }

  // Provider usage incurred on this Agent's behalf outside its own model turns
  // and tool results, such as a background child that finished between runs.
  chargeUsage(usage: Usage): void {
    this.totals = addUsage(this.totals, usage);
    this.claimChildUsage(usage);
    this.publishEvent({
      type: "usage_updated",
      sessionTotals: this.totals,
      contextTokens: this.lastContextTokens,
      contextPercent: this.lastContextPercent,
    });
  }

  // Session-owned work that outlives the tool call that started it. Changing
  // or stopping the session stops it; shutdown waits for it to finish.
  trackBackground(work: BackgroundWork): void {
    if (this.stopping) {
      work.stop("session");
      return;
    }
    const done = work.done.then(
      () => undefined,
      () => undefined,
    );
    this.background.set(work, done);
    void done.finally(() => {
      this.background.delete(work);
      this.resolveIdleIfDone();
    });
  }

  // A user's request to stop one piece of background work by its label.
  // Stops a background subagent or other tracked work by label, or a runtime task by id.
  stopBackgroundWork(label: string): boolean {
    for (const work of this.background.keys()) {
      if (work.label !== label) continue;
      work.stop("user");
      return true;
    }
    if (!this.runningTasks.has(label)) return false;
    return this.options.runtime?.stopTask?.(label) ?? false;
  }

  // Idle with no background work left: what a one-shot caller waits for before
  // exiting so that background results are delivered rather than abandoned.
  async waitForSettled(): Promise<void> {
    for (;;) {
      await this.waitForIdle();
      if (this.background.size === 0) return;
      await Promise.race(this.background.values());
    }
  }

  // Appends a custom message at the session head once no run owns the
  // transcript, for results that arrive after the session stopped taking turns.
  async recordMessage(message: CustomMessage): Promise<void> {
    while (this.activeExecution) await this.activeExecution.catch(() => {});
    this.tree.appendMessage(message);
    await this.store.save(this._sessionId, this.tree);
  }

  // Switching model also switches provider — they travel together.
  setModel(ref: string | ModelInfo): void {
    const previous = { model: this.model, provider: this.provider };
    const next = resolveModel(ref, this.options.extensions);
    const visible = this.tree.messagesAt();
    if (
      visible.length > 0 &&
      estimateTokens(visible) >=
        next.contextWindow * (this.options.compactThreshold ?? AUTO_COMPACT_THRESHOLD)
    ) {
      this.compactRequested = true;
      this.compactorOverride = previous;
    }
    this.model = next;
    this.provider = this.providerFor(next);
    const nextThinking = thinkingLevelForModel(next, this.currentThinking);
    const thinkingChanged = nextThinking !== this.currentThinking;
    this.currentThinking = nextThinking;
    // Usage reported by the previous model cannot be reconciled against the new
    // window, so accounting falls back to an estimate rather than to zero.
    this.lastContextUsage = undefined;
    this.refreshContextAccounting();
    this.tree.append({
      type: "settings-change",
      model: this.modelRef,
      ...(thinkingChanged ? { thinkingLevel: nextThinking } : {}),
    });
    this.options.extensions?.emitLifecycle({ type: "model_select", model: this.modelRef });
  }

  // Adopts newer catalog metadata for the current model (context window, output
  // limit, thinking levels) once discovery replaces what the session started
  // from. It is the same model, so nothing is recorded in the session.
  refreshModelInfo(): boolean {
    if (this.model === this.options.model) return false;
    const found = this.options.extensions?.findModel(this.modelRef) ?? findModel(this.modelRef);
    if (!found || JSON.stringify(found) === JSON.stringify(this.model)) return false;
    this.model = found;
    this.provider = this.providerFor(found);
    const nextThinking = thinkingLevelForModel(found, this.currentThinking);
    if (nextThinking !== this.currentThinking) {
      this.currentThinking = nextThinking;
      this.tree.append({ type: "settings-change", thinkingLevel: nextThinking });
    }
    this.refreshContextAccounting();
    return true;
  }

  setThinking(level: ThinkingLevel): void {
    this.requestedThinking = level;
    const next = thinkingLevelForModel(this.model, level);
    if (next === this.currentThinking) return;
    this.currentThinking = next;
    this.tree.append({ type: "settings-change", thinkingLevel: next });
  }

  // Adopts a previously stored session so the next run continues it rather
  // than starting a fresh transcript.
  resume(tree: SessionTree): void {
    if (this.running) throw new Error("Cannot resume a session while a run is active.");
    this.stopBackground();
    let candidate: SessionTree;
    try {
      candidate = SessionTree.fromJsonl(tree.toJsonl());
    } catch (error) {
      throw new Error("Cannot resume an invalid or unsupported session.", { cause: error });
    }
    const header = candidate.header;
    if (!header || header.version !== SESSION_VERSION) {
      throw new Error("Cannot resume an invalid or unsupported session.");
    }
    this.tree = candidate;
    this._sessionId = header.id;
    // Rebuild cumulative usage from the whole tree rather than starting over
    // at zero — every assistant turn and past compaction call, on any branch
    // (including abandoned forks), was real spend whether or not the current
    // process saw it happen. Entries are stored once and shared by reference
    // across branches, so summing all() can't double-count a shared ancestor.
    let restoredTotals = zeroUsage();
    for (const entry of candidate.all()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        restoredTotals = addUsage(restoredTotals, entry.message.usage);
      } else if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.usage
      ) {
        restoredTotals = addUsage(restoredTotals, entry.message.usage);
      } else if (
        entry.type === "message" &&
        entry.message.role === "custom" &&
        entry.message.usage
      ) {
        restoredTotals = addUsage(restoredTotals, entry.message.usage);
      } else if (entry.type === "compaction" && entry.usage) {
        restoredTotals = addUsage(restoredTotals, entry.usage);
      } else if (entry.type === "compaction-attempt") {
        restoredTotals = addUsage(restoredTotals, entry.usage);
      }
    }
    this.totals = restoredTotals;
    this.lastContextUsage = undefined;
    this.compactRequested = false;
    this.compactRequestedFocus = undefined;
    this.queuedManualCompactionFocus = undefined;
    this.manualCompactionQueued = false;
    this.compacting = false;
    this.compactorOverride = undefined;
    this.recoveryAttempted = false;
    this.reactiveRecoveryPending = false;
    this.steering = [];
    this.followUps = [];
    this.pendingCheckpoint = undefined;
    this.sessionStarted = false;
    this.controller = new AbortController();
    this.model = resolveModel(this.options.model, this.options.extensions);
    this.provider = this.providerFor(this.model);
    this.currentThinking = thinkingLevelForModel(this.model, this.options.thinkingLevel);
    for (const entry of candidate.activePath()) {
      if (entry.type !== "settings-change") continue;
      if (entry.model) {
        try {
          this.model = resolveModel(entry.model, this.options.extensions);
          this.provider = this.providerFor(this.model);
        } catch {
          // A removed catalog model must not make an otherwise valid session
          // impossible to resume; retain the last valid setting.
        }
      }
      if (typeof entry.thinkingLevel === "string" && entry.thinkingLevel.length > 0) {
        this.currentThinking = entry.thinkingLevel;
      }
    }
    this.requestedThinking = this.currentThinking;
    this.currentThinking = thinkingLevelForModel(this.model, this.currentThinking);
    this.rebuildCheckpointHistory();
    this.refreshContextAccounting();
  }

  // Starts an independent conversation while keeping this Agent's configured
  // tools, permissions, model, thinking level, runtime, and subscribers.
  newSession(sessionId = createSessionId()): void {
    if (this.running) throw new Error("Cannot start a new session while a run is active.");
    this.stopBackground();
    this._sessionId = sessionId;
    this.tree = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: sessionId,
      createdAt: new Date().toISOString(),
      profile: this.options.sessionProfile ?? "default",
      environment: { ...(this.options.sessionEnvironment ?? {}) },
    });
    this.tree.append({
      type: "settings-change",
      model: this.modelRef,
      thinkingLevel: this.currentThinking,
    });
    this.totals = zeroUsage();
    this.lastContextUsage = undefined;
    this.compactRequested = false;
    this.compactRequestedFocus = undefined;
    this.queuedManualCompactionFocus = undefined;
    this.manualCompactionQueued = false;
    this.compacting = false;
    this.compactorOverride = undefined;
    this.recoveryAttempted = false;
    this.reactiveRecoveryPending = false;
    this.steering = [];
    this.followUps = [];
    this.pendingCheckpoint = undefined;
    this.checkpoints.restore([]);
    this.sessionStarted = false;
    this.controller = new AbortController();
    this.refreshContextAccounting();
  }

  // Steer a run that is already in flight; delivered before the next LLM call.
  send(message: string): void {
    this.steering.push(userMessage(message));
  }

  // Wake a run that would otherwise stop (also how background work resumes it).
  // A string is the user's own words; a message lets a caller wake the run with
  // context the user never typed.
  followUp(message: string | CustomMessage): void {
    if (this.stopping) return;
    this.followUps.push(typeof message === "string" ? userMessage(message) : message);
    if (!this.running) this.scheduleAutonomousRun();
  }

  // Withdraws a queued follow-up by identity before the loop delivers it.
  withdrawFollowUp(message: AgentMessage): boolean {
    const index = this.followUps.indexOf(message);
    if (index === -1) return false;
    this.followUps.splice(index, 1);
    this.resolveIdleIfDone();
    return true;
  }

  // Removes a specific message while it is still waiting in an agent queue.
  // Surfaces use this to restore pending input to an editor without retracting
  // a message that the loop has already begun delivering.
  removeQueuedMessage(kind: "steer" | "follow-up", text: string): boolean {
    const queue = kind === "steer" ? this.steering : this.followUps;
    for (let index = queue.length - 1; index >= 0; index--) {
      const message = queue[index];
      if (message?.role !== "user") continue;
      const queuedText = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (queuedText !== text) continue;
      queue.splice(index, 1);
      this.resolveIdleIfDone();
      return true;
    }
    return false;
  }

  // Profile runtimes forward background-task events here. Active streams see
  // them immediately; persistent subscribers also see them while the Agent is
  // idle, rather than receiving a stale event on some later user turn.
  emitTaskEvent(event: AgentEvent): void {
    if (event.type === "task_started") this.runningTasks.add(event.taskId);
    if (event.type === "task_exited") this.runningTasks.delete(event.taskId);
    this.publishEvent(event);
  }

  subscribe(listener: EventSink): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
      this.subscriberQueues.delete(listener);
    };
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.options.runtime?.resize?.(cols, rows);
  }

  waitForIdle(): Promise<void> {
    if (
      !this.running &&
      !this.autonomousScheduled &&
      !this.manualCompactionQueued &&
      this.followUps.length === 0
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  // Synchronous half of shutdown so signal handlers can stop owned resources
  // before re-raising the signal. shutdown() awaits their actual exits.
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.followUps = [];
    this.manualCompactionQueued = false;
    this.queuedManualCompactionFocus = undefined;
    this.stopBackground();
    try {
      this.options.runtime?.stop?.();
    } catch {
      // Still abort the active model request even if resource signaling fails.
    }
    this.controller.abort();
    this.resolveIdleIfDone();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stop();
    this.shutdownPromise = (async () => {
      await this.activeExecution?.catch(() => {});
      await Promise.all(this.background.values());
      this.options.extensions?.emitLifecycle({
        type: "session_shutdown",
        sessionId: this._sessionId,
      });
      await Promise.allSettled([
        Promise.resolve().then(() => this.options.runtime?.shutdown?.()),
        Promise.resolve().then(() => this.options.extensions?.shutdown()),
      ]);
      this.resolveIdleIfDone();
    })();
    return this.shutdownPromise;
  }

  abort(): void {
    this.controller.abort();
  }

  // Running calls that can move to the background, by tool-call id.
  get backgroundableCalls(): string[] {
    return [...this.backgroundCalls.keys()];
  }

  // Asks each running backgroundable call (all of them without ids) to hand its work
  // to the background; their calls return at once. Returns the ids asked.
  backgroundToolCalls(ids?: readonly string[]): string[] {
    const asked: string[] = [];
    for (const [id, controller] of this.backgroundCalls) {
      if (ids && !ids.includes(id)) continue;
      if (controller.signal.aborted) continue;
      controller.abort();
      asked.push(id);
    }
    return asked;
  }

  // Requests compaction before the next LLM call. Kept for SDK callers that
  // deliberately want deferred compaction; interactive /compact uses
  // compactNow() so the command has immediate, inspectable semantics.
  requestCompaction(focus?: string): void {
    this.compactRequested = true;
    this.compactRequestedFocus = focus?.trim() || undefined;
  }

  // Runs /compact as a real standalone operation. If a normal turn owns the
  // agent, queue it behind that turn so compaction never races session writes
  // or treats user input as summarizer steering.
  compactNow(focus?: string): Promise<ManualCompactionResult> {
    const normalizedFocus = focus?.trim() || undefined;
    if (this.stopping) {
      return Promise.resolve({
        status: "failed",
        message: "Compaction is unavailable after stop.",
      });
    }
    if (this.running) {
      this.manualCompactionQueued = true;
      this.queuedManualCompactionFocus = normalizedFocus;
      return Promise.resolve({
        status: "queued",
        message: "Compaction queued — it will run after the current turn.",
      });
    }

    this.running = true;
    this.compacting = true;
    this.controller = new AbortController();
    const publish = (event: AgentEvent) => {
      this.publishToSubscribers(event);
      if (event.type === "agent_start" && !this.sessionStarted) {
        this.sessionStarted = true;
        this.options.extensions?.emitLifecycle({
          type: "session_start",
          sessionId: this._sessionId,
        });
      }
      this.options.extensions?.emit(event);
    };
    this.activeEmit = publish;
    const execution = this.executeManualCompaction(normalizedFocus, publish).finally(() => {
      this.running = false;
      this.compacting = false;
      this.activeEmit = undefined;
      this.activeExecution = undefined;
      if (this.manualCompactionQueued && !this.stopping) this.scheduleManualCompaction();
      else if (this.followUps.length > 0 && !this.stopping) this.scheduleAutonomousRun();
      this.resolveIdleIfDone();
    });
    this.activeExecution = execution;
    return execution;
  }

  private async executeManualCompaction(
    focus: string | undefined,
    emit: (event: AgentEvent) => void,
  ): Promise<ManualCompactionResult> {
    emit({ type: "agent_start" });
    const original = this.tree.messagesAt();
    const tokensBefore = contextState(
      this.model,
      original,
      this.lastContextUsage?.usage,
      this.lastContextUsage?.estimatedTokensAtUsage,
    ).tokens;
    emit({
      type: "compaction_start",
      layer: 2,
      trigger: "manual",
      contextTokensBefore: tokensBefore,
    });

    const micro = microcompact(original, {
      imageRetentionTurns: this.options.imageRetentionTurns ?? 3,
      imageBudgetTokens:
        this.options.imageBudgetTokens ?? Math.floor(this.model.contextWindow * 0.1),
      targetTokens: Math.floor(
        this.model.contextWindow * (this.options.compactThreshold ?? AUTO_COMPACT_THRESHOLD) * 0.8,
      ),
    });
    let working = original;
    let replacements: { entryId: string; message: AgentMessage }[] = [];
    if (micro.evicted > 0) {
      emit({
        type: "compaction_update",
        layer: 2,
        stage: "clearing-tool-output",
        toolResultsCleared: micro.evicted,
      });
      replacements = micro.messages.flatMap((message, index) => {
        const prior = original[index];
        if (!prior || message === prior) return [];
        const entryId = this.tree.entryIdForMessage(prior);
        return entryId ? [{ entryId, message }] : [];
      });
      const changedCount = micro.messages.filter(
        (message, index) => message !== original[index],
      ).length;
      if (replacements.length === changedCount) working = micro.messages;
      else replacements = [];
    }

    const compactor = this.compactorOverride ?? { model: this.model, provider: this.provider };
    this.compactorOverride = undefined;
    emit({ type: "compaction_update", layer: 2, stage: "summarizing" });
    let compactionUsage: Usage | undefined;
    let usageRecorded = false;
    try {
      const credentialResolver = this.options.getCredentials;
      const result = await compactContext(working, {
        provider: compactor.provider,
        model: compactor.model,
        contextTokens: this.compactionContextTokens(this.model),
        canContinue: (usage) => !this.budgetBreach(addUsage(this.totals, usage)),
        keepRecentTokens: Math.min(
          DEFAULT_KEEP_RECENT_TOKENS,
          Math.max(2, Math.floor(this.model.contextWindow * 0.2)),
        ),
        ...(focus ? { customInstructions: focus } : {}),
        ...(this.options.carryoverExtractor
          ? { carryoverExtractor: this.options.carryoverExtractor }
          : {}),
        signal: this.controller.signal,
        onProgress: (progress) =>
          emit({ type: "compaction_update", layer: 2, stage: "summarizing", progress }),
        streamOpts: {
          sessionId: this._sessionId,
          ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
          ...(credentialResolver
            ? { getCredentials: () => credentialResolver(compactor.model.provider) }
            : {}),
        },
      });
      compactionUsage = result.usage;
      if (result.summary.length === 0) {
        const tokensAfter = estimateTokens(original);
        emit({
          type: "compaction_end",
          layer: 2,
          trigger: "manual",
          status: "noop",
          tokensFreed: 0,
          contextTokensBefore: tokensBefore,
          contextTokensAfter: tokensAfter,
        });
        emit({ type: "agent_end", messages: original, reason: "done" });
        return {
          status: "noop",
          message: "Context is already compact enough — no changes made.",
          tokensBefore,
          tokensAfter,
          tokensFreed: 0,
        };
      }

      emit({ type: "compaction_update", layer: 2, stage: "installing" });
      for (const replacement of result.replacements ?? []) {
        const index = working.indexOf(replacement.original);
        const originalMessage = index < 0 ? replacement.original : original[index];
        const entryId = originalMessage ? this.tree.entryIdForMessage(originalMessage) : undefined;
        if (!entryId) throw new Error("Compaction observation could not be mapped to the session");
        replacements.push({ entryId, message: replacement.message });
      }
      const preservedEntryIds = (result.preservedMessages ?? []).map((message) => {
        const index = working.indexOf(message);
        const entryId = this.tree.entryIdForMessage(
          index < 0 ? message : (original[index] ?? message),
        );
        if (!entryId) throw new Error("Protected context could not be mapped to the session");
        return entryId;
      });
      const compacted = applyCompaction(result);
      const firstKept = result.keptMessages[0];
      let firstKeptEntryId: string | null = null;
      if (firstKept) {
        const source =
          result.replacements?.find((replacement) => replacement.message === firstKept)?.original ??
          firstKept;
        const workingIndex = working.indexOf(source);
        const originalMessage = workingIndex === -1 ? firstKept : original[workingIndex];
        const mapped = originalMessage ? this.tree.entryIdForMessage(originalMessage) : undefined;
        if (!mapped) throw new Error("Compaction tail could not be mapped to the session");
        firstKeptEntryId = mapped;
      }
      const summaryMessage = compacted[0];
      const refreshed =
        (await this.options.refreshContext?.(compacted, {
          sessionId: this._sessionId,
        })) ?? [];
      if (this.options.extensions) {
        refreshed.push(
          ...(await this.options.extensions.runContextProviders([...compacted, ...refreshed], {
            sessionId: this._sessionId,
          })),
        );
      }
      const tokensAfterSummary = estimateTokens([...compacted, ...refreshed]);
      const candidateTree = SessionTree.fromJsonl(this.tree.toJsonl());
      if (replacements.length > 0) {
        candidateTree.append({ type: "microcompaction", replacements });
      }
      const windowNumber =
        candidateTree.activePath().filter((entry) => entry.type === "compaction").length + 1;
      const boundary = candidateTree.append({
        type: "compaction",
        summary: result.summary,
        ...(result.carryover !== undefined ? { carryover: result.carryover } : {}),
        firstKeptEntryId,
        preservedEntryIds,
        ...(summaryMessage ? { timestamp: summaryMessage.timestamp } : {}),
        trigger: "manual",
        contextTokensBefore: tokensBefore,
        contextTokensAfter: tokensAfterSummary,
        model: this.modelRef,
        compactorModel: `${compactor.model.provider}/${compactor.model.id}`,
        windowNumber,
        strategy: "summary-tail",
        keptTokens: estimateTokens(result.keptMessages),
        toolResultsCleared: replacements.length,
        usage: result.usage,
      });

      for (const message of refreshed) candidateTree.appendMessage(message);
      const visible = candidateTree.messagesAt();
      const tokensAfter = estimateTokens(visible);
      const tokensFreed = Math.max(0, tokensBefore - tokensAfter);
      await this.store.save(this._sessionId, candidateTree);
      this.tree = candidateTree;
      this.totals = addUsage(this.totals, result.usage);
      usageRecorded = true;
      this.lastContextUsage = undefined;
      this.lastContextPercent =
        this.model.contextWindow > 0 ? tokensAfter / this.model.contextWindow : 0;
      this.lastContextTokens = tokensAfter;
      emit({
        type: "usage_updated",
        sessionTotals: this.totals,
        contextTokens: tokensAfter,
        contextPercent: this.lastContextPercent,
      });
      emit({
        type: "compaction_end",
        layer: 2,
        trigger: "manual",
        status: "completed",
        tokensFreed,
        summaryEntryId: boundary.id,
        contextTokensBefore: tokensBefore,
        contextTokensAfter: tokensAfter,
        toolResultsCleared: replacements.length,
        keptTokens: estimateTokens(result.keptMessages),
      });
      emit({ type: "agent_end", messages: visible, reason: "done" });
      return {
        status: "completed",
        message: `Context compacted: ${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens (${tokensFreed.toLocaleString()} freed).`,
        tokensBefore,
        tokensAfter,
        tokensFreed,
        toolResultsCleared: replacements.length,
        summaryEntryId: boundary.id,
      };
    } catch (error) {
      const failedUsage =
        compactionUsage ?? (error instanceof CompactionError ? error.usage : undefined);
      if (failedUsage && !usageRecorded) {
        this.tree.append({
          type: "compaction-attempt",
          status: this.controller.signal.aborted ? "cancelled" : "failed",
          trigger: "manual",
          model: this.modelRef,
          compactorModel: `${compactor.model.provider}/${compactor.model.id}`,
          timestamp: Date.now(),
          usage: failedUsage,
        });
        await this.store.save(this._sessionId, this.tree).catch(() => {});
        this.totals = addUsage(this.totals, failedUsage);
        emit({
          type: "usage_updated",
          sessionTotals: this.totals,
          contextTokens: tokensBefore,
          contextPercent:
            this.model.contextWindow > 0 ? tokensBefore / this.model.contextWindow : 0,
        });
      }
      const cancelled = this.controller.signal.aborted;
      const message = cancelled
        ? "Compaction cancelled — original conversation preserved."
        : `Compaction failed: ${error instanceof Error ? error.message : String(error)} Original conversation preserved.`;
      emit({
        type: "compaction_end",
        layer: 2,
        trigger: "manual",
        status: cancelled ? "cancelled" : "failed",
        tokensFreed: 0,
        contextTokensBefore: tokensBefore,
        contextTokensAfter: tokensBefore,
        errorMessage: message,
      });
      emit({ type: "agent_end", messages: original, reason: cancelled ? "aborted" : "done" });
      return {
        status: cancelled ? "cancelled" : "failed",
        message,
        tokensBefore,
        tokensAfter: tokensBefore,
        tokensFreed: 0,
      };
    }
  }

  get checkpointHistory(): CheckpointHistory {
    return this.checkpoints;
  }

  undoPoints(): UndoPoint[] {
    return this.checkpoints
      .state()
      .done.toReversed()
      .map((step, index) => {
        const details = this.checkpointDetails(step);
        return {
          steps: index + 1,
          prompt: details.prompt ?? "",
          messageCount: details.messageCount,
        };
      });
  }

  // Undo restores the workspace AND rewinds the conversation together — either
  // alone would leave the session lying about its own state.
  async undo(turnCount = 1): Promise<CheckpointActionResult> {
    if (this.running) return { ok: false, message: "Cannot undo while a run is active." };
    const busy = this.backgroundBlocker("undo");
    if (busy) return { ok: false, message: busy };
    const provider = this.options.checkpointProvider;
    if (!provider) {
      return {
        ok: false,
        message: this.options.checkpointUnavailable ?? "This profile does not support undo.",
      };
    }
    if (!Number.isInteger(turnCount) || turnCount < 1) {
      return { ok: false, message: "Undo count must be a positive whole number." };
    }
    const state = this.checkpoints.state();
    if (state.done.length === 0) return { ok: false, message: "Nothing to undo." };
    if (turnCount > state.done.length) {
      return {
        ok: false,
        message: `Only ${state.done.length} prompt${state.done.length === 1 ? "" : "s"} can be undone.`,
      };
    }
    const selected = state.done.slice(-turnCount);
    const step = selected[0] as CheckpointEntry;
    if (!this.tree.has(step.beforeEntryId)) {
      return { ok: false, message: "Could not undo: the conversation checkpoint is missing." };
    }

    // Declared coverage records a resource only in turns that change it, so
    // each one is restored from the earliest selected turn that does.
    const declared = provider.coverage === "declared";
    const filesByPath = new Map<string, CheckpointDiffFile>();
    const sources = new Map<string, CheckpointDiffFile[]>();
    try {
      for (const selectedStep of selected) {
        const source = declared ? selectedStep.beforeRef : step.beforeRef;
        for (const file of await provider.diff(selectedStep.beforeRef, selectedStep.afterRef)) {
          const existing = filesByPath.get(file.path);
          if (existing) {
            existing.added += file.added;
            existing.removed += file.removed;
            existing.hunks.push(...file.hunks);
          } else {
            const merged = { ...file, hunks: [...file.hunks] };
            filesByPath.set(file.path, merged);
            const group = sources.get(source);
            if (group) group.push(merged);
            else sources.set(source, [merged]);
          }
        }
      }
    } catch (error) {
      return {
        ok: false,
        message: `Could not undo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const files = [...filesByPath.values()];

    let rollbackRef: string | undefined;
    try {
      rollbackRef = await this.captureCurrent(
        provider,
        (selected.at(-1) as CheckpointEntry).afterRef,
        files,
        turnCount === 1 ? "before undo of last turn" : `before undo of ${turnCount} turns`,
      );
    } catch (error) {
      return {
        ok: false,
        message: `Could not undo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!rollbackRef)
      return { ok: false, message: "Could not undo: failed to capture current state." };

    try {
      for (const [source, sourceFiles] of sources) {
        await this.restoreCheckpointResources(provider, source, sourceFiles);
      }
    } catch (error) {
      const rollbackError = await this.restoreCheckpointResources(provider, rollbackRef, files)
        .then(() => undefined)
        .catch((cause: unknown) => cause);
      return {
        ok: false,
        message: `Could not undo: ${error instanceof Error ? error.message : String(error)}${
          rollbackError
            ? `; rollback failed: ${
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
              }`
            : ""
        }`,
      };
    }

    const current = this.tree;
    const candidate = SessionTree.fromJsonl(current.toJsonl());
    candidate.fork(step.beforeEntryId);
    const nextDone = state.done.slice(0, -turnCount);
    const newlyUndone = selected
      .toReversed()
      .map((entry, index) => (index === 0 ? { ...entry, redoRef: rollbackRef } : entry));
    const nextUndone = [...state.undone, ...newlyUndone];
    this.appendCheckpointCursor(candidate, nextDone, nextUndone);

    try {
      await this.store.save(this._sessionId, candidate);
    } catch (error) {
      await this.restoreCheckpointResources(provider, rollbackRef, files).catch(() => {});
      await this.store.save(this._sessionId, current).catch(() => {});
      return {
        ok: false,
        message: `Could not undo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const details = selected.map((entry) => this.checkpointDetails(entry));
    const prompt = details[0]?.prompt;
    this.checkpoints.restore(nextDone, nextUndone);
    this.tree = candidate;
    this.refreshContextAccounting();
    return {
      ok: true,
      message: turnCount === 1 ? "Undid the last turn." : `Undid the last ${turnCount} turns.`,
      data: {
        kind: "checkpoint",
        action: "undo",
        files,
        turnCount,
        messageCount: details.reduce((total, detail) => total + detail.messageCount, 0),
        ...(prompt !== undefined ? { prompt } : {}),
      },
    };
  }

  async redo(): Promise<CheckpointActionResult> {
    if (this.running) return { ok: false, message: "Cannot redo while a run is active." };
    const busy = this.backgroundBlocker("redo");
    if (busy) return { ok: false, message: busy };
    const provider = this.options.checkpointProvider;
    if (!provider) {
      return {
        ok: false,
        message: this.options.checkpointUnavailable ?? "This profile does not support redo.",
      };
    }
    const step = this.checkpoints.peekRedo();
    if (!step) return { ok: false, message: "Nothing to redo." };
    if (!this.tree.has(step.id)) {
      return { ok: false, message: "Could not redo: the conversation checkpoint is missing." };
    }

    let files: CheckpointDiffFile[];
    try {
      files = await provider.diff(step.beforeRef, step.afterRef);
    } catch (error) {
      return {
        ok: false,
        message: `Could not redo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let rollbackRef: string | undefined;
    try {
      rollbackRef = await this.captureCurrent(
        provider,
        step.afterRef,
        files,
        "before redo of last turn",
      );
    } catch (error) {
      return {
        ok: false,
        message: `Could not redo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!rollbackRef)
      return { ok: false, message: "Could not redo: failed to capture current state." };

    try {
      await this.restoreCheckpointResources(provider, step.redoRef ?? step.afterRef, files);
    } catch (error) {
      const rollbackError = await this.restoreCheckpointResources(provider, rollbackRef, files)
        .then(() => undefined)
        .catch((cause: unknown) => cause);
      return {
        ok: false,
        message: `Could not redo: ${error instanceof Error ? error.message : String(error)}${
          rollbackError
            ? `; rollback failed: ${
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
              }`
            : ""
        }`,
      };
    }

    const current = this.tree;
    const candidate = SessionTree.fromJsonl(current.toJsonl());
    candidate.fork(step.id);
    const state = this.checkpoints.state();
    const { redoRef: _redoRef, ...redone } = step;
    const nextDone = [...state.done, redone];
    const nextUndone = state.undone.slice(0, -1);
    this.appendCheckpointCursor(candidate, nextDone, nextUndone);

    try {
      await this.store.save(this._sessionId, candidate);
    } catch (error) {
      await this.restoreCheckpointResources(provider, rollbackRef, files).catch(() => {});
      await this.store.save(this._sessionId, current).catch(() => {});
      return {
        ok: false,
        message: `Could not redo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const details = this.checkpointDetails(step);
    this.checkpoints.restore(nextDone, nextUndone);
    this.tree = candidate;
    this.refreshContextAccounting();
    return {
      ok: true,
      message: "Redid the turn.",
      data: {
        kind: "checkpoint",
        action: "redo",
        files,
        turnCount: 1,
        messageCount: details.messageCount,
      },
    };
  }

  // Aggregate diff for the session: first checkpoint → now. With declared
  // coverage, each resource from before the first turn that changed it to
  // after the last one.
  async sessionDiff(): Promise<Awaited<ReturnType<CheckpointProvider["diff"]>>> {
    const provider = this.options.checkpointProvider;
    const first = this.checkpoints.first();
    if (!provider || !first) return [];
    if (provider.coverage !== "declared") return provider.diff(first.beforeRef);
    const spans = new Map<string, { from: string; to: string }>();
    for (const step of this.checkpoints.all()) {
      for (const file of await provider.diff(step.beforeRef, step.afterRef)) {
        spans.set(file.path, {
          from: spans.get(file.path)?.from ?? step.beforeRef,
          to: step.afterRef,
        });
      }
    }
    const pairs = new Map<string, { from: string; to: string; paths: Set<string> }>();
    for (const [path, { from, to }] of spans) {
      const key = `${from}\0${to}`;
      const pair = pairs.get(key) ?? { from, to, paths: new Set<string>() };
      pair.paths.add(path);
      pairs.set(key, pair);
    }
    const files: CheckpointDiffFile[] = [];
    for (const { from, to, paths } of pairs.values()) {
      files.push(...(await provider.diff(from, to)).filter((file) => paths.has(file.path)));
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  forkPoints(): { id: string; description: string }[] {
    const points: { id: string; description: string }[] = [];
    for (const entry of this.tree.activePath()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "toolResult") continue;
      if (
        message.role === "assistant" &&
        message.content.some((block) => block.type === "toolCall")
      ) {
        continue;
      }
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      const role = message.role === "assistant" ? "mu" : message.role;
      points.push({
        id: entry.id,
        description: `${role} · ${text.slice(0, 80) || "(no text)"}`,
      });
    }
    return points;
  }

  async fork(entryId: string): Promise<{ ok: boolean; message: string }> {
    if (this.running) return { ok: false, message: "Cannot fork while a run is active." };
    const busy = this.backgroundBlocker("fork");
    if (busy) return { ok: false, message: busy };
    if (!this.tree.get(entryId)) {
      return { ok: false, message: `Could not fork: unknown entry ${entryId}.` };
    }
    const candidate = SessionTree.fromJsonl(this.tree.toJsonl());
    candidate.fork(entryId);
    candidate.append({
      type: "custom",
      customType: "fork",
      data: { fromEntryId: this.tree.head, targetEntryId: entryId },
    });
    try {
      await this.store.save(this._sessionId, candidate);
    } catch (error) {
      return {
        ok: false,
        message: `Could not fork: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.tree = candidate;
    this.rebuildCheckpointHistory();
    this.refreshContextAccounting();
    return { ok: true, message: `Forked from ${entryId}.` };
  }

  get contextPercent(): number {
    return this.lastContextPercent;
  }

  get contextTokens(): number {
    return this.lastContextTokens;
  }

  async run<T>(
    prompt: string | UserContent[],
    opts: AgentRunOptions<T> & { output: z.ZodType<T> },
  ): Promise<RunResult & { output: T }>;
  async run(prompt: string | UserContent[], opts?: AgentRunOptions): Promise<RunResult>;
  async run<T>(
    prompt: string | UserContent[],
    opts?: AgentRunOptions<T>,
  ): Promise<RunResult | (RunResult & { output: T })> {
    return this.execute(prompt, opts, () => {});
  }

  // Streams events as they happen; the returned iterable also exposes result().
  stream(
    prompt: string | UserContent[],
    opts?: AgentRunOptions,
  ): AsyncIterable<AgentEvent> & { result(): Promise<RunResult> } {
    const queue: AgentEvent[] = [];
    const waiters: ((value: IteratorResult<AgentEvent>) => void)[] = [];
    let done = false;

    const push = (event: AgentEvent) => {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else queue.push(event);
    };

    const finished = this.execute(prompt, opts, push).finally(() => {
      done = true;
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined as never, done: true });
      }
    });

    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length > 0) {
            yield queue.shift() as AgentEvent;
            continue;
          }
          if (done) return;
          const next = await new Promise<IteratorResult<AgentEvent>>((resolve) =>
            waiters.push(resolve),
          );
          if (next.done) return;
          yield next.value;
        }
      },
      result: () => finished,
    };
  }

  // Only this capture is cancellable: the after-turn capture must still run for
  // an aborted turn, or its partial changes could not be undone.
  private async beginCheckpoint(beforeEntryId: string | null, signal: AbortSignal): Promise<void> {
    const provider = this.options.checkpointProvider;
    this.pendingCheckpoint = undefined;
    if (!provider) return;
    try {
      // Declared coverage records each resource just before it first changes,
      // on top of the latest checkpoint.
      const ref =
        provider.coverage === "declared"
          ? await provider.snapshotResources?.(undefined, [], "before user turn")
          : await provider.snapshot("before user turn", signal);
      if (ref) {
        this.pendingCheckpoint = {
          beforeEntryId,
          beforeRef: ref,
        };
      }
    } catch {}
  }

  private async finishCheckpoint(changes: TurnChanges): Promise<void> {
    const pending = this.pendingCheckpoint;
    const provider = this.options.checkpointProvider;
    this.pendingCheckpoint = undefined;
    if (!pending || !provider) return;

    await changes.capture;
    const declared = provider.coverage === "declared";
    // Without undeclared changes or background work, the turn changed at most
    // the resources its tools named. Declared coverage cannot record the rest.
    const known =
      declared || (!changes.unknown && this.runningTasks.size === 0 && this.background.size === 0);
    const resources = [...changes.resources].filter(
      (resource) => !changes.uncaptured.has(resource),
    );
    let afterRef: string | undefined;
    if (known && resources.length === 0) afterRef = pending.beforeRef;
    else if (known && provider.snapshotResources) {
      afterRef = await provider
        .snapshotResources(pending.beforeRef, resources, "after user turn")
        .catch(() => undefined);
    }
    if (!declared) afterRef ??= await provider.snapshot("after user turn").catch(() => undefined);
    if (!afterRef) return;
    const entry = this.tree.append({
      type: "checkpoint",
      beforeEntryId: pending.beforeEntryId,
      checkpointRef: pending.beforeRef,
      checkpointAfterRef: afterRef,
      label: "turn",
    });
    const checkpoint = {
      id: entry.id,
      beforeEntryId: pending.beforeEntryId,
      beforeRef: pending.beforeRef,
      afterRef,
      label: "turn",
    };
    this.checkpoints.record(checkpoint);
    const state = this.checkpoints.state();
    this.appendCheckpointCursor(this.tree, state.done, state.undone);
  }

  private appendCheckpointCursor(
    tree: SessionTree,
    done: CheckpointEntry[],
    undone: CheckpointEntry[],
  ): void {
    const encode = (entry: CheckpointEntry) => ({
      id: entry.id,
      ...(entry.redoRef ? { redoRef: entry.redoRef } : {}),
    });
    tree.append({
      type: "custom",
      customType: "checkpoint-cursor",
      data: {
        done: done.map(encode),
        undone: undone.map(encode),
      },
    });
  }

  // The exact current state of `files`, for redo and rollback. Declared
  // coverage records only those; a full snapshot records everything.
  private async captureCurrent(
    provider: CheckpointProvider,
    baseRef: string,
    files: CheckpointDiffFile[],
    label: string,
  ): Promise<string | undefined> {
    if (provider.coverage !== "declared") return provider.snapshot(label);
    return provider.snapshotResources?.(
      baseRef,
      files.map((file) => file.path),
      label,
    );
  }

  private async restoreCheckpointResources(
    provider: CheckpointProvider,
    ref: string,
    files: CheckpointDiffFile[],
  ): Promise<void> {
    if (files.length === 0) return;
    const resources = files.map((file) => file.path);
    if (provider.restoreResources) {
      await provider.restoreResources(ref, resources);
      return;
    }
    await provider.restore(ref);
  }

  private checkpointDetails(step: CheckpointEntry): {
    messageCount: number;
    prompt?: string;
  } {
    const path = this.tree.pathTo(step.id);
    const boundary = step.beforeEntryId
      ? path.findIndex((entry) => entry.id === step.beforeEntryId)
      : -1;
    const entries = path.slice(boundary + 1);
    const firstUser = entries.find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    const prompt =
      firstUser?.type === "message"
        ? firstUser.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
        : undefined;
    return {
      messageCount: entries.filter((entry) => entry.type === "message").length,
      ...(prompt !== undefined ? { prompt } : {}),
    };
  }

  private rebuildCheckpointHistory(): void {
    const all = new Map<string, CheckpointEntry>();
    for (const entry of this.tree.all()) {
      if (entry.type !== "checkpoint") continue;
      all.set(entry.id, {
        id: entry.id,
        beforeEntryId: entry.beforeEntryId,
        beforeRef: entry.checkpointRef,
        afterRef: entry.checkpointAfterRef,
        ...(entry.label ? { label: entry.label } : {}),
      });
    }

    const active = this.tree.activePath();
    const cursorIndex = active.findLastIndex(
      (entry) => entry.type === "custom" && entry.customType === "checkpoint-cursor",
    );
    const cursor = cursorIndex === -1 ? undefined : active[cursorIndex];
    if (cursor?.type === "custom") {
      const data = cursor.data as { done?: unknown; undone?: unknown };
      const resolve = (value: unknown): CheckpointEntry[] =>
        Array.isArray(value)
          ? value
              .map((item) => {
                const id =
                  typeof item === "string"
                    ? item
                    : typeof item === "object" &&
                        item !== null &&
                        typeof (item as { id?: unknown }).id === "string"
                      ? (item as { id: string }).id
                      : undefined;
                const entry = id ? all.get(id) : undefined;
                if (!entry) return undefined;
                const redoRef =
                  typeof item === "object" &&
                  item !== null &&
                  typeof (item as { redoRef?: unknown }).redoRef === "string"
                    ? (item as { redoRef: string }).redoRef
                    : undefined;
                return { ...entry, ...(redoRef ? { redoRef } : {}) };
              })
              .filter((entry): entry is CheckpointEntry => entry !== undefined)
          : [];
      const done = resolve(data.done);
      let undone = resolve(data.undone);
      for (const entry of active.slice(cursorIndex + 1)) {
        if (entry.type !== "checkpoint") continue;
        const checkpoint = all.get(entry.id);
        if (checkpoint) done.push(checkpoint);
        undone = [];
      }
      this.checkpoints.restore(done, undone);
      return;
    }

    this.checkpoints.restore(
      active
        .filter((entry) => entry.type === "checkpoint")
        .map((entry) => all.get(entry.id))
        .filter((entry): entry is CheckpointEntry => entry !== undefined),
    );
  }

  private execute<T>(
    prompt: string | UserContent[] | AgentMessage,
    opts: AgentRunOptions<T> | undefined,
    emit: (event: AgentEvent) => void,
  ): Promise<RunResult & { output?: T }> {
    if (this.stopping) {
      return Promise.reject(new Error("Agent has been stopped."));
    }
    if (this.running) {
      return Promise.reject(new Error("Agent already has an active run; use send() to steer it."));
    }
    this.running = true;
    // The loop ends before the after-turn checkpoint and session save, so its
    // agent_end waits until the run is truly over: whoever reacts to it (undo,
    // /diff, a new prompt) must find the agent idle and the turn recorded.
    let heldEnd: AgentEvent | undefined;
    const publish = (event: AgentEvent) => {
      if (event.type === "agent_end" && this.running) {
        heldEnd = event;
        return;
      }
      emit(event);
      this.publishToSubscribers(event);
      if (event.type === "agent_start" && !this.sessionStarted) {
        this.sessionStarted = true;
        this.options.extensions?.emitLifecycle({
          type: "session_start",
          sessionId: this._sessionId,
        });
      }
      this.options.extensions?.emit(event);
    };
    this.activeEmit = publish;
    const execution = this.executeRun(prompt, opts, publish).finally(() => {
      this.running = false;
      this.activeEmit = undefined;
      this.activeExecution = undefined;
      if (heldEnd) publish(heldEnd);
      if (this.manualCompactionQueued && !this.stopping) this.scheduleManualCompaction();
      else if (this.followUps.length > 0 && !this.stopping) this.scheduleAutonomousRun();
      this.resolveIdleIfDone();
    });
    this.activeExecution = execution;
    return execution;
  }

  private async executeRun<T>(
    prompt: string | UserContent[] | AgentMessage,
    opts: AgentRunOptions<T> | undefined,
    emit: (event: AgentEvent) => void,
  ): Promise<RunResult & { output?: T }> {
    this.controller = new AbortController();
    // Reactive recovery is "retry once per overflow", not once per Agent: a
    // long session must still be able to recover hours later.
    this.recoveryAttempted = false;
    this.reactiveRecoveryPending = false;

    const host = this.options.extensions;
    let effectivePrompt = prompt;
    if (typeof prompt === "string" && host) {
      host.emitLifecycle({ type: "input", text: prompt });
      const directive = await host.runInputHooks(prompt);
      if (directive?.consume) {
        if (opts?.output) {
          throw new Error(
            "Structured output is unavailable because an extension consumed the input.",
          );
        }
        const events: AgentEvent[] = [
          { type: "agent_start" },
          { type: "agent_end", messages: [], reason: "done" },
        ];
        for (const event of events) emit(event);
        return {
          text: "",
          messages: [],
          usage: this.totals,
          reason: "done",
          sessionId: this._sessionId,
        };
      }
      if (directive?.text !== undefined) effectivePrompt = directive.text;
    }

    const promptMessage: AgentMessage =
      typeof effectivePrompt === "string"
        ? userMessage(effectivePrompt)
        : Array.isArray(effectivePrompt)
          ? { role: "user", content: effectivePrompt, timestamp: Date.now() }
          : effectivePrompt;

    let captured: T | undefined;
    let reminders = 0;
    let tools: AnyTool[] = [
      ...(this.options.tools ?? []),
      ...(host ? [...host.tools.values()] : []),
    ];
    const runModel = opts?.model ? resolveModel(opts.model, this.options.extensions) : this.model;
    const runProvider = opts?.model ? this.providerFor(runModel) : this.provider;
    const webSearch = resolveWebSearchBackend(runProvider);
    if (opts?.allowedTools) {
      const available = new Set(tools.map((tool) => tool.name));
      if (webSearch.kind === "hosted") available.add("web_search");
      const unknown = opts.allowedTools.filter((name) => !available.has(name));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown allowed tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
        );
      }
      const allowed = new Set(opts.allowedTools);
      tools = tools.filter((tool) => allowed.has(tool.name));
    }
    const runThinking = thinkingLevelForModel(runModel, this.currentThinking);
    const requestedThinking = this.requestedThinking;
    const runModelRef = `${runModel.provider}/${runModel.id}`;
    const noticeKey = `${runModelRef} ${requestedThinking}`;
    const thinkingNotice: AgentEvent | undefined =
      requestedThinking !== undefined &&
      requestedThinking !== runThinking &&
      !this.thinkingNotices.has(noticeKey)
        ? {
            type: "thinking_adjusted",
            model: runModelRef,
            requested: requestedThinking,
            level: runThinking,
            ...(runModel.inferred ? { inferredModel: true } : {}),
          }
        : undefined;
    if (thinkingNotice) this.thinkingNotices.add(noticeKey);
    let runContextUsage = opts?.model ? undefined : this.lastContextUsage;
    if (opts?.model) this.lastContextUsage = undefined;
    const systemPrompt = resolveSystemPrompt(this.options.systemPrompt);

    if (opts?.output) {
      tools.push(
        structuredOutputTool(opts.output, (value) => {
          captured = value as T;
        }),
      );
      systemPrompt.push({ text: structuredOutputPrompt(), dynamic: true });
    }

    const seeded = this.tree.messagesAt();
    const initial =
      seeded.length === 0 && this.options.initialMessages ? this.options.initialMessages : [];
    for (const message of initial) this.tree.appendMessage(message);
    const refreshed =
      (await this.options.refreshContext?.([...seeded, ...initial], {
        sessionId: this._sessionId,
      })) ?? [];
    if (host) {
      refreshed.push(
        ...(await host.runContextProviders([...seeded, ...initial, ...refreshed], {
          sessionId: this._sessionId,
        })),
      );
    }
    for (const message of refreshed) this.tree.appendMessage(message);

    const context: AgentContext = {
      systemPrompt,
      messages: [...seeded, ...initial, ...refreshed],
      ...(tools.length > 0 ? { tools } : {}),
      ...(webSearch.kind === "hosted" &&
      (!opts?.allowedTools || opts.allowedTools.includes("web_search"))
        ? { hostedTools: [webSearch.tool] }
        : {}),
    };
    // Nothing changes state before a tool runs, so the capture overlaps the
    // provider request and only tool calls wait for it.
    const checkpointReady = this.beginCheckpoint(this.tree.head, this.controller.signal);

    let budgetHalt: HaltReason | undefined;

    const requestOverhead =
      estimateTextTokens(JSON.stringify(systemPrompt)) +
      estimateTextTokens(
        JSON.stringify(
          tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ),
      );
    const currentContextState = (messages: AgentMessage[]) => {
      const state = contextState(
        runModel,
        messages,
        runContextUsage?.usage,
        runContextUsage?.estimatedTokensAtUsage,
      );
      const tokens = Math.max(state.tokens, estimateTokens(messages) + requestOverhead);
      return { ...state, tokens, percent: state.limit > 0 ? tokens / state.limit : 0 };
    };

    const recordUsage = (
      usage: Usage,
      messages: AgentMessage[],
      requestMessages?: AgentMessage[],
    ): HaltReason | undefined => {
      this.totals = addUsage(this.totals, usage);
      if (requestMessages) {
        runContextUsage = {
          usage,
          estimatedTokensAtUsage: estimateTokens(requestMessages),
        };
        if (!opts?.model) this.lastContextUsage = runContextUsage;
      }
      const state = currentContextState(messages);
      this.lastContextPercent = state.percent;
      this.lastContextTokens = state.tokens;
      emit({
        type: "usage_updated",
        sessionTotals: this.totals,
        contextTokens: state.tokens,
        contextPercent: state.percent,
      });
      const breach = this.budgetBreach();
      if (breach) budgetHalt = breach;
      return breach;
    };

    const turnChanges: TurnChanges = {
      resources: new Set(),
      unknown: false,
      uncaptured: new Set(),
      capture: Promise.resolve(),
    };
    // A resource's state before its first change in the turn joins the
    // before-turn checkpoint. Taken after the permission decision, so a denied
    // call records nothing.
    const captureBeforeChange = async (resources: string[]) => {
      const provider = this.options.checkpointProvider;
      if (provider?.coverage !== "declared" || !provider.snapshotResources) return;
      const snapshotResources = provider.snapshotResources.bind(provider);
      const fresh = [...new Set(resources)].filter(
        (resource) => !turnChanges.resources.has(resource),
      );
      for (const resource of fresh) turnChanges.resources.add(resource);
      if (fresh.length === 0) return;
      turnChanges.capture = turnChanges.capture.then(async () => {
        const pending = this.pendingCheckpoint;
        const ref = pending
          ? await snapshotResources(pending.beforeRef, fresh, "before change").catch(
              () => undefined,
            )
          : undefined;
        if (pending && ref) pending.beforeRef = ref;
        // Its change would read as a creation, and undo would delete it.
        else for (const resource of fresh) turnChanges.uncaptured.add(resource);
      });
      await turnChanges.capture;
    };
    const gateToolCall = async (
      info: Parameters<NonNullable<LoopConfig["beforeToolCall"]>>[0],
    ): Promise<Awaited<ReturnType<NonNullable<LoopConfig["beforeToolCall"]>>>> => {
      // The structured-output tool is internal plumbing, never gated.
      if (info.toolCall.name === STRUCTURED_OUTPUT_TOOL) return undefined;
      await checkpointReady;

      let args = info.args;
      if (host) {
        const directive = await host.runToolCallHooks({
          toolName: info.toolCall.name,
          toolCallId: info.toolCall.id,
          args,
        });
        if (directive?.block) {
          return { block: true, reason: directive.reason ?? "Blocked by an extension" };
        }
        if (directive?.args) args = directive.args;
      }

      const selectedTool = tools.find((tool) => tool.name === info.toolCall.name);
      let permission = info.toolCall.name;
      try {
        permission = selectedTool?.permissionScope?.(args) ?? permission;
      } catch {
        // A broken profile classifier must fall back to the concrete tool.
      }
      let pattern = JSON.stringify(args);
      try {
        pattern = selectedTool?.permissionPattern?.(args) ?? pattern;
      } catch {
        // A broken profile projection must not bypass the generic permission rules.
      }
      const permissionTargets =
        permission === info.toolCall.name ? [info.toolCall.name] : [info.toolCall.name, permission];
      const action = evaluate(this.effectivePermissionRules(), permissionTargets, pattern);
      const rewritten = args === info.args ? undefined : { rewrittenArgs: args };
      if (action === "allow") {
        return rewritten;
      }
      if (action === "deny") {
        return { block: true, reason: `Permission denied for ${info.toolCall.name}` };
      }
      const details = await Promise.resolve(selectedTool?.permissionDetails?.(args)).catch(
        () => undefined,
      );
      const request: PermissionRequest = {
        id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        toolCallId: info.toolCall.id,
        toolName: info.toolCall.name,
        permission,
        pattern,
        description: details?.description ?? `Run ${info.toolCall.name}`,
        ...(details?.preview ? { preview: details.preview } : {}),
      };
      emit({ type: "permission_asked", request });
      // Default DENY: never hang an unattended process on an unanswered ask.
      let outcome: "allow" | "deny" = "deny";
      if (this.options.onPermission && !this.controller.signal.aborted) {
        const signal = this.controller.signal;
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<"deny">((resolve) => {
          onAbort = () => resolve("deny");
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          outcome = await Promise.race([this.options.onPermission(request), aborted]);
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      }
      emit({ type: "permission_resolved", requestId: request.id, outcome });
      if (outcome === "allow") {
        return rewritten;
      }
      return {
        block: true,
        reason: `Permission denied for ${info.toolCall.name}`,
      };
    };

    const credentialResolver = this.options.getCredentials;
    const config: LoopConfig = {
      provider: runProvider,
      model: runModel,
      streamOpts: {
        sessionId: this._sessionId,
        ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
        ...(credentialResolver
          ? { getCredentials: () => credentialResolver(runModel.provider) }
          : {}),
      },
      thinkingLevel: runThinking,
      ...(this.options.budget?.maxTurns !== undefined
        ? { maxTurns: this.options.budget.maxTurns }
        : {}),
      backgroundCalls: this.backgroundCalls,
      getSteeringMessages: () => {
        const pending = this.steering;
        this.steering = [];
        return pending;
      },
      getFollowUpMessages: () => {
        const next = this.followUps.shift();
        if (next) return [next];
        // Ending with prose instead of the tool would throw away the whole run.
        if (
          opts?.output &&
          captured === undefined &&
          !this.stopping &&
          reminders < STRUCTURED_OUTPUT_REMINDERS
        ) {
          reminders++;
          return [structuredOutputReminder()];
        }
        return [];
      },
      beforeToolCall: async (info) => {
        const directive = await gateToolCall(info);
        if (!directive?.block && info.toolCall.name !== STRUCTURED_OUTPUT_TOOL) {
          const selected = tools.find((candidate) => candidate.name === info.toolCall.name);
          const args = directive?.rewrittenArgs ?? info.args;
          if (mayChangeState(selected, args)) {
            const resources = declaredResources(selected, args);
            if (!resources) turnChanges.unknown = true;
            else {
              await captureBeforeChange(resources);
              for (const resource of resources) turnChanges.resources.add(resource);
            }
          }
        }
        return directive;
      },
      prepareContext: async (messages) => {
        const prepared = (next: AgentMessage[], stop = false) => {
          if (config.streamOpts) {
            config.streamOpts.maxTokens = Math.max(
              1,
              Math.min(
                runModel.maxOutput,
                Math.floor(runModel.contextWindow * 0.95 - currentContextState(next).tokens),
              ),
            );
          }
          return { messages: next, stop };
        };
        const state = currentContextState(messages);
        this.lastContextPercent = state.percent;
        this.lastContextTokens = state.tokens;

        const auto = this.options.autoCompact !== false;

        // Cheap cleanup preserves unique evidence for the handoff. Image expiry
        // runs even below the text-pressure threshold.
        let working = messages;
        if (auto && !this.compactRequested) {
          const micro = microcompact(working, {
            imagesOnly: state.percent < MICROCOMPACT_THRESHOLD,
            ...(state.percent < MICROCOMPACT_THRESHOLD
              ? { supersedeWithinTurns: SUPERSEDE_WITHIN_TURNS }
              : {}),
            imageRetentionTurns: this.options.imageRetentionTurns ?? 3,
            imageBudgetTokens:
              this.options.imageBudgetTokens ?? Math.floor(runModel.contextWindow * 0.1),
            targetTokens: Math.floor(
              runModel.contextWindow *
                (this.options.compactThreshold ?? AUTO_COMPACT_THRESHOLD) *
                0.8,
            ),
          });
          if (micro.evicted > 0) {
            const changed = micro.messages.flatMap((message, index) => {
              const prior = working[index];
              if (!prior || message === prior) return [];
              const entryId = this.tree.entryIdForMessage(prior);
              return entryId ? [{ entryId, message }] : [];
            });
            const changedCount = micro.messages.filter(
              (message, index) => message !== working[index],
            ).length;
            // Apply only a transition we can replay exactly after resume.
            if (changed.length === changedCount) {
              emit({ type: "compaction_start", layer: 1 });
              this.tree.append({
                type: "microcompaction",
                replacements: changed,
              });
              working = micro.messages;
              runContextUsage = undefined;
              this.lastContextUsage = undefined;
              const microState = currentContextState(working);
              this.lastContextPercent = microState.percent;
              this.lastContextTokens = microState.tokens;
              emit({ type: "compaction_end", layer: 1, tokensFreed: micro.tokensFreed });
            }
          }
        }

        const after = currentContextState(working);
        const due =
          this.compactRequested ||
          (auto &&
            shouldCompact(
              after,
              Math.min(
                this.options.compactThreshold ?? AUTO_COMPACT_THRESHOLD,
                1 -
                  Math.min(runModel.maxOutput, runModel.contextWindow * 0.2) /
                    runModel.contextWindow,
              ),
            ));
        if (!due) return prepared(working);

        const trigger: CompactionTrigger = this.reactiveRecoveryPending
          ? "overflow"
          : this.compactorOverride
            ? "model-change"
            : this.compactRequested
              ? "manual"
              : "threshold";
        const focus = this.compactRequestedFocus;
        const compactor = this.compactorOverride ?? { model: runModel, provider: runProvider };
        this.compactRequested = false;
        this.compactRequestedFocus = undefined;
        this.compactorOverride = undefined;
        const layer = this.reactiveRecoveryPending ? 3 : 2;
        if (layer === 2)
          emit({
            type: "compaction_start",
            layer,
            trigger,
            contextTokensBefore: after.tokens,
          });
        let compactionUsage: Usage | undefined;
        let usageRecorded = false;
        try {
          emit({ type: "compaction_update", layer, stage: "summarizing" });
          const result = await compactContext(working, {
            provider: compactor.provider,
            model: compactor.model,
            contextTokens: this.compactionContextTokens(runModel, tools, requestOverhead),
            canContinue: (usage) => !this.budgetBreach(addUsage(this.totals, usage)),
            keepRecentTokens: Math.min(
              DEFAULT_KEEP_RECENT_TOKENS,
              Math.max(2, Math.floor(runModel.contextWindow * 0.2)),
            ),
            ...(config.streamOpts
              ? {
                  streamOpts: {
                    ...config.streamOpts,
                    ...(credentialResolver
                      ? { getCredentials: () => credentialResolver(compactor.model.provider) }
                      : {}),
                  },
                }
              : {}),
            ...(this.options.carryoverExtractor
              ? { carryoverExtractor: this.options.carryoverExtractor }
              : {}),
            ...(focus ? { customInstructions: focus } : {}),
            signal: this.controller.signal,
            onProgress: (progress) =>
              emit({ type: "compaction_update", layer, stage: "summarizing", progress }),
          });
          compactionUsage = result.usage;
          let compacted = applyCompaction(result);
          let summaryEntryId: string | undefined;

          // Record the boundary only when its exact tail can be anchored to
          // an ancestor entry. Otherwise retain the complete context.
          if (result.summary.length > 0) {
            const firstKept = result.keptMessages[0];
            let firstKeptEntryId: string | null = null;
            if (firstKept) {
              const source =
                result.replacements?.find((replacement) => replacement.message === firstKept)
                  ?.original ?? firstKept;
              const mapped = this.tree.entryIdForMessage(source);
              if (!mapped) {
                throw new Error("Compaction tail could not be mapped to the session");
              }
              firstKeptEntryId = mapped;
            }
            const preservedEntryIds = (result.preservedMessages ?? []).map((message) => {
              const id = this.tree.entryIdForMessage(message);
              if (!id) throw new Error("Protected context could not be mapped to the session");
              return id;
            });
            const replacements = (result.replacements ?? []).map(({ original, message }) => {
              const entryId = this.tree.entryIdForMessage(original);
              if (!entryId)
                throw new Error("Compaction observation could not be mapped to the session");
              return { entryId, message };
            });
            const candidateTree = SessionTree.fromJsonl(this.tree.toJsonl());
            if (replacements.length)
              candidateTree.append({ type: "microcompaction", replacements });
            const summaryMessage = compacted[0];
            const boundary = candidateTree.append({
              type: "compaction",
              summary: result.summary,
              ...(result.carryover !== undefined ? { carryover: result.carryover } : {}),
              firstKeptEntryId,
              preservedEntryIds,
              ...(summaryMessage ? { timestamp: summaryMessage.timestamp } : {}),
              trigger,
              contextTokensBefore: after.tokens,
              contextTokensAfter: estimateTokens(compacted),
              model: `${runModel.provider}/${runModel.id}`,
              compactorModel: `${compactor.model.provider}/${compactor.model.id}`,
              windowNumber:
                this.tree.activePath().filter((entry) => entry.type === "compaction").length + 1,
              strategy: "summary-tail",
              keptTokens: estimateTokens(result.keptMessages),
              usage: result.usage,
            });
            this.tree = candidateTree;
            compacted = candidateTree.messagesAt();
            summaryEntryId = boundary.id;
          }

          runContextUsage = undefined;
          this.lastContextUsage = undefined;
          recordUsage(result.usage, compacted);
          usageRecorded = true;
          emit({
            type: "compaction_end",
            layer,
            tokensFreed: result.tokensFreed,
            trigger,
            status: result.summary.length > 0 ? "completed" : "noop",
            contextTokensBefore: after.tokens,
            contextTokensAfter: currentContextState(compacted).tokens,
            keptTokens: estimateTokens(result.keptMessages),
            ...(summaryEntryId ? { summaryEntryId } : {}),
          });
          this.reactiveRecoveryPending = false;
          return prepared(compacted, budgetHalt !== undefined);
        } catch (error) {
          const failedUsage =
            compactionUsage ?? (error instanceof CompactionError ? error.usage : undefined);
          if (failedUsage && !usageRecorded) {
            this.tree.append({
              type: "compaction-attempt",
              status: this.controller.signal.aborted ? "cancelled" : "failed",
              trigger,
              model: `${runModel.provider}/${runModel.id}`,
              compactorModel: `${compactor.model.provider}/${compactor.model.id}`,
              timestamp: Date.now(),
              usage: failedUsage,
            });
            recordUsage(failedUsage, working);
          }
          // A failed summarization must not take the run down: carry on
          // uncompacted and let the provider surface any context error.
          emit({
            type: "compaction_end",
            layer,
            tokensFreed: 0,
            trigger,
            status: this.controller.signal.aborted ? "cancelled" : "failed",
            contextTokensBefore: after.tokens,
            contextTokensAfter: after.tokens,
            errorMessage:
              error instanceof Error ? error.message : "Compaction failed for an unknown reason",
          });
          this.reactiveRecoveryPending = false;
          return prepared(working, budgetHalt !== undefined);
        }
      },
      ...(host
        ? {
            transformContext: (messages: AgentMessage[]) => host.runContextHooks(messages),
          }
        : {}),
      ...(host
        ? {
            afterToolCall: async (info) => {
              const directive = await host.runToolResultHooks({
                toolName: info.toolCall.name,
                toolCallId: info.toolCall.id,
                result: info.result,
                isError: info.isError,
              });
              if (!directive) return undefined;
              return {
                ...info.result,
                ...(directive.content ? { content: directive.content } : {}),
                ...(directive.isError !== undefined ? { isError: directive.isError } : {}),
              };
            },
          }
        : {}),
      // Layer 3 — reactive recovery. The provider rejected the request for
      // being too long: compact, then let the loop try once more rather than
      // ending the run. Exactly one attempt, so a real failure still surfaces.
      recoverFromError: (message) => {
        if (this.recoveryAttempted || !isContextTooLongResult(message)) return false;
        this.recoveryAttempted = true;
        this.compactRequested = true;
        this.reactiveRecoveryPending = true;
        emit({ type: "compaction_start", layer: 3, trigger: "overflow" });
        return true;
      },
      shouldStopAfterTurn: async (turn: TurnInfo) => {
        this.recoveryAttempted = false;
        for (const result of turn.toolResults) {
          if (!result.usage) continue;
          this.totals = addUsage(this.totals, result.usage);
          this.claimChildUsage(result.usage);
        }
        // A finished child whose usage no result carried has nothing left to count.
        for (const child of this.children) if (!child.running) this.children.delete(child);
        const breach = recordUsage(turn.message.usage, turn.context.messages, turn.requestMessages);
        if (breach) {
          return true;
        }
        return false;
      },
    };

    const result = await (async () => {
      try {
        return await runLoop(
          [promptMessage],
          context,
          config,
          async (event) => {
            emit(event);
            if (event.type === "agent_start" && thinkingNotice) emit(thinkingNotice);
            if (event.type === "message_end") this.tree.appendMessage(event.message);
            // The initiating prompt is durable before the provider is called,
            // and each complete assistant/tool turn is durable before another
            // turn starts. An interrupted provider or tool call is deliberately
            // not replayed: recovery resumes from this last committed boundary.
            if (
              (event.type === "message_end" && event.message === promptMessage) ||
              event.type === "turn_end"
            ) {
              await this.store.save(this._sessionId, this.tree);
            }
          },
          this.controller.signal,
        );
      } finally {
        await checkpointReady;
        await this.finishCheckpoint(turnChanges);
      }
    })();

    await this.store.save(this._sessionId, this.tree);

    const reason: HaltReason =
      budgetHalt ?? (result.reason === "budget" ? "maxCostUsd" : (result.reason as HaltReason));

    const runResult: RunResult = {
      text: lastText(result.messages),
      messages: result.messages,
      usage: this.totals,
      reason,
      sessionId: this._sessionId,
    };
    const error = reason === "error" ? lastError(result.messages) : undefined;
    if (error) runResult.error = error;

    if (!opts?.output) return runResult;
    if (captured === undefined) {
      // Better to fail loudly than to hand back an undefined typed as T.
      const why =
        reason === "done"
          ? `the model ended without calling ${STRUCTURED_OUTPUT_TOOL} after ${reminders} reminder${reminders === 1 ? "" : "s"}`
          : `run ended: ${reason}${error ? ` — ${error}` : ""}`;
      throw new StructuredOutputError(
        `Structured output was requested but the model never produced a valid one (${why}).`,
        runResult,
      );
    }
    return { ...runResult, output: captured };
  }

  private compactionContextTokens(
    model: ModelInfo,
    tools = this.tools,
    requestOverhead?: number,
  ): number {
    const overhead =
      requestOverhead ??
      estimateTextTokens(JSON.stringify(resolveSystemPrompt(this.options.systemPrompt))) +
        estimateTextTokens(
          JSON.stringify(
            tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          ),
        );
    const response = Math.min(model.maxOutput, Math.floor(model.contextWindow * 0.2));
    return Math.max(0, Math.floor(model.contextWindow * 0.7) - overhead - response);
  }

  private providerFor(model: ModelInfo): Provider {
    return (
      this.options.provider ??
      this.options.extensions?.providers.get(model.provider) ??
      getProvider(model.provider)
    );
  }

  // Background work edits the workspace on its own schedule, so a checkpoint
  // pair cannot attribute its changes to a turn; branch moves wait for it.
  private backgroundBlocker(action: string): string | undefined {
    const labels = this.backgroundWork;
    if (labels.length === 0) return undefined;
    return `Cannot ${action} while background work is running (${labels.join(", ")}). Stop it or wait for it to finish.`;
  }

  private effectivePermissionRules(): PermissionRule[] {
    return this.inheritsPermissions && this.parentAgent
      ? this.parentAgent.effectivePermissionRules()
      : this.permissionRules;
  }

  private stopBackground(): void {
    for (const work of this.background.keys()) {
      try {
        work.stop("session");
      } catch {
        // One failing stop must not keep the others running.
      }
    }
  }

  // Children spend from the same budget, so concurrent children cannot each
  // consume the whole remainder that existed when they were created. A child
  // counts until its usage reaches these totals through a result or a charge.
  private combinedUsage(own: Usage = this.totals): Usage {
    let total = own;
    for (const child of this.children) total = addUsage(total, child.combinedUsage());
    return total;
  }

  private claimChildUsage(usage: Usage): void {
    for (const child of this.children) {
      if (!child.running && child.totals === usage) this.children.delete(child);
    }
  }

  private budgetBreach(own: Usage = this.totals): BudgetBreach | undefined {
    const combined = this.combinedUsage(own);
    return (
      checkBudget(this.options.budget, combined) ??
      this.parentAgent?.budgetBreachWithChild(this, combined)
    );
  }

  private budgetBreachWithChild(child: Agent, childUsage: Usage): BudgetBreach | undefined {
    let total = addUsage(this.totals, childUsage);
    for (const other of this.children) {
      if (other !== child) total = addUsage(total, other.combinedUsage());
    }
    return (
      checkBudget(this.options.budget, total) ??
      this.parentAgent?.budgetBreachWithChild(this, total)
    );
  }

  private async resolveChildPermission(request: PermissionRequest): Promise<"allow" | "deny"> {
    this.publishEvent({ type: "permission_asked", request });
    const outcome = this.options.onPermission
      ? await this.options.onPermission(request).catch(() => "deny" as const)
      : "deny";
    this.publishEvent({ type: "permission_resolved", requestId: request.id, outcome });
    return outcome;
  }

  private publishEvent(event: AgentEvent): void {
    if (this.activeEmit) {
      this.activeEmit(event);
      return;
    }
    this.publishToSubscribers(event);
    this.options.extensions?.emit(event);
  }

  // Active context belongs to the transcript, not to this process's activity.
  // Resuming, starting over, or moving to another window must republish it
  // instead of leaving consumers on a stale figure until the next request.
  private refreshContextAccounting(): void {
    const state = contextState(
      this.model,
      this.tree.messagesAt(),
      this.lastContextUsage?.usage,
      this.lastContextUsage?.estimatedTokensAtUsage,
    );
    this.lastContextPercent = state.percent;
    this.lastContextTokens = state.tokens;
    this.publishEvent({
      type: "usage_updated",
      sessionTotals: this.totals,
      contextTokens: state.tokens,
      contextPercent: state.percent,
    });
  }

  private publishToSubscribers(event: AgentEvent): void {
    for (const listener of this.subscribers) {
      const prior = this.subscriberQueues.get(listener) ?? Promise.resolve();
      const next = prior
        .then(() => listener(event))
        .catch(() => {
          // Observers must never be able to break an agent run.
        });
      this.subscriberQueues.set(listener, next);
      void next.finally(() => {
        if (this.subscriberQueues.get(listener) === next && !this.subscribers.has(listener)) {
          this.subscriberQueues.delete(listener);
        }
      });
    }
  }

  private scheduleAutonomousRun(): void {
    if (this.running || this.autonomousScheduled || this.stopping || this.followUps.length === 0) {
      return;
    }
    this.autonomousScheduled = true;
    queueMicrotask(() => {
      this.autonomousScheduled = false;
      if (this.running || this.stopping) {
        this.resolveIdleIfDone();
        return;
      }
      // The queued message goes through whole: a follow-up may be custom
      // context rather than a user turn, and rebuilding it from content alone
      // would silently promote it to one.
      const message = this.followUps.shift();
      if (!message) {
        this.resolveIdleIfDone();
        return;
      }
      void this.execute(message, undefined, () => {}).catch(() => {});
    });
  }

  private scheduleManualCompaction(): void {
    if (this.running || this.autonomousScheduled || this.stopping || !this.manualCompactionQueued) {
      return;
    }
    const focus = this.queuedManualCompactionFocus;
    this.manualCompactionQueued = false;
    this.queuedManualCompactionFocus = undefined;
    this.autonomousScheduled = true;
    queueMicrotask(() => {
      this.autonomousScheduled = false;
      if (this.running || this.stopping) {
        this.resolveIdleIfDone();
        return;
      }
      void this.compactNow(focus).catch(() => {});
    });
  }

  private resolveIdleIfDone(): void {
    if (
      this.running ||
      this.autonomousScheduled ||
      this.manualCompactionQueued ||
      this.followUps.length > 0
    )
      return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
