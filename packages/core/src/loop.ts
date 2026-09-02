import {
  type AssistantMessage,
  EventStream,
  type HostedToolSpec,
  type LlmContext,
  type ModelInfo,
  type Provider,
  type StreamOpts,
  type ThinkingLevel,
  type ToolCallContent,
  type ToolResultContent,
  type ToolResultMessage,
} from "@mu/ai";
import type { AgentEndReason, AgentEvent, EventSink, StreamDelta } from "./events.ts";
import type { AgentMessage } from "./messages.ts";
import { toAiMessages } from "./messages.ts";
import { type AnyTool, concurrencySafe, errorResult, type ToolResult } from "./tools.ts";

const PARALLEL_LIMIT = 10;
const DOOM_LOOP_THRESHOLD = 3;

export interface AgentContext {
  systemPrompt?: LlmContext["systemPrompt"];
  messages: AgentMessage[];
  tools?: AnyTool[];
  hostedTools?: HostedToolSpec[];
}

export interface TurnInfo {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContext;
  requestMessages: AgentMessage[];
  newMessages: AgentMessage[];
}

export interface BeforeToolCallInfo {
  assistantMessage: AssistantMessage;
  toolCall: ToolCallContent;
  args: Record<string, unknown>;
  context: AgentContext;
}

export interface AfterToolCallInfo extends BeforeToolCallInfo {
  result: ToolResult;
  isError: boolean;
}

export interface NextTurnDirective {
  model?: ModelInfo;
  thinkingLevel?: ThinkingLevel;
  context?: AgentContext;
}

export interface ContextPreparation {
  messages: AgentMessage[];
  stop?: boolean;
}

export interface LoopConfig {
  provider: Provider;
  model: ModelInfo;
  streamOpts?: StreamOpts;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;

  // Steering: polled between steps; injected before the next LLM call.
  getSteeringMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
  // Follow-ups keep the loop alive after it would otherwise stop. Also the
  // wake-up mechanism for background work completing.
  getFollowUpMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;

  // Control hooks — the loop's public API.
  beforeToolCall?: (
    info: BeforeToolCallInfo,
    signal: AbortSignal,
  ) =>
    | { block?: boolean; reason?: string; rewrittenArgs?: Record<string, unknown> }
    | undefined
    | Promise<
        { block?: boolean; reason?: string; rewrittenArgs?: Record<string, unknown> } | undefined
      >;
  afterToolCall?: (
    info: AfterToolCallInfo,
    signal: AbortSignal,
  ) => ToolResult | undefined | Promise<ToolResult | undefined>;
  shouldStopAfterTurn?: (turn: TurnInfo) => boolean | Promise<boolean>;
  // Called when a turn ends in a provider error. Returning true continues the
  // loop instead of ending the run — this is where reactive context recovery
  // hooks on. It runs before the loop would otherwise give up.
  recoverFromError?: (message: AssistantMessage) => boolean | Promise<boolean>;
  prepareNextTurn?: (
    turn: TurnInfo,
  ) => NextTurnDirective | undefined | Promise<NextTurnDirective | undefined>;
  // Persistent context transitions, such as compaction, replace the live loop
  // state before a request. A preparation may stop the run before that request.
  prepareContext?: (
    messages: AgentMessage[],
  ) => ContextPreparation | AgentMessage[] | Promise<ContextPreparation | AgentMessage[]>;
  // Request-local transforms (redaction, extension injection) do not replace
  // the loop's transcript.
  transformContext?: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
}

export interface AgentRunResult {
  messages: AgentMessage[];
  reason: AgentEndReason;
}

export class AgentEventStream extends EventStream<AgentEvent, AgentRunResult> {
  constructor() {
    super(
      (event) => event.type === "agent_end",
      (event) =>
        event.type === "agent_end"
          ? { messages: event.messages, reason: event.reason }
          : { messages: [], reason: "error" as const },
    );
  }
}

export function runAgent(
  prompts: AgentMessage[],
  context: AgentContext,
  config: LoopConfig,
  signal?: AbortSignal,
): AgentEventStream {
  const stream = new AgentEventStream();
  void runLoop(prompts, context, config, (event) => stream.push(event), signal).finally(() => {
    stream.end();
  });
  return stream;
}

function toolCallsOf(message: AssistantMessage): ToolCallContent[] {
  return message.content.filter((block): block is ToolCallContent => block.type === "toolCall");
}

