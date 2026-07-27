import { findModel, listModels } from "@mu/ai";
import { type CheckpointDiffFile, type Command, CommandRegistry } from "@mu/core";

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
  requestCompaction?: () => void;
  usage?: () => { costUsd: number; contextPercent: number };
  undo?: () => Promise<{ ok: boolean; message: string }>;
  redo?: () => Promise<{ ok: boolean; message: string }>;
  fork?: (entryId: string) => Promise<{ ok: boolean; message: string }>;
  forkPoints?: () => ForkPoint[];
  diff?: () => Promise<CheckpointDiffFile[]>;
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
      description: "Summarize the conversation so far to free context",
      run: () => {
        if (!hooks.requestCompaction) {
          return { handled: true, message: "Compaction is not available on this surface." };
        }
        hooks.requestCompaction();
        return { handled: true, message: "Compacting before the next turn." };
      },
    },
    {
      name: "undo",
      description: "Revert the last step — both the workspace and the conversation",
      run: async () => {
        if (!hooks.undo) return { handled: true, message: "Undo is not available here." };
        const result = await hooks.undo();
        return { handled: true, message: result.message };
      },
    },
    {
      name: "redo",
      description: "Re-apply the step that was undone",
      run: async () => {
        if (!hooks.redo) return { handled: true, message: "Redo is not available here." };
        const result = await hooks.redo();
        return { handled: true, message: result.message };
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
      run: (ctx) => {
        const usage = hooks.usage?.();
        ctx.print(
          usage
            ? `$${usage.costUsd.toFixed(4)} · ${Math.round(usage.contextPercent * 100)}% ctx`
            : "Usage is reported by the surface that owns the session.",
        );
        return { handled: true };
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
