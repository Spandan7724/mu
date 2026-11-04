import { addUsage, type PromptSection, type Usage, zeroUsage } from "@mu/ai";
import { type AgentMessage, estimateTextTokens, estimateTokens } from "@mu/core";

// Where spend came from. Surfaces may add their own sources (for example a side
// conversation) through Agent.recordExternalUsage.
export type UsageSource = "main" | "subagents" | "tools" | "compaction" | "other" | (string & {});

export interface UsageLine {
  source: UsageSource;
  model: string;
  usage: Usage;
  // Assistant responses; compaction and unattributed spend count none.
  turns: number;
}

export interface ContextPart {
  id: "system" | "tools" | "context" | "summary" | "messages" | "toolResults";
  label: string;
  tokens: number;
  count?: number;
  children?: { id: string; tokens: number }[];
}

export interface ContextBreakdown {
  tokens: number;
  window: number;
  // False until a provider has reported the size of a request in this context;
  // the total is then an estimate like its parts.
  reported: boolean;
  autoCompactAt: number;
  parts: ContextPart[];
}

export interface CostReport {
  kind: "cost";
  totals: Usage;
  lines: UsageLine[];
  context: ContextBreakdown;
}

const key = (source: string, model: string) => `${source}\u0000${model}`;

export class UsageLedger {
  private lines = new Map<string, UsageLine>();

  add(line: UsageLine): void {
    const id = key(line.source, line.model);
    const current = this.lines.get(id);
    this.lines.set(
      id,
      current
        ? {
            ...current,
            usage: addUsage(current.usage, line.usage),
            turns: current.turns + line.turns,
          }
        : { ...line, usage: addUsage(zeroUsage(), line.usage) },
    );
  }

  list(): UsageLine[] {
    return [...this.lines.values()];
  }

  clear(): void {
    this.lines.clear();
  }
}

function subtract(a: Usage, b: Usage): Usage {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens),
    cacheWriteTokens: Math.max(0, a.cacheWriteTokens - b.cacheWriteTokens),
    costUsd: Math.max(0, (a.costUsd ?? 0) - (b.costUsd ?? 0)),
  };
}

export function usageDelta(after: Usage, before: Usage): Usage {
  return subtract(after, before);
}

const isEmpty = (usage: Usage) =>
  usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0 &&
  (usage.costUsd ?? 0) === 0;

interface ChildTranscript {
  model: string;
  messages: AgentMessage[];
}

function childTranscript(details: unknown): ChildTranscript | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const value = details as {
    type?: unknown;
    model?: unknown;
    messages?: unknown;
    result?: unknown;
  };
  if (value.type === "subagent-background-result") return childTranscript(value.result);
  if (
    value.type !== "subagent" ||
    typeof value.model !== "string" ||
    !Array.isArray(value.messages)
  )
    return undefined;
  return { model: value.model, messages: value.messages as AgentMessage[] };
}

// Usage a tool result or custom message carries, split by the child's own turns
// when its transcript is attached. Whatever the turns do not explain (a child's
// compaction, trimmed history) stays with the child's model.
export function attachedUsageLines(
  usage: Usage,
  details: unknown,
  fallbackModel: string,
): UsageLine[] {
  const child = childTranscript(details);
  if (!child) return [{ source: "tools", model: fallbackModel, usage, turns: 0 }];
  const ledger = new UsageLedger();
  let explained = zeroUsage();
  for (const message of child.messages) {
    if (message.role !== "assistant") continue;
    ledger.add({
      source: "subagents",
      model: message.model,
      usage: message.usage,
      turns: message.stopReason === "error" ? 0 : 1,
    });
    explained = addUsage(explained, message.usage);
  }
  const rest = subtract(usage, explained);
  if (!isEmpty(rest))
    ledger.add({ source: "subagents", model: child.model, usage: rest, turns: 0 });
  return ledger.list();
}

export interface ExternalUsageData {
  source: UsageSource;
  model: string;
  usage: Usage;
  turns: number;
}

export const EXTERNAL_USAGE_TYPE = "usage";

export function isExternalUsageData(value: unknown): value is ExternalUsageData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Partial<ExternalUsageData>;
  const usage = data.usage as Partial<Usage> | undefined;
  const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  return (
    typeof data.source === "string" &&
    typeof data.model === "string" &&
    count(data.turns) &&
    typeof usage === "object" &&
    usage !== null &&
    count(usage.inputTokens) &&
    count(usage.outputTokens) &&
    count(usage.cacheReadTokens) &&
    count(usage.cacheWriteTokens) &&
    (usage.costUsd === undefined || count(usage.costUsd))
  );
}