function toolCallFingerprint(call: ToolCallContent): string {
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

export async function runLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: LoopConfig,
  emit: EventSink,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  const abort = signal ?? new AbortController().signal;
  const newMessages: AgentMessage[] = [...prompts];
  let currentContext: AgentContext = { ...context, messages: [...context.messages, ...prompts] };
  let currentConfig = config;
  let turns = 0;
  const recentCalls: string[] = [];

  const finish = async (reason: AgentEndReason): Promise<AgentRunResult> => {
    await emit({ type: "agent_end", messages: newMessages, reason });
    return { messages: newMessages, reason };
  };

  await emit({ type: "agent_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  let pending: AgentMessage[] = (await currentConfig.getSteeringMessages?.()) ?? [];

  for (;;) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pending.length > 0) {
      if (abort.aborted) return finish("aborted");
      if (currentConfig.maxTurns !== undefined && turns >= currentConfig.maxTurns) {
        return finish("maxTurns");
      }
      turns++;

      await emit({ type: "turn_start" });

      for (const message of pending) {
        await emit({ type: "message_start", message });
        await emit({ type: "message_end", message });
        currentContext.messages.push(message);
        newMessages.push(message);
      }
      pending = [];

      if (currentConfig.prepareContext) {
        const prepared = await currentConfig.prepareContext(currentContext.messages);
        const preparation = Array.isArray(prepared) ? { messages: prepared } : prepared;
        currentContext = { ...currentContext, messages: preparation.messages };
        if (preparation.stop) return finish("budget");
      }

      const request = await streamAssistant(currentContext, currentConfig, emit, abort);
      const message = request.message;
      currentContext.messages.push(message);
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        if (
          message.stopReason === "error" &&
          (await currentConfig.recoverFromError?.(message)) === true
        ) {
          // The hook took responsibility for making the next attempt viable.
          hasMoreToolCalls = true;
          continue;
        }
        return finish(message.stopReason === "aborted" ? "aborted" : "error");
      }

      const calls = toolCallsOf(message);
      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;

      if (calls.length > 0) {
        // A "length" stop means arguments may be silently truncated: fail every
        // call in the message rather than executing a half-parsed one.
        const batch =
          message.stopReason === "length"
            ? await failTruncatedCalls(calls, emit)
            : await executeCalls(calls, message, currentContext, currentConfig, emit, abort);
        toolResults.push(...batch.results);
        pending.push(...batch.steering);
        hasMoreToolCalls = !batch.terminate;
        for (const result of batch.results) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }

        const nudge = detectDoomLoop(calls, recentCalls);
        if (nudge) {
          currentContext.messages.push(nudge);
          newMessages.push(nudge);
          await emit({ type: "message_start", message: nudge });
          await emit({ type: "message_end", message: nudge });
        }
      }

      await emit({ type: "turn_end", message, toolResults });

      const turn: TurnInfo = {
        message,
        toolResults,
        context: currentContext,
        requestMessages: request.messages,
        newMessages,
      };

      const directive = await currentConfig.prepareNextTurn?.(turn);
      if (directive) {
        if (directive.context) currentContext = directive.context;
        currentConfig = {
          ...currentConfig,
          ...(directive.model ? { model: directive.model } : {}),
          ...(directive.thinkingLevel !== undefined
            ? { thinkingLevel: directive.thinkingLevel }
            : {}),
        };
      }

      if (await currentConfig.shouldStopAfterTurn?.(turn)) return finish("done");

      pending.push(...((await currentConfig.getSteeringMessages?.()) ?? []));
    }

    const followUps = (await currentConfig.getFollowUpMessages?.()) ?? [];
    if (followUps.length > 0) {
      pending = followUps;
      continue;
    }
    break;
  }

  return finish("done");
}

// Injects a nudge when the identical call repeats N times in a row.
function detectDoomLoop(calls: ToolCallContent[], recent: string[]): AgentMessage | undefined {
  for (const call of calls) {
    const fingerprint = toolCallFingerprint(call);
    if (recent[recent.length - 1] === fingerprint) {
      recent.push(fingerprint);
    } else {
      recent.length = 0;
      recent.push(fingerprint);
    }
  }
  if (recent.length < DOOM_LOOP_THRESHOLD) return undefined;
  const name = calls[calls.length - 1]?.name ?? "the tool";
  recent.length = 0;
  return {
    role: "custom",
    customType: "system-reminder",
    content: [
      {
        type: "text",
        text: `You have called ${name} with identical arguments ${DOOM_LOOP_THRESHOLD} times in a row and the result is not changing. Stop repeating it — try a different approach, or explain what is blocking you.`,
      },
    ],
    display: true,
    timestamp: Date.now(),
  };
}

