import {
  defaultThinkingLevel,
  type ModelInfo,
  supportedThinkingLevels,
  type ThinkingLevel,
  type Usage,
} from "@mu/ai";
import type { AgentMessage, AnyTool, Extension, PermissionRule, ProfileSubagents } from "@mu/core";
import { z } from "zod";
import type { Agent, HaltReason } from "./agent.ts";
import { tool } from "./tool.ts";

export type SubagentKind = "task" | "search" | "counsel";

export interface SubagentDetails {
  type: "subagent";
  kind: SubagentKind;
  description: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  durationMs: number;
  messages: AgentMessage[];
  usage: Usage;
  reason: HaltReason;
}

export interface SubagentExtensionOptions {
  parent: () => Agent;
  coding?: ProfileSubagents;
  inspectionPermissions?: PermissionRule[];
  maxConcurrent?: number;
  excludeTools?: readonly string[];
  searchModel?: (parent: Agent) => ModelInfo | undefined;
  counselModel?: (parent: Agent) => ModelInfo | undefined;
}

const DELEGATION_TOOLS = new Set(["task", "search", "counsel"]);

const TASK_PROMPT = `You are a task subagent. Own the self-contained work unit you receive and complete it directly.

Use the available tools to inspect, implement, and verify the work. Stay within the requested scope, preserve unrelated changes, and return a compact but complete report with the outcome, verification, and any blocker. Do not delegate to another agent.`;

const SEARCH_PROMPT = `You are a focused code-search subagent. Investigate one directed engineering question end to end.

Search by behavior and concept, correlate the relevant code paths, and stop when the requested ownership path and constraints are clear. Return exact file paths and 1-based line ranges, key types and functions, and the evidence needed by the parent agent. Do not edit files. Do not use this role for routine exact-symbol or single-file lookups. Do not delegate to another agent.`;

const COUNSEL_PROMPT = `You are counsel: a powerful, read-only second opinion for difficult debugging, review, design, and reasoning decisions.

Independently inspect the relevant evidence, challenge the proposed approach, and give a decisive recommendation with tradeoffs, failure modes, and what evidence would reverse it. Focus only on the question asked. You are slower and more expensive than the main agent, so make the consultation count. Do not implement changes and do not delegate to another agent.`;

class SubagentManager {
  private readonly active = new Set<Agent>();
  private readonly waiters: (() => void)[] = [];
  private running = 0;

  constructor(
    private readonly options: SubagentExtensionOptions,
    private readonly maxConcurrent: number,
  ) {}

  async run(kind: SubagentKind, description: string, prompt: string, signal: AbortSignal) {
    await this.acquire(signal);
    let child: Agent | undefined;
    let abort: (() => void) | undefined;
    try {
      const parent = this.options.parent();
      const model = this.modelFor(kind, parent);
      const thinkingLevel = this.thinkingFor(kind, parent, model);
      const tools = this.toolsFor(kind, parent);
      child = parent.createChild({
        model,
        thinkingLevel,
        systemPrompt: this.promptFor(kind),
        tools,
        ...(kind === "task"
          ? { permissions: parent.permissions, budget: { maxTurns: 12 } }
          : {
              permissions: this.options.inspectionPermissions ?? [],
              budget: { maxTurns: kind === "search" ? 8 : 6 },
            }),
      });
      this.active.add(child);
      abort = () => child?.stop();
      signal.addEventListener("abort", abort, { once: true });
      const startedAt = Date.now();
      const result = await child.run(prompt);
      const details: SubagentDetails = {
        type: "subagent",
        kind,
        description,
        model: child.modelRef,
        thinkingLevel: child.thinking,
        durationMs: Date.now() - startedAt,
        messages: result.messages,
        usage: result.usage,
        reason: result.reason,
      };
      const text = result.text.trim() || `Subagent stopped: ${result.reason}`;
      return {
        content: [{ type: "text" as const, text }],
        details,
        usage: result.usage,
        ...(result.reason === "done" ? {} : { isError: true }),
      };
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
      if (child) this.active.delete(child);
      try {
        await child?.shutdown();
      } finally {
        this.release();
      }
    }
  }

