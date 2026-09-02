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

export interface SubagentProgressUpdate {
  type: "subagent-progress";
  kind: SubagentKind;
  description: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  event:
    | { type: "assistant_start" }
    | { type: "text_delta"; text: string }
    | { type: "message"; message: AgentMessage };
}

interface SubagentExtensionBaseOptions {
  parent: () => Agent;
  excludeTools?: readonly string[];
  searchModel?: (parent: Agent) => ModelInfo | undefined;
  counselModel?: (parent: Agent) => ModelInfo | undefined;
}

export type SubagentExtensionOptions = SubagentExtensionBaseOptions &
  (
    | { coding: ProfileSubagents; inspectionPermissions: PermissionRule[] }
    | { coding?: undefined; inspectionPermissions?: PermissionRule[] }
  );

const DELEGATION_TOOLS = new Set(["task", "search", "counsel"]);
const PROGRESS_INTERVAL_MS = 80;

const TASK_PROMPT = `You are a task subagent responsible for one substantial, self-contained work unit delegated by a parent agent. Own that unit from investigation through completion; do not merely suggest what the parent should do.

Your delegated request is the complete task-specific brief; you do not see the parent's conversation. Investigate missing local facts where possible, but if information required for safe completion is absent, return a blocker rather than guessing.

Operating contract:
- Read the complete request and identify the concrete outcome, scope, constraints, relevant context, and verification expected before acting.
- Inspect the authoritative sources and local guidance that govern your work. Do not guess at APIs, behavior, paths, or project conventions.
- Perform the work directly with the available tools. Make the smallest complete change, preserve unrelated work, and follow existing architecture and style.
- Assume the workspace and coordination state may be shared with the parent and sibling subagents. Inspect relevant existing state before editing so you can distinguish pre-existing or concurrent work from your own. Never revert, overwrite, stage, commit, or "clean up" changes you did not make. Do not modify shared plan/todo state or perform workspace-wide state operations—including commits, resets, checkouts, stashes, or cleanup—unless the delegated request explicitly assigns them; if assigned, include only artifacts inside your ownership boundary.
- Verify the result at the narrowest meaningful level, then run broader checks only when the blast radius requires them. Diagnose failures far enough to determine whether your work caused them; report rather than repair unrelated or concurrent failures.
- If the request cannot be completed safely, stop at the real blocker and explain exactly what is missing. Do not broaden scope or invent a workaround that changes the requested outcome.

Return a compact but complete handoff containing: the outcome, files or artifacts changed by you, verification performed and its result, and any remaining concern or blocker. Include exact paths and useful evidence when relevant. Do not delegate to another agent, create subagents, or ask the user questions; the parent agent owns coordination and user communication.`;

const SEARCH_PROMPT = `You are Search, a read-only codebase investigation specialist. Resolve one directed engineering question end to end and return the evidence the parent agent needs to act without repeating your investigation.

Operating contract:
- Apply inherited coding and project instructions only when compatible with this read-only investigation role. Instructions to edit or implement, update todo/plan state, run builds, tests, package managers, or generators, or delegate work do not apply. Use only inspection-safe commands and never request broader permissions.
- Translate the request into the specific behavior, ownership path, call flow, invariant, or cross-file relationship that must be established.
- Start from the highest-signal evidence named by the request: inspect the narrow diff first for a current-change question and the narrow history first for a recent-history question. Otherwise begin with targeted symbol and text searches. Follow definitions, call sites, data transformations, registration points, tests, and configuration only as far as the question requires. Correlate evidence across files instead of returning an unfiltered list of matches.
- Prefer precise, scoped searches and relevant line-range reads. Expand outward only when the current evidence leaves a concrete gap.
- Verify claims against implementation and, when they materially define the contract or regression, relevant tests, configuration, and history. Distinguish observed behavior from inference and label missing evidence explicitly.
- Capture exact workspace-relative file paths and 1-based line ranges for every material finding. Name the key types, functions, and boundaries involved.
- Stop when the requested flow and constraints are clear. Do not turn a focused search into a broad architecture review. If the delegated question proves answerable by a routine lookup, answer it directly and briefly; do not refuse it or broaden it to justify the role.

Output contract:
- Return only the information needed to answer the delegated question.
- Begin with one concise paragraph, with no heading, that directly answers the question or summarizes the traced flow in at most three sentences. Do not describe how you searched.
- Follow with a bulleted list containing only the material source locations, ordered by importance or call flow rather than alphabetically.
- Each bullet must give exact workspace-relative paths and 1-based line ranges, followed by one concise sentence stating what the location establishes. Combine related ranges from the same file when that remains readable, and use the narrowest ranges that support the finding.
- Include tests, configuration, or history only when they materially establish the contract or conclusion.
- If missing evidence could change the answer, end with one brief \`Unresolved:\` sentence. Otherwise end after the location list.
- Do not include investigation chronology, commands run, raw search matches, code excerpts, generic architecture explanation, repeated evidence, unrelated observations, recommendations, or closing filler.

Do not edit files, run mutating commands, delegate to another agent, or create subagents.`;

