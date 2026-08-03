import { findModel, listModels, type Usage } from "@mu/ai";
import { type CheckpointDiffFile, type Command, CommandRegistry } from "@mu/core";
import type { CheckpointActionResult, ManualCompactionResult } from "./agent.ts";

export interface ForkPoint {
  id: string;
  description: string;
}

export interface DiffCommandData {
  kind: "diff";
  files: CheckpointDiffFile[];
}

// Built-in commands available on every surface (TUI, RPC, headless).
export interface CoreCommandHooks {
  requestCompaction?: (
    focus?: string,
  ) => ManualCompactionResult | undefined | Promise<ManualCompactionResult | undefined>;
  usage?: () => Usage & { contextPercent: number };
  undo?: () => Promise<CheckpointActionResult>;
  redo?: () => Promise<CheckpointActionResult>;
  fork?: (entryId: string) => Promise<{ ok: boolean; message: string }>;
  forkPoints?: () => ForkPoint[];
  diff?: () => Promise<CheckpointDiffFile[]>;
}

export function formatUsageBreakdown(usage: Usage & { contextPercent: number }): string {
  const totalTokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const tokens = (value: number) => Math.max(0, Math.trunc(value)).toLocaleString("en-US");
  return [
    "Session usage",
    `  Input tokens:       ${tokens(usage.inputTokens)}`,
    `  Output tokens:      ${tokens(usage.outputTokens)}`,
    `  Cache read tokens:  ${tokens(usage.cacheReadTokens)}`,
    `  Cache write tokens: ${tokens(usage.cacheWriteTokens)}`,
    `  Total tokens:       ${tokens(totalTokens)}`,
    `  Cost:               $${(usage.costUsd ?? 0).toFixed(6)}`,
    `  Active context:     ${(Math.max(0, usage.contextPercent) * 100).toFixed(1)}%`,
  ].join("\n");
}

export function coreCommands(hooks: CoreCommandHooks = {}): Command[] {
  return [
    {
      name: "help",
      description: "List available commands",
      run: (ctx) => {
        ctx.print("Commands are listed by the registry that owns them.");
        return { handled: true };
      },
    },
    {
      name: "model",
      description: "Show or switch the active model",
      run: (ctx) => {
        const target = ctx.args.trim();
        if (!target) {
          ctx.print(`Current model: ${ctx.getModel()}`);
          return { handled: true };
        }
        const model = findModel(target);
        if (!model) {
          const known = listModels()
            .map((m) => `${m.provider}/${m.id}`)
            .join(", ");
          return { handled: true, message: `Unknown model "${target}". Known models: ${known}` };
        }
        ctx.setModel(`${model.provider}/${model.id}`);
        return { handled: true, message: `Model set to ${model.provider}/${model.id}` };
      },
    },
    {
      name: "compact",
      description: "Summarize older context now while preserving recent work: /compact [focus]",
      run: async (ctx) => {
        if (!hooks.requestCompaction) {
          return { handled: true, message: "Compaction is not available on this surface." };
        }
        const result = await hooks.requestCompaction(ctx.args.trim() || undefined);
        if (!result) return { handled: true, message: "Compaction requested." };
        return { handled: true, message: result.message, data: { kind: "compaction", ...result } };
      },
    },
    {
      name: "undo",
      description: "Revert the last step — both the workspace and the conversation",
      run: async () => {
        if (!hooks.undo) return { handled: true, message: "Undo is not available here." };
        const result = await hooks.undo();
        return {
          handled: true,
          message: result.message,
          ...(result.data ? { data: result.data } : {}),
        };
      },
    },
    {
      name: "redo",
      description: "Re-apply the step that was undone",
      run: async () => {
        if (!hooks.redo) return { handled: true, message: "Redo is not available here." };
        const result = await hooks.redo();
        return {
          handled: true,
          message: result.message,
          ...(result.data ? { data: result.data } : {}),
        };
      },
    },
    {
      name: "fork",
      description: "Branch the conversation from an earlier point",
      run: async (ctx) => {
        if (!hooks.fork) return { handled: true, message: "Fork is not available here." };
        const entryId = ctx.args.trim();
        if (!entryId) {
          const points = hooks.forkPoints?.() ?? [];
          if (points.length === 0) return { handled: true, message: "No branch points yet." };
          return {
            handled: true,
            message: points.map((point) => `${point.id} · ${point.description}`).join("\n"),
            data: { kind: "fork-points", points },
          };
        }
        const result = await hooks.fork(entryId);
        return { handled: true, message: result.message };
      },
    },
    {
      name: "diff",
      description: "Show everything this session has changed",
      run: async () => {
        if (!hooks.diff) return { handled: true, message: "Diff is not available here." };
        const files = await hooks.diff();
        if (files.length === 0) return { handled: true, message: "No changes yet." };
        return { handled: true, data: { kind: "diff", files } satisfies DiffCommandData };
      },
    },
    {
      name: "cost",
      description: "Show token usage and cost for this session",
      run: () => {
        const usage = hooks.usage?.();
        return {
          handled: true,
          message: usage
            ? formatUsageBreakdown(usage)
            : "Usage is reported by the surface that owns the session.",
        };
      },
    },
  ];
}

export function registryWithCoreCommands(hooks: CoreCommandHooks = {}): CommandRegistry {
  const registry = new CommandRegistry();
  for (const command of coreCommands(hooks)) registry.register(command);
  registry.register({
    name: "help",
    description: "List available commands",
    run: (ctx) => {
      const lines = registry.list().map((c) => `  /${c.name.padEnd(12)} ${c.description}`);
      ctx.print(`Available commands:\n${lines.join("\n")}`);
      return { handled: true };
    },
  });
  return registry;
}
