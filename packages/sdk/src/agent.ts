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
  compact as compactContext,
  contextState,
  DEFAULT_KEEP_RECENT_TOKENS,
  type EventSink,
  type ExtensionHost,
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
  shouldCompact,
  type TurnInfo,
  type UserContent,
  userMessage,
} from "@mu/core";
import type { z } from "zod";
import { type Budget, checkBudget } from "./budget.ts";
import {
  STRUCTURED_OUTPUT_TOOL,
  structuredOutputPrompt,
  structuredOutputTool,
} from "./structured-output.ts";

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
  // Snapshot/restore backing for /undo and /redo (profiles supply it).
  checkpointProvider?: CheckpointProvider;
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
}

export interface CheckpointActionData {
  kind: "checkpoint";
  action: "undo" | "redo";
  files: CheckpointDiffFile[];
  messageCount: number;
  prompt?: string;
}

export interface CheckpointActionResult {
  ok: boolean;
  message: string;
  data?: CheckpointActionData;
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

function createSessionId(): string {
  return `s${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
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
  private currentThinking: ThinkingLevel;
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

  constructor(options: AgentOptions = {}) {
    this.options = options;
    this.permissionRules = [...(options.permissions ?? DEFAULT_PERMISSIONS)];
    this.model = resolveModel(options.model, options.extensions);
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
    });
  }

  get sessionId(): string {
    return this._sessionId;
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

  get permissions(): PermissionRule[] {
    return [...this.permissionRules];
  }

  setPermissions(rules: PermissionRule[]): void {
    this.permissionRules = [...rules];
  }

  addPermissionRule(rule: PermissionRule): void {
    this.permissionRules.push(rule);
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

  setThinking(level: ThinkingLevel): void {
    const next = thinkingLevelForModel(this.model, level);
    if (next === this.currentThinking) return;
    this.currentThinking = next;
    this.tree.append({ type: "settings-change", thinkingLevel: next });
  }

  // Adopts a previously stored session so the next run continues it rather
  // than starting a fresh transcript.
  resume(tree: SessionTree): void {
    if (this.running) throw new Error("Cannot resume a session while a run is active.");
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
    this.currentThinking = thinkingLevelForModel(this.model, this.currentThinking);
    this.rebuildCheckpointHistory();
    this.refreshContextAccounting();
  }

  // Starts an independent conversation while keeping this Agent's configured
  // tools, permissions, model, thinking level, runtime, and subscribers.
  newSession(sessionId = createSessionId()): void {
    if (this.running) throw new Error("Cannot start a new session while a run is active.");
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
  followUp(message: string): void {
    if (this.stopping) return;
    this.followUps.push(userMessage(message));
    if (!this.running) this.scheduleAutonomousRun();
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
        keepRecentTokens: Math.min(
          DEFAULT_KEEP_RECENT_TOKENS,
          Math.max(2, Math.floor(this.model.contextWindow * 0.2)),
        ),
        ...(focus ? { customInstructions: focus } : {}),
        ...(this.options.carryoverExtractor
          ? { carryoverExtractor: this.options.carryoverExtractor }
          : {}),
        signal: this.controller.signal,
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
      const compacted = applyCompaction(result);
      const firstKept = result.keptMessages[0];
      let firstKeptEntryId: string | null = null;
      if (firstKept) {
        const workingIndex = working.indexOf(firstKept);
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

  // Undo restores the workspace AND rewinds the conversation together — either
  // alone would leave the session lying about its own state.
  async undo(): Promise<CheckpointActionResult> {
    if (this.running) return { ok: false, message: "Cannot undo while a run is active." };
    const provider = this.options.checkpointProvider;
    if (!provider) return { ok: false, message: "This profile does not support undo." };
    const step = this.checkpoints.peekUndo();
    if (!step) return { ok: false, message: "Nothing to undo." };
    if (!this.tree.has(step.beforeEntryId)) {
      return { ok: false, message: "Could not undo: the conversation checkpoint is missing." };
    }

    let files: CheckpointDiffFile[];
    try {
      files = await provider.diff(step.beforeRef, step.afterRef);
    } catch (error) {
      return {
        ok: false,
        message: `Could not undo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let rollbackRef: string | undefined;
    try {
      rollbackRef = await provider.snapshot("before undo of last turn");
    } catch (error) {
      return {
        ok: false,
        message: `Could not undo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!rollbackRef)
      return { ok: false, message: "Could not undo: failed to capture current state." };

    try {
      await this.restoreCheckpointResources(provider, step.beforeRef, files);
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
    const state = this.checkpoints.state();
    const nextDone = state.done.slice(0, -1);
    const nextUndone = [...state.undone, { ...step, redoRef: rollbackRef }];
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

    const details = this.checkpointDetails(step);
    this.checkpoints.restore(nextDone, nextUndone);
    this.tree = candidate;
    this.refreshContextAccounting();
    return {
      ok: true,
      message: "Undid the last turn.",
      data: {
        kind: "checkpoint",
        action: "undo",
        files,
        messageCount: details.messageCount,
        ...(details.prompt !== undefined ? { prompt: details.prompt } : {}),
      },
    };
  }

  async redo(): Promise<CheckpointActionResult> {
    if (this.running) return { ok: false, message: "Cannot redo while a run is active." };
    const provider = this.options.checkpointProvider;
    if (!provider) return { ok: false, message: "This profile does not support redo." };
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
      rollbackRef = await provider.snapshot("before redo of last turn");
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
        messageCount: details.messageCount,
      },
    };
  }

  // Aggregate diff for the session: first checkpoint → now.
  async sessionDiff(): Promise<Awaited<ReturnType<CheckpointProvider["diff"]>>> {
    const provider = this.options.checkpointProvider;
    const first = this.checkpoints.first();
    if (!provider || !first) return [];
    return provider.diff(first.beforeRef);
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

  private async beginCheckpoint(beforeEntryId: string | null): Promise<void> {
    const provider = this.options.checkpointProvider;
    this.pendingCheckpoint = undefined;
    if (!provider) return;
    try {
      const ref = await provider.snapshot("before user turn");
      if (ref) {
        this.pendingCheckpoint = {
          beforeEntryId,
          beforeRef: ref,
        };
      }
    } catch {}
  }

  private async finishCheckpoint(): Promise<void> {
    const pending = this.pendingCheckpoint;
    const provider = this.options.checkpointProvider;
    this.pendingCheckpoint = undefined;
    if (!pending || !provider) return;

    const afterRef = await provider.snapshot("after user turn").catch(() => undefined);
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
    prompt: string | UserContent[],
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
    const publish = (event: AgentEvent) => {
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
      if (this.manualCompactionQueued && !this.stopping) this.scheduleManualCompaction();
      else if (this.followUps.length > 0 && !this.stopping) this.scheduleAutonomousRun();
      this.resolveIdleIfDone();
    });
    this.activeExecution = execution;
    return execution;
  }

  private async executeRun<T>(
    prompt: string | UserContent[],
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
        : { role: "user", content: effectivePrompt, timestamp: Date.now() };

    let captured: T | undefined;
    let tools: AnyTool[] = [
      ...(this.options.tools ?? []),
      ...(host ? [...host.tools.values()] : []),
    ];
    if (opts?.allowedTools) {
      const available = new Set(tools.map((tool) => tool.name));
      const unknown = opts.allowedTools.filter((name) => !available.has(name));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown allowed tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
        );
      }
      const allowed = new Set(opts.allowedTools);
      tools = tools.filter((tool) => allowed.has(tool.name));
    }
    const runModel = opts?.model ? resolveModel(opts.model, this.options.extensions) : this.model;
    const runProvider = opts?.model ? this.providerFor(runModel) : this.provider;
    const runThinking = thinkingLevelForModel(runModel, this.currentThinking);
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
    for (const message of refreshed) this.tree.appendMessage(message);

    const context: AgentContext = {
      systemPrompt,
      messages: [...seeded, ...initial, ...refreshed],
      ...(tools.length > 0 ? { tools } : {}),
    };
    await this.beginCheckpoint(this.tree.head);

    let budgetHalt: HaltReason | undefined;

    const currentContextState = (messages: AgentMessage[]) =>
      contextState(
        runModel,
        messages,
        runContextUsage?.usage,
        runContextUsage?.estimatedTokensAtUsage,
      );

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
      const breach = checkBudget(this.options.budget, this.totals);
      if (breach) budgetHalt = breach;
      return breach;
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
      getSteeringMessages: () => {
        const pending = this.steering;
        this.steering = [];
        return pending;
      },
      getFollowUpMessages: () => {
        const next = this.followUps.shift();
        return next ? [next] : [];
      },
      beforeToolCall: async (info) => {
        // The structured-output tool is internal plumbing, never gated.
        if (info.toolCall.name === STRUCTURED_OUTPUT_TOOL) return undefined;

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
          permission === info.toolCall.name
            ? [info.toolCall.name]
            : [info.toolCall.name, permission];
        const action = evaluate(this.permissionRules, permissionTargets, pattern);
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
      },
      prepareContext: async (messages) => {
        const state = currentContextState(messages);
        this.lastContextPercent = state.percent;
        this.lastContextTokens = state.tokens;

        const auto = this.options.autoCompact !== false;

        // Layer 1 first: evicting stale tool output is free, and often enough
        // to stay under the threshold without an LLM round trip.
        let working = messages;
        if (auto && state.percent >= MICROCOMPACT_THRESHOLD && !this.compactRequested) {
          const micro = microcompact(working, {
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
          (auto && shouldCompact(after, this.options.compactThreshold ?? AUTO_COMPACT_THRESHOLD));
        if (!due) return { messages: working };

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
          });
          compactionUsage = result.usage;
          const compacted = applyCompaction(result);
          let summaryEntryId: string | undefined;

          // Record the boundary only when its exact tail can be anchored to
          // an ancestor entry. Otherwise retain the complete context.
          if (result.summary.length > 0) {
            const firstKept = result.keptMessages[0];
            let firstKeptEntryId: string | null = null;
            if (firstKept) {
              const mapped = this.tree.entryIdForMessage(firstKept);
              if (!mapped) {
                throw new Error("Compaction tail could not be mapped to the session");
              }
              firstKeptEntryId = mapped;
            }
            const summaryMessage = compacted[0];
            const boundary = this.tree.append({
              type: "compaction",
              summary: result.summary,
              ...(result.carryover !== undefined ? { carryover: result.carryover } : {}),
              firstKeptEntryId,
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
          return { messages: compacted, stop: budgetHalt !== undefined };
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
          return { messages: working, stop: budgetHalt !== undefined };
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
        await this.finishCheckpoint();
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

    if (!opts?.output) return runResult;
    if (captured === undefined) {
      // Better to fail loudly than to hand back an undefined typed as T.
      throw new Error(
        `Structured output was requested but the model never produced a valid one (run ended: ${reason}).`,
      );
    }
    return { ...runResult, output: captured };
  }

  private providerFor(model: ModelInfo): Provider {
    return (
      this.options.provider ??
      this.options.extensions?.providers.get(model.provider) ??
      getProvider(model.provider)
    );
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
      const message = this.followUps.shift();
      if (!message || message.role !== "user") {
        this.resolveIdleIfDone();
        return;
      }
      void this.execute(message.content, undefined, () => {}).catch(() => {});
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