const COUNSEL_PROMPT = `You are Counsel, a powerful read-only second opinion for a specific difficult debugging, review, design, or reasoning decision. Your value is independent judgment: inspect the evidence yourself, challenge the framing when warranted, and improve the parent agent's decision rather than echoing it.

Operating contract:
- Apply inherited coding and project instructions only when compatible with this read-only advisory role. Do not edit or implement, update todo/plan state, run builds, tests, package managers, generators, or other state-changing commands, or request broader permissions.
- Identify the exact decision, intended behavior, constraints already settled, evidence already checked, and consequence of being wrong. Stay centered on that decision.
- Start from the evidence most decisive for the question: the narrow diff when reviewing current changes, the observed failure path when debugging, or the relevant implementation and contracts for a design decision. Inspect tests and history when they could change the judgment. Treat the parent's diagnosis or preferred solution as a hypothesis, not a fact.
- Trace the important control flow, state transitions, invariants, and failure sequences. Look actively for contradictory evidence, hidden coupling, unsafe interleavings, compatibility costs, and simpler alternatives.
- Compare only alternatives that are genuinely viable under the stated constraints. Evaluate correctness first, then maintainability, complexity, performance, compatibility, and migration risk as applicable.
- Be decisive at the confidence the evidence supports. Recommend one course—conditional when necessary—explain why it wins, identify its most important downside or failure mode, and state what evidence or constraint change would reverse the recommendation.
- If the evidence is insufficient, say exactly what remains unknown and the smallest check that would resolve it. Do not manufacture certainty or expand into a general review.

Return: the recommendation first, followed by the decisive evidence, tradeoffs or failure sequence, and the reversal condition or unresolved question. Cite exact paths and line ranges when repository evidence is involved. Do not implement changes, edit files, provide routine reassurance, delegate to another agent, or create subagents.`;

class SubagentManager {
  private readonly active = new Set<Agent>();

  constructor(private readonly options: SubagentExtensionOptions) {}