const DEFAULT_CONTEXT_LABELS: Record<string, string> = {
  skills: "skills",
  mcp_servers: "MCP servers",
  environment: "environment",
  "system-reminder": "reminders",
  background_task: "background notices",
  background_subagent: "background notices",
  user_shell_command: "your shell commands",
};

export interface ContextBreakdownInput {
  systemPrompt: PromptSection[];
  tools: { name: string; description: string; inputSchema: unknown }[];
  messages: AgentMessage[];
  compactions: number;
  tokens: number;
  window: number;
  reported: boolean;
  autoCompactAt: number;
  label?: (customType: string) => string | undefined;
}

const blockTokens = (message: AgentMessage, block: unknown) =>
  estimateTokens([{ ...message, content: [block] } as AgentMessage]);

// Estimates each part of the request the model sees and scales them to the context
// total; leaves are scaled and parents summed so rows add up.
export function contextBreakdown(input: ContextBreakdownInput): ContextBreakdown {
  const system = estimateTextTokens(JSON.stringify(input.systemPrompt));
  const tools = estimateTextTokens(JSON.stringify(input.tools));
  const context = new Map<string, number>();
  let summary = 0;
  const conversation = { user: 0, assistant: 0, thinking: 0, toolCalls: 0 };
  const results = new Map<string, number>();
  for (const message of input.messages) {
    if (message.role === "custom") {
      const tokens = estimateTokens([message]);
      if (message.customType === "compaction-summary") summary += tokens;
      else {
        const label =
          input.label?.(message.customType) ??
          DEFAULT_CONTEXT_LABELS[message.customType] ??
          "other context";
        context.set(label, (context.get(label) ?? 0) + tokens);
      }
    } else if (message.role === "user") conversation.user += estimateTokens([message]);
    else if (message.role === "toolResult")
      results.set(
        message.toolName,
        (results.get(message.toolName) ?? 0) + estimateTokens([message]),
      );
    else if (message.role === "assistant") {
      for (const block of message.content) {
        const tokens = blockTokens(message, block);
        if (block.type === "text") conversation.assistant += tokens;
        else if (block.type === "thinking") conversation.thinking += tokens;
        else conversation.toolCalls += tokens;
      }
    }
  }

  const parts: ContextPart[] = [
    { id: "system", label: "system prompt", tokens: system },
    { id: "tools", label: "tool definitions", tokens: tools, count: input.tools.length },
  ];
  for (const [label, tokens] of context) parts.push({ id: "context", label, tokens });
  if (summary > 0)
    parts.push({ id: "summary", label: "summary", tokens: summary, count: input.compactions });
  const messageChildren = (["user", "assistant", "thinking", "toolCalls"] as const)
    .map((id) => ({ id, tokens: conversation[id] }))
    .filter((child) => child.tokens > 0);
  if (messageChildren.length > 0)
    parts.push({ id: "messages", label: "messages", tokens: 0, children: messageChildren });
  if (results.size > 0) {
    parts.push({
      id: "toolResults",
      label: "tool results",
      tokens: 0,
      children: [...results]
        .map(([id, tokens]) => ({ id, tokens }))
        .sort((a, b) => b.tokens - a.tokens),
    });
  }

  const settle = () => {
    for (const part of parts) {
      if (part.children) part.tokens = part.children.reduce((sum, child) => sum + child.tokens, 0);
    }
  };
  settle();
  const estimated = parts.reduce((sum, part) => sum + part.tokens, 0);
  // Scaled to the footer's figure even when it is itself an estimate, so the two agree.
  let tokens = input.tokens;
  if (estimated > 0 && tokens > 0) {
    const factor = tokens / estimated;
    const leaves = parts.flatMap((part) => part.children ?? [part]);
    for (const leaf of leaves) leaf.tokens = Math.round(leaf.tokens * factor);
    settle();
    const drift = tokens - parts.reduce((sum, part) => sum + part.tokens, 0);
    const largest = leaves.reduce((a, b) => (b.tokens > a.tokens ? b : a));
    largest.tokens += drift;
    settle();
  } else {
    tokens = Math.max(tokens, estimated);
  }
  return {
    tokens,
    window: input.window,
    reported: input.reported && tokens > 0,
    autoCompactAt: input.autoCompactAt,
    parts,
  };
}
