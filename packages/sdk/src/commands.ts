import { findModel, listModels } from "@mu/ai";
import { type Command, CommandRegistry, customMessage } from "@mu/core";

// Built-in commands available on every surface (TUI, RPC, headless).
export function coreCommands(): Command[] {
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
      run: (ctx) => {
        // Full compaction lands in M7; this wires the command end-to-end so the
        // surfaces can call it today.
        ctx.inject(
          customMessage(
            "system-reminder",
            "The user requested compaction. Summarize the conversation so far, preserving decisions, task state and open threads.",
          ),
        );
        return { handled: true, message: "Compaction requested (summary pass runs in M7)." };
      },
    },
    {
      name: "cost",
      description: "Show token usage and cost for this session",
      run: (ctx) => {
        ctx.print("Usage is reported by the surface that owns the session.");
        return { handled: true };
      },
    },
  ];
}

export function registryWithCoreCommands(): CommandRegistry {
  const registry = new CommandRegistry();
  for (const command of coreCommands()) registry.register(command);
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