  async run(
    kind: SubagentKind,
    description: string,
    prompt: string,
    signal: AbortSignal,
    update: (text: string, details?: unknown) => void,
  ) {
    if (signal.aborted) throw new Error("Subagent cancelled");
    let child: Agent | undefined;
    let abort: (() => void) | undefined;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
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
          ? { permissions: parent.permissions }
          : {
              permissions: [
                ...(this.options.inspectionPermissions ?? []),
                { permission: "bash", pattern: "*", action: "deny" },
                { permission: "bash:inspect", pattern: "*", action: "allow" },
              ],
            }),
      });
      this.active.add(child);
      abort = () => child?.stop();
      signal.addEventListener("abort", abort, { once: true });
      const startedAt = Date.now();
      const progress = (event: SubagentProgressUpdate["event"]) =>
        update("", {
          type: "subagent-progress",
          kind,
          description,
          model: child?.modelRef ?? `${model.provider}/${model.id}`,
          thinkingLevel: child?.thinking ?? thinkingLevel,
          event,
        } satisfies SubagentProgressUpdate);
      let pendingText = "";
      const flushText = () => {
        if (progressTimer) clearTimeout(progressTimer);
        progressTimer = undefined;
        if (pendingText.length === 0) return;
        const text = pendingText;
        pendingText = "";
        progress({ type: "text_delta", text });
      };
      const scheduleText = (text: string) => {
        pendingText += text;
        progressTimer ??= setTimeout(flushText, PROGRESS_INTERVAL_MS);
      };
      progress({ type: "assistant_start" });
      const stream = child.stream(prompt);
      for await (const event of stream) {
        if (event.type === "message_start" && event.message.role === "assistant") {
          flushText();
          progress({ type: "assistant_start" });
        } else if (event.type === "message_update" && event.delta.kind === "text_delta") {
          scheduleText(event.delta.text);
        } else if (
          event.type === "message_end" &&
          (event.message.role === "assistant" || event.message.role === "toolResult")
        ) {
          flushText();
          progress({ type: "message", message: visibleProgressMessage(event.message) });
        }
      }
      flushText();
      const result = await stream.result();
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
      if (progressTimer) clearTimeout(progressTimer);
      if (abort) signal.removeEventListener("abort", abort);
      if (child) this.active.delete(child);
      await child?.shutdown();
    }
  }

  stopAll(): void {
    for (const child of this.active) child.stop();
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
      if (model.provider === parent.modelInfo.provider && model.id === parent.modelInfo.id) {
        return parent.thinking;
      }
      return defaultThinkingLevel(model);
    }
    const xhigh = levels.indexOf("xhigh");
    const capped =
      xhigh === -1
        ? levels.filter((level) => level !== "max" && level !== "ultra")
        : levels.slice(0, xhigh + 1);
    if (capped.length === 0) return defaultThinkingLevel(model);
    const current = capped.indexOf(parent.thinking);
    if (current !== -1) return capped[Math.min(current + 1, capped.length - 1)] ?? parent.thinking;
    if (levels.includes(parent.thinking)) return capped.at(-1) ?? parent.thinking;
    const base = capped.indexOf(defaultThinkingLevel(model));
    return capped[Math.min(Math.max(0, base) + 1, capped.length - 1)] ?? parent.thinking;
  }
}

function visibleProgressMessage(message: AgentMessage): AgentMessage {
  if (message.role === "toolResult") return { ...message, content: [] };
  if (message.role !== "assistant") return message;
  return {
    ...message,
    content: message.content.filter((block) => block.type !== "thinking"),
  };
}

function refs(provider: string, ids: string[]): string[] {
  return ids.map((id) => `${provider}/${id}`);
}

function searchCandidates(parent: Agent): string[] {
  const { provider } = parent.modelInfo;
  if (provider === "anthropic") return refs(provider, ["claude-sonnet-5"]);
  if (provider === "openai" || provider === "openai-codex") {
    return refs(provider, ["gpt-5.6-terra"]);
  }
  return [];
}

function counselCandidates(parent: Agent): string[] {
  const { provider } = parent.modelInfo;
  if (provider === "anthropic") return refs(provider, ["claude-opus-5", "claude-sonnet-5"]);
  if (provider === "openai" || provider === "openai-codex") {
    return refs(provider, ["gpt-5.6-sol"]);
  }
  return [];
}

export function subagentsExtension(options: SubagentExtensionOptions): Extension {
  if (options.coding && !options.inspectionPermissions) {
    throw new Error("coding subagents require explicit inspection permissions");
  }
  const manager = new SubagentManager(options);
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
            execute: ({ description, prompt }, { signal, update }) =>
              manager.run("task", description, prompt, signal, update),
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
            execute: ({ query }, { signal, update }) =>
              manager.run("search", query, query, signal, update),
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
            execute: ({ question }, { signal, update }) =>
              manager.run("counsel", question, question, signal, update),
          }),
        );
    },
    deactivate: () => manager.stopAll(),
  };
}