function providerDelta(event: {
  type: string;
  contentIndex?: number;
  delta?: string;
  toolCall?: ToolCallContent;
}): StreamDelta | undefined {
  const contentIndex = event.contentIndex ?? 0;
  switch (event.type) {
    case "text_start":
      return { kind: "text_start", contentIndex };
    case "text_delta":
      return { kind: "text_delta", contentIndex, text: event.delta ?? "" };
    case "text_end":
      return { kind: "text_end", contentIndex };
    case "thinking_start":
      return { kind: "thinking_start", contentIndex };
    case "thinking_delta":
      return { kind: "thinking_delta", contentIndex, text: event.delta ?? "" };
    case "thinking_end":
      return { kind: "thinking_end", contentIndex };
    case "toolcall_start":
      return { kind: "toolcall_start", contentIndex };
    case "toolcall_delta":
      return { kind: "toolcall_delta", contentIndex, argsFragment: event.delta ?? "" };
    case "toolcall_end":
      return { kind: "toolcall_end", contentIndex, toolCallId: event.toolCall?.id ?? "" };
    default:
      return undefined;
  }
}

async function streamAssistant(
  context: AgentContext,
  config: LoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<{ message: AssistantMessage; messages: AgentMessage[] }> {
  const messages = config.transformContext
    ? await config.transformContext(context.messages)
    : context.messages;

  const llmContext: LlmContext = {
    ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
    messages: toAiMessages(messages),
    ...(context.tools
      ? {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }
      : {}),
    ...(context.hostedTools ? { hostedTools: context.hostedTools } : {}),
  };

  const stream = config.provider.stream(config.model, llmContext, {
    ...config.streamOpts,
    ...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel } : {}),
    signal,
  });

  let started = false;
  for await (const event of stream) {
    if (event.type === "start") {
      started = true;
      await emit({ type: "message_start", message: { ...event.partial } });
      continue;
    }
    if (event.type === "done" || event.type === "error") break;
    if (event.type === "websearch_start" || event.type === "websearch_end") {
      await emit({
        type: event.type === "websearch_start" ? "web_search_start" : "web_search_end",
        search: event.webSearch,
      });
      continue;
    }
    const delta = providerDelta(event);
    if (delta) {
      await emit({ type: "message_update", message: { ...event.partial }, delta });
    }
  }

  const final = await stream.result();
  if (!started) await emit({ type: "message_start", message: { ...final } });
  await emit({ type: "message_end", message: final });
  return { message: final, messages };
}

interface ToolBatch {
  results: ToolResultMessage[];
  terminate: boolean;
  steering: AgentMessage[];
}

function resultMessage(
  call: ToolCallContent,
  result: ToolResult,
  isError: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content ?? [],
    ...(result.details !== undefined ? { details: result.details } : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    isError,
    timestamp: Date.now(),
  };
}

async function emitResult(message: ToolResultMessage, emit: EventSink): Promise<void> {
  await emit({ type: "tool_execution_end", toolCallId: message.toolCallId, result: message });
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });
}

