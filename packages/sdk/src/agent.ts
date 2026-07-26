import {
  addUsage,
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
  type ExtensionHost,
  evaluate,
  type LoopConfig,
  MemorySessionStore,
  type PermissionRequest,
  type PermissionRule,
  runLoop,
  SESSION_VERSION,
  type SessionStore,
  SessionTree,
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

const DEFAULT_MODEL = "anthropic/claude-opus-5";

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
  const ref = model ?? DEFAULT_MODEL;
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
  private readonly model: ModelInfo;
  private readonly provider: Provider;
  private readonly store: SessionStore;
  private readonly tree: SessionTree;
  private readonly _sessionId: string;
  private controller = new AbortController();
  private steering: AgentMessage[] = [];
  private followUps: AgentMessage[] = [];
  private totals: Usage = zeroUsage();

  constructor(options: AgentOptions = {}) {
    this.options = options;
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

  // Steer a run that is already in flight; delivered before the next LLM call.
  send(message: string): void {
    this.steering.push(userMessage(message));
  }

  // Wake a run that would otherwise stop (also how background work resumes it).
  followUp(message: string): void {
    this.followUps.push(userMessage(message));
  }

  abort(): void {
    this.controller.abort();
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

  private async execute<T>(
    prompt: string | UserContent[],
    opts: { output?: z.ZodType<T> } | undefined,
    emit: (event: AgentEvent) => void,
  ): Promise<RunResult & { output?: T }> {
    this.controller = new AbortController();

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

    const context: AgentContext = {
      systemPrompt,
      messages: this.tree.messagesAt(),
      ...(tools.length > 0 ? { tools } : {}),
    };

    let budgetHalt: HaltReason | undefined;

    const config: LoopConfig = {
      provider: this.provider,
      model: this.model,
      ...(this.options.apiKey ? { streamOpts: { apiKey: this.options.apiKey } } : {}),
      ...(this.options.thinkingLevel !== undefined
        ? { thinkingLevel: this.options.thinkingLevel }
        : {}),
      ...(this.options.budget?.maxTurns !== undefined
        ? { maxTurns: this.options.budget.maxTurns }
        : {}),
      getSteeringMessages: () => {
        const pending = this.steering;
        this.steering = [];
        return pending;
      },
      getFollowUpMessages: () => {
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
        if (action === "allow") return rewritten;
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
        return outcome === "allow"
          ? rewritten
          : {
              block: true,
              reason: `Permission denied for ${info.toolCall.name}`,
            };
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
            transformContext: (messages) => host.runContextHooks(messages),
          }
        : {}),
      shouldStopAfterTurn: (turn: TurnInfo) => {
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
