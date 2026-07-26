import { findModel, listModels } from "@mu/ai";
import { type Command, CommandRegistry } from "@mu/core";

// Built-in commands available on every surface (TUI, RPC, headless).
export interface CoreCommandHooks {
  requestCompaction?: () => void;
  usage?: () => { costUsd: number; contextPercent: number };
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