async function failTruncatedCalls(calls: ToolCallContent[], emit: EventSink): Promise<ToolBatch> {
  const results: ToolResultMessage[] = [];
  for (const call of calls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    const message = resultMessage(
      call,
      errorResult(
        `Tool call "${call.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
      ),
      true,
    );
    await emitResult(message, emit);
    results.push(message);
  }
  return { results, terminate: false, steering: [] };
}

async function skipCallsForSteering(
  calls: ToolCallContent[],
  emit: EventSink,
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];
  for (const call of calls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    const message = resultMessage(
      call,
      errorResult(
        `Tool call "${call.name}" was not executed because a steering message interrupted the remaining tool calls. Re-evaluate the plan before re-issuing it.`,
      ),
      true,
    );
    await emitResult(message, emit);
    results.push(message);
  }
  return results;
}

interface Prepared {
  call: ToolCallContent;
  tool: AnyTool;
  args: Record<string, unknown>;
}

type Preparation =
  | { kind: "prepared"; prepared: Prepared }
  | { kind: "immediate"; result: ToolResult };

async function prepareCall(
  call: ToolCallContent,
  assistantMessage: AssistantMessage,
  context: AgentContext,
  config: LoopConfig,
  signal: AbortSignal,
): Promise<Preparation> {
  const tool = context.tools?.find((t) => t.name === call.name);
  if (!tool) return { kind: "immediate", result: errorResult(`Tool ${call.name} not found`) };

  try {
    let args = call.arguments;
    const directive = await config.beforeToolCall?.(
      { assistantMessage, toolCall: call, args, context },
      signal,
    );
    if (signal.aborted) return { kind: "immediate", result: errorResult("Operation aborted") };
    if (directive?.block) {
      return {
        kind: "immediate",
        result: errorResult(directive.reason || "Tool execution was blocked"),
      };
    }
    if (directive?.rewrittenArgs) args = directive.rewrittenArgs;
    return { kind: "prepared", prepared: { call, tool, args } };
  } catch (error) {
    return {
      kind: "immediate",
      result: errorResult(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function runPrepared(
  prepared: Prepared,
  assistantMessage: AssistantMessage,
  context: AgentContext,
  config: LoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<{ result: ToolResult; isError: boolean }> {
  let result: ToolResult;
  let isError: boolean;
  let updateChain = Promise.resolve();
  try {
    result = await prepared.tool.execute(
      prepared.call.id,
      prepared.args,
      signal,
      (partial, details) => {
        updateChain = updateChain.then(() =>
          emit({
            type: "tool_execution_update",
            toolCallId: prepared.call.id,
            partial,
            ...(details !== undefined ? { details } : {}),
          }),
        );
      },
    );
    await updateChain;
    isError = result.isError === true;
  } catch (error) {
    result = errorResult(error instanceof Error ? error.message : String(error));
    isError = true;
  }

  if (config.afterToolCall) {
    try {
      const rewritten = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.call,
          args: prepared.args,
          context,
          result,
          isError,
        },
        signal,
      );
      if (rewritten) {
        result = rewritten;
        isError = rewritten.isError ?? isError;
      }
    } catch (error) {
      result = errorResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }
  }
  return { result, isError };
}

// Consecutive concurrency-safe calls run in parallel (capped); anything else
// serializes. Order of results always matches order of calls.
async function executeCalls(
  calls: ToolCallContent[],
  assistantMessage: AssistantMessage,
  context: AgentContext,
  config: LoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<ToolBatch> {
  const results: ToolResultMessage[] = [];
  const terminateFlags: boolean[] = [];
  let steering: AgentMessage[] = [];

  const runOne = async (call: ToolCallContent): Promise<ToolResultMessage> => {
    await emit({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    const preparation = await prepareCall(call, assistantMessage, context, config, signal);
    const outcome =
      preparation.kind === "immediate"
        ? { result: preparation.result, isError: true }
        : await runPrepared(preparation.prepared, assistantMessage, context, config, emit, signal);
    terminateFlags.push(outcome.result.terminate === true);
    return resultMessage(call, outcome.result, outcome.isError);
  };

  let i = 0;
  while (i < calls.length) {
    const call = calls[i] as ToolCallContent;
    const tool = context.tools?.find((t) => t.name === call.name);
    const safe = tool ? concurrencySafe(tool, call.arguments) : false;

    if (!safe) {
      const message = await runOne(call);
      await emitResult(message, emit);
      results.push(message);
      i++;
      if (signal.aborted) break;
      steering = (await config.getSteeringMessages?.()) ?? [];
      if (steering.length > 0) break;
      continue;
    }

    // Gather the run of consecutive safe calls.
    const batch: ToolCallContent[] = [];
    while (i < calls.length && batch.length < PARALLEL_LIMIT) {
      const next = calls[i] as ToolCallContent;
      const nextTool = context.tools?.find((t) => t.name === next.name);
      if (!nextTool || !concurrencySafe(nextTool, next.arguments)) break;
      batch.push(next);
      i++;
    }
    const settled = await Promise.all(batch.map(runOne));
    for (const message of settled) {
      await emitResult(message, emit);
      results.push(message);
    }
    if (signal.aborted) break;
    steering = (await config.getSteeringMessages?.()) ?? [];
    if (steering.length > 0) break;
  }

  if (steering.length > 0 && i < calls.length) {
    results.push(...(await skipCallsForSteering(calls.slice(i), emit)));
  }

  return {
    results,
    terminate: terminateFlags.length > 0 && terminateFlags.every(Boolean),
    steering,
  };
}

export type { ToolResultContent };