  stopAll(): void {
    for (const child of this.active) child.stop();
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Subagent cancelled");
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", cancelled);
        if (signal.aborted) reject(new Error("Subagent cancelled"));
        else {
          this.running++;
          resolve();
        }
      };
      const cancelled = () => {
        const index = this.waiters.indexOf(ready);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error("Subagent cancelled"));
      };
      this.waiters.push(ready);
      signal.addEventListener("abort", cancelled, { once: true });
    });
  }

  private release(): void {
    this.running--;
    this.waiters.shift()?.();
  }

  private toolsFor(kind: SubagentKind, parent: Agent): AnyTool[] {
    const tools = parent.tools.filter((candidate) => !DELEGATION_TOOLS.has(candidate.name));
    if (kind === "task") return tools;
    const allowed = new Set(this.options.coding?.inspectionTools ?? []);
    return tools.filter((candidate) => allowed.has(candidate.name));
  }

  private promptFor(kind: SubagentKind): string {
    if (kind === "task") return TASK_PROMPT;
    const base = kind === "search" ? SEARCH_PROMPT : COUNSEL_PROMPT;
    const profilePrompt =
      kind === "search" ? this.options.coding?.searchPrompt : this.options.coding?.counselPrompt;
    return [base, profilePrompt?.trim()].filter(Boolean).join("\n\n");
  }

  private modelFor(kind: SubagentKind, parent: Agent): ModelInfo {
    if (kind === "task") return parent.modelInfo;
    const override =
      kind === "search" ? this.options.searchModel?.(parent) : this.options.counselModel?.(parent);
    if (override) return override;
    const candidates = kind === "search" ? searchCandidates(parent) : counselCandidates(parent);
    for (const ref of candidates) {
      const model = parent.availableModel(ref);
      if (model) return model;
    }
    return parent.modelInfo;
  }

  private thinkingFor(kind: SubagentKind, parent: Agent, model: ModelInfo): ThinkingLevel {
    if (kind === "task") return parent.thinking;
    const levels = supportedThinkingLevels(model);
    if (kind === "search") {
      if (levels.includes("low")) return "low";
      return defaultThinkingLevel(model);
    }
    const current = levels.indexOf(parent.thinking);
    if (current !== -1) return levels[Math.min(current + 1, levels.length - 1)] ?? parent.thinking;
    const base = levels.indexOf(defaultThinkingLevel(model));
    return levels[Math.min(Math.max(0, base) + 1, levels.length - 1)] ?? parent.thinking;
  }
}

function refs(provider: string, ids: string[]): string[] {
  return ids.map((id) => `${provider}/${id}`);
}

function searchCandidates(parent: Agent): string[] {
  const { provider } = parent.modelInfo;
  if (provider === "anthropic") {
    return refs(provider, ["claude-sonnet-5", "claude-haiku-4-5"]);
  }
  if (provider === "google") return refs(provider, ["gemini-2.5-flash", "gemini-2.5-pro"]);
  if (provider === "openai" || provider === "openai-codex") {
    return refs(provider, ["gpt-5.6-terra", "gpt-5-mini", "gpt-5.6-sol"]);
  }
  return [];
}

function counselCandidates(parent: Agent): string[] {
  const { provider } = parent.modelInfo;
  if (provider === "anthropic") return refs(provider, ["claude-opus-5", "claude-sonnet-5"]);
  if (provider === "google") return refs(provider, ["gemini-2.5-pro"]);
  if (provider === "openai" || provider === "openai-codex") {
    return refs(provider, ["gpt-5.6-sol"]);
  }
  return [];
}

export function subagentsExtension(options: SubagentExtensionOptions): Extension {
  const manager = new SubagentManager(options, Math.max(1, options.maxConcurrent ?? 4));
  const excluded = new Set(options.excludeTools ?? []);
  return {
    name: "subagents",
    activate(api) {
      if (!excluded.has("task"))
        api.registerTool(
          tool({
            name: "task",
            description:
              "Delegate a substantial, self-contained work unit to a subagent. Use for independently owned implementation or verification work, especially when several workstreams can proceed concurrently. Do not use for trivial edits or work that depends on another unfinished task. Multiple calls in one turn run concurrently.",
            inputSchema: z.object({
              description: z.string().min(1).describe("A short activity label"),
              prompt: z
                .string()
                .min(1)
                .describe("Complete task, context, constraints, and verification"),
            }),
            isConcurrencySafe: () => true,
            changesState: true,
            execute: ({ description, prompt }, { signal }) =>
              manager.run("task", description, prompt, signal),
          }),
        );
      if (options.coding && !excluded.has("search"))
        api.registerTool(
          tool({
            name: "search",
            description:
              "Delegate a directed, multi-step codebase investigation to a fast read-only search subagent. Use when behavior must be traced across files or several searches correlated. Do not use for routine exact symbols, known paths, or a single grep/read. Returns paths, line ranges, key functions, and constraints.",
            inputSchema: z.object({
              query: z
                .string()
                .min(1)
                .describe("Precise engineering question and required evidence"),
            }),
            isConcurrencySafe: () => true,
            changesState: false,
            execute: ({ query }, { signal }) => manager.run("search", query, query, signal),
          }),
        );
      if (options.coding && !excluded.has("counsel"))
        api.registerTool(
          tool({
            name: "counsel",
            description:
              "Ask a powerful, slower, more expensive read-only second-opinion agent about a difficult debugging, review, architecture, or reasoning decision. Use selectively when independent judgment could materially improve the result, and whenever the user explicitly asks to consult counsel. Do not use for routine editing or reassurance.",
            inputSchema: z.object({
              question: z
                .string()
                .min(1)
                .describe("Focused decision, evidence already checked, and stakes"),
            }),
            isConcurrencySafe: () => true,
            changesState: false,
            execute: ({ question }, { signal }) =>
              manager.run("counsel", question, question, signal),
          }),
        );
    },
    deactivate: () => manager.stopAll(),
  };
}
