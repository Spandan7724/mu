import {
  addUsage,
  defaultModelRef,
  findModel,
  getProvider,
  type ModelInfo,
  type PromptSection,
  type Provider,
  type ThinkingLevel,
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
  type CheckpointEntry,
  CheckpointHistory,
  type CheckpointProvider,
  compact,
  contextState,
  type ExtensionHost,
  evaluate,
  isContextTooLongResult,
  type LoopConfig,
  MemorySessionStore,
  MICROCOMPACT_THRESHOLD,
  microcompact,
  type PermissionRequest,
  type PermissionRule,
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

// Per : tools reach the SDK only because the user registered them in their
// own code, so the bare SDK allows them. Restrictive rules come from profiles.
// An `ask` with no onPermission callback still denies (never hangs).
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
  thinkingLevel?: ThinkingLevel;
  apiKey?: string;
  // Typed context messages seeded once at the start of a session (profiles use
  // this for environment + project instructions — never a system-prompt edit).
  initialMessages?: AgentMessage[];
  // Compaction (M7). Auto-compaction runs when the context crosses the
  // threshold; the profile supplies what its domain must not lose.
  carryoverExtractor?: (messages: AgentMessage[]) => unknown;
  autoCompact?: boolean;
  compactThreshold?: number;
  // Snapshot/restore backing for /undo and /redo (profiles supply it).
  checkpointProvider?: CheckpointProvider;
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

function resolveModel(model: AgentOptions["model"]): ModelInfo {
  if (model && typeof model !== "string") return model;
  const ref = model ?? defaultModelRef();
  const found = findModel(ref);
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
  private lastContextPercent = 0;
  private readonly checkpoints = new CheckpointHistory();
  private externalEvents: AgentEvent[] = [];
  private recoveryAttempted = false;
  private snapshottedThisTurn = false;
  private pendingCheckpoint:
    | { beforeEntryId: string | null; beforeRef: string; label: string }
    | undefined;
  private currentThinking: ThinkingLevel;

  constructor(options: AgentOptions = {}) {
    this.options = options;
    this.currentThinking = options.thinkingLevel ?? "off";
    this.model = resolveModel(options.model);
    this.provider = options.provider ?? getProvider(this.model.provider);
    this.store = options.session ?? new MemorySessionStore();
    this._sessionId = options.sessionId ?? `s${Date.now().toString(36)}`;
    this.tree = new SessionTree({
      type: "session",
      version: SESSION_VERSION,
      id: this._sessionId,
      createdAt: new Date().toISOString(),
      profile: "default",
      environment: {},
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

  get thinking(): ThinkingLevel {
    return this.currentThinking;
  }

  // Switching model also switches provider — they travel together.
  setModel(ref: string | ModelInfo): void {
    this.model = resolveModel(ref);
    this.provider = this.options.provider ?? getProvider(this.model.provider);
  }

  setThinking(level: ThinkingLevel): void {
    this.currentThinking = level;
  }

  // Adopts a previously stored session so the next run continues it rather
  // than starting a fresh transcript.
  resume(tree: SessionTree): void {
    this.tree = tree;
    const header = tree.header;
    if (header) this._sessionId = header.id;
    this.rebuildCheckpointHistory();
  }

  // Steer a run that is already in flight; delivered before the next LLM call.
  send(message: string): void {
    this.steering.push(userMessage(message));
  }

  // Wake a run that would otherwise stop (also how background work resumes it).
  followUp(message: string): void {
    this.followUps.push(userMessage(message));
  }

  // Surfaces forward background-task events here: task_started/task_output/
  // task_exited reach consumers, and an exit wakes an idle run.
  emitTaskEvent(event: AgentEvent): void {
    this.externalEvents.push(event);
  }

  abort(): void {
    this.controller.abort();
  }

  // Requests compaction before the next LLM call (what /compact invokes).
  requestCompaction(): void {
    this.compactRequested = true;
  }

  get checkpointHistory(): CheckpointHistory {
    return this.checkpoints;
  }

  // Undo restores the workspace AND rewinds the conversation together — either
  // alone would leave the session lying about its own state.
  async undo(): Promise<{ ok: boolean; message: string }> {
    const provider = this.options.checkpointProvider;
    if (!provider) return { ok: false, message: "This profile does not support undo." };
    const step = this.checkpoints.peekUndo();
    if (!step) return { ok: false, message: "Nothing to undo." };
    if (!this.tree.has(step.beforeEntryId)) {
      return { ok: false, message: "Could not undo: the conversation checkpoint is missing." };
    }

    let rollbackRef: string | undefined;
    try {
      rollbackRef = await provider.snapshot(`before undo of ${step.label ?? "step"}`);
    } catch (error) {
      return {
        ok: false,
        message: `Could not undo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!rollbackRef)
      return { ok: false, message: "Could not undo: failed to capture current state." };

    try {
      await provider.restore(step.beforeRef);
    } catch (error) {
      return {
        ok: false,
        message: `Could not undo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const current = this.tree;
    const candidate = SessionTree.fromJsonl(current.toJsonl());
    candidate.fork(step.beforeEntryId);
    const state = this.checkpoints.state();
    candidate.append({
      type: "custom",
      customType: "checkpoint-cursor",
      data: {
        done: state.done.slice(0, -1).map((entry) => entry.id),
        undone: [...state.undone, step].map((entry) => entry.id),
      },
    });

    try {
      await this.store.save(this._sessionId, candidate);
    } catch (error) {
      await provider.restore(rollbackRef).catch(() => {});
      await this.store.save(this._sessionId, current).catch(() => {});
      return {
        ok: false,
        message: `Could not undo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    this.checkpoints.restore(state.done.slice(0, -1), [...state.undone, step]);
    this.tree = candidate;
    return { ok: true, message: `Undid ${step.label ?? "the last step"}.` };
  }

  async redo(): Promise<{ ok: boolean; message: string }> {
    const provider = this.options.checkpointProvider;
    if (!provider) return { ok: false, message: "This profile does not support redo." };
    const step = this.checkpoints.peekRedo();
    if (!step) return { ok: false, message: "Nothing to redo." };
    if (!this.tree.has(step.id)) {
      return { ok: false, message: "Could not redo: the conversation checkpoint is missing." };
    }

    let rollbackRef: string | undefined;
    try {
      rollbackRef = await provider.snapshot(`before redo of ${step.label ?? "step"}`);
    } catch (error) {
      return {
        ok: false,
        message: `Could not redo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!rollbackRef)
      return { ok: false, message: "Could not redo: failed to capture current state." };

    try {
      await provider.restore(step.afterRef);
    } catch (error) {
      return {
        ok: false,
        message: `Could not redo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const current = this.tree;
    const candidate = SessionTree.fromJsonl(current.toJsonl());
    candidate.fork(step.id);
    const state = this.checkpoints.state();
    candidate.append({
      type: "custom",
      customType: "checkpoint-cursor",
      data: {
        done: [...state.done, step].map((entry) => entry.id),
        undone: state.undone.slice(0, -1).map((entry) => entry.id),
      },
    });

    try {
      await this.store.save(this._sessionId, candidate);
    } catch (error) {
      await provider.restore(rollbackRef).catch(() => {});
      await this.store.save(this._sessionId, current).catch(() => {});
      return {
        ok: false,
        message: `Could not redo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    this.checkpoints.restore([...state.done, step], state.undone.slice(0, -1));
    this.tree = candidate;
    return { ok: true, message: `Redid ${step.label ?? "the step"}.` };
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
    return { ok: true, message: `Forked from ${entryId}.` };
  }

  get contextPercent(): number {
    return this.lastContextPercent;
  }

  async run(prompt: string | UserContent[]): Promise<RunResult>;
  async run<T>(
    prompt: string | UserContent[],
    opts: { output: z.ZodType<T> },
  ): Promise<RunResult & { output: T }>;
  async run<T>(
    prompt: string | UserContent[],
    opts?: { output: z.ZodType<T> },
  ): Promise<RunResult | (RunResult & { output: T })> {
    const events: AgentEvent[] = [];
    const result = await this.execute(prompt, opts, (event) => void events.push(event));
    return result;
  }

  // Streams events as they happen; the returned iterable also exposes result().
  stream(
    prompt: string | UserContent[],
  ): AsyncIterable<AgentEvent> & { result(): Promise<RunResult> } {
    const queue: AgentEvent[] = [];
    const waiters: ((value: IteratorResult<AgentEvent>) => void)[] = [];
    let done = false;

    const push = (event: AgentEvent) => {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else queue.push(event);
    };

    const finished = this.execute(prompt, undefined, push).finally(() => {
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

  // One snapshot per turn, taken before the first mutating call in it.
  private async snapshotIfMutating(tool: AnyTool | undefined, args: unknown): Promise<void> {
    const provider = this.options.checkpointProvider;
    if (!provider || !tool || this.snapshottedThisTurn) return;
    let mutates = tool.changesState === true;
    if (typeof tool.changesState === "function") {
      try {
        mutates = tool.changesState(args);
      } catch {
        mutates = false;
      }
    }
    if (!mutates) return;

    this.snapshottedThisTurn = true;
    try {
      const ref = await provider.snapshot(`before ${tool.name}`);
      if (ref) {
        const assistantEntry = this.tree.head ? this.tree.get(this.tree.head) : undefined;
        this.pendingCheckpoint = {
          beforeEntryId: assistantEntry?.parentId ?? null,
          beforeRef: ref,
          label: tool.name,
        };
      } else {
        this.snapshottedThisTurn = false;
      }
    } catch {
      this.snapshottedThisTurn = false;
    }
  }

  private async finishCheckpoint(): Promise<void> {
    const pending = this.pendingCheckpoint;
    const provider = this.options.checkpointProvider;
    this.pendingCheckpoint = undefined;
    if (!pending || !provider) return;

    const afterRef = await provider.snapshot(`after ${pending.label}`).catch(() => undefined);
    if (!afterRef) return;
    const entry = this.tree.append({
      type: "checkpoint",
      beforeEntryId: pending.beforeEntryId,
      checkpointRef: pending.beforeRef,
      checkpointAfterRef: afterRef,
      label: pending.label,
    });
    this.checkpoints.record({
      id: entry.id,
      beforeEntryId: pending.beforeEntryId,
      beforeRef: pending.beforeRef,
      afterRef,
      label: pending.label,
    });
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
    const cursor = [...active]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === "checkpoint-cursor");
    if (cursor?.type === "custom") {
      const data = cursor.data as { done?: unknown; undone?: unknown };
      const resolve = (value: unknown): CheckpointEntry[] =>
        Array.isArray(value)
          ? value
              .filter((id): id is string => typeof id === "string")
              .map((id) => all.get(id))
              .filter((entry): entry is CheckpointEntry => entry !== undefined)
          : [];
      this.checkpoints.restore(resolve(data.done), resolve(data.undone));
      return;
    }

    this.checkpoints.restore(
      active
        .filter((entry) => entry.type === "checkpoint")
        .map((entry) => all.get(entry.id))
        .filter((entry): entry is CheckpointEntry => entry !== undefined),
    );
  }

  private async execute<T>(
    prompt: string | UserContent[],
    opts: { output?: z.ZodType<T> } | undefined,
    emit: (event: AgentEvent) => void,
  ): Promise<RunResult & { output?: T }> {
    this.controller = new AbortController();
    // Reactive recovery is "retry once per overflow", not once per Agent: a
    // long session must still be able to recover hours later.
    this.recoveryAttempted = false;

    const promptMessage: AgentMessage =
      typeof prompt === "string"
        ? userMessage(prompt)
        : { role: "user", content: prompt, timestamp: Date.now() };

    let captured: T | undefined;
    const host = this.options.extensions;
    const tools: AnyTool[] = [
      ...(this.options.tools ?? []),
      ...(host ? [...host.tools.values()] : []),
    ];
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

    const context: AgentContext = {
      systemPrompt,
      messages: [...initial, ...seeded],
      ...(tools.length > 0 ? { tools } : {}),
    };

    let budgetHalt: HaltReason | undefined;

    const config: LoopConfig = {
      provider: this.provider,
      model: this.model,
      ...(this.options.apiKey ? { streamOpts: { apiKey: this.options.apiKey } } : {}),
      thinkingLevel: this.currentThinking,
      ...(this.options.budget?.maxTurns !== undefined
        ? { maxTurns: this.options.budget.maxTurns }
        : {}),
      getSteeringMessages: () => {
        const pending = this.steering;
        this.steering = [];
        return pending;
      },
      getFollowUpMessages: () => {
        // Drain any background-task events onto the stream first, so the
        // consumer sees why the agent woke up.
        for (const event of this.externalEvents.splice(0)) emit(event);
        const pending = this.followUps;
        this.followUps = [];
        return pending;
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

        const pattern = JSON.stringify(args);
        const action = evaluate(
          this.options.permissions ?? DEFAULT_PERMISSIONS,
          info.toolCall.name,
          pattern,
        );
        const rewritten = args === info.args ? undefined : { rewrittenArgs: args };
        const selectedTool = tools.find((tool) => tool.name === info.toolCall.name);
        if (action === "allow") {
          await this.snapshotIfMutating(selectedTool, args);
          return rewritten;
        }
        if (action === "deny") {
          return { block: true, reason: `Permission denied for ${info.toolCall.name}` };
        }
        const request: PermissionRequest = {
          id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          toolCallId: info.toolCall.id,
          toolName: info.toolCall.name,
          pattern,
          description: `Run ${info.toolCall.name}`,
        };
        emit({ type: "permission_asked", request });
        // Default DENY: never hang an unattended process on an unanswered ask.
        const outcome = this.options.onPermission
          ? await this.options.onPermission(request)
          : "deny";
        emit({ type: "permission_resolved", requestId: request.id, outcome });
        if (outcome === "allow") {
          await this.snapshotIfMutating(selectedTool, args);
          return rewritten;
        }
        return {
          block: true,
          reason: `Permission denied for ${info.toolCall.name}`,
        };
      },
      transformContext: async (messages) => {
        const transformed = host ? await host.runContextHooks(messages) : messages;
        const state = contextState(this.model, transformed);
        this.lastContextPercent = state.percent;

        const auto = this.options.autoCompact !== false;

        // Layer 1 first: evicting stale tool output is free, and often enough
        // to stay under the threshold without an LLM round trip.
        let working = transformed;
        if (auto && state.percent >= MICROCOMPACT_THRESHOLD && !this.compactRequested) {
          const micro = microcompact(working, {
            targetTokens: Math.floor(
              this.model.contextWindow *
                (this.options.compactThreshold ?? AUTO_COMPACT_THRESHOLD) *
                0.8,
            ),
          });
          if (micro.evicted > 0) {
            emit({ type: "compaction_start", layer: 1 });
            emit({ type: "compaction_end", layer: 1, tokensFreed: micro.tokensFreed });
            working = micro.messages;
            this.lastContextPercent = contextState(this.model, working).percent;
          }
        }

        const after = contextState(this.model, working);
        const due =
          this.compactRequested ||
          (auto && shouldCompact(after, this.options.compactThreshold ?? AUTO_COMPACT_THRESHOLD));
        if (!due) return working;

        this.compactRequested = false;
        emit({ type: "compaction_start", layer: 2 });
        try {
          const result = await compact(working, {
            provider: this.provider,
            model: this.model,
            ...(this.options.carryoverExtractor
              ? { carryoverExtractor: this.options.carryoverExtractor }
              : {}),
            signal: this.controller.signal,
          });
          const compacted = applyCompaction(result);
          emit({
            type: "compaction_end",
            layer: 2,
            tokensFreed: result.tokensFreed,
          });
          // Record the boundary in the session tree so a resume rebuilds
          // context as summary + tail rather than replaying everything.
          if (result.summary.length > 0) {
            this.tree.append({
              type: "compaction",
              summary: result.summary,
              ...(result.carryover !== undefined ? { carryover: result.carryover } : {}),
              firstKeptEntryId: this.tree.head ?? "",
            });
          }
          return compacted;
        } catch {
          // A failed summarization must not take the run down: carry on
          // uncompacted and let the provider surface any context error.
          emit({ type: "compaction_end", layer: 2, tokensFreed: 0 });
          return working;
        }
      },
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
        emit({ type: "compaction_start", layer: 3 });
        emit({ type: "compaction_end", layer: 3, tokensFreed: 0 });
        return true;
      },
      shouldStopAfterTurn: async (turn: TurnInfo) => {
        await this.finishCheckpoint();
        this.snapshottedThisTurn = false;
        this.totals = addUsage(this.totals, turn.message.usage);
        emit({
          type: "usage_updated",
          sessionTotals: this.totals,
          contextTokens: turn.message.usage.inputTokens,
          contextPercent: turn.message.usage.inputTokens / this.model.contextWindow,
        });
        const breach = checkBudget(this.options.budget, this.totals);
        if (breach) {
          budgetHalt = breach;
          return true;
        }
        return false;
      },
    };

    const result = await runLoop(
      [promptMessage],
      context,
      config,
      (event) => {
        emit(event);
        host?.emit(event);
        if (event.type === "message_end") this.tree.appendMessage(event.message);
      },
      this.controller.signal,
    );

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
}
