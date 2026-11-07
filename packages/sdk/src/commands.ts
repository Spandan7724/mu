import { type CheckpointDiffFile, type Command, CommandRegistry } from "@mu/core";
import type {
  CheckpointActionResult,
  ForkPoint,
  ForkResult,
  ManualCompactionResult,
  UndoPoint,
} from "./agent.ts";
import type { CostReport } from "./cost-report.ts";

export type { ForkPoint } from "./agent.ts";

export interface ForkPointsCommandData {
  kind: "fork-points";
  points: ForkPoint[];
}

// The fork is a new saved session; the surface decides whether to open it.
export interface ForkedCommandData {
  kind: "forked";
  sessionId: string;
  sourceSessionId: string;
  prompt?: string;
}

export interface DiffCommandData {
  kind: "diff";
  files: CheckpointDiffFile[];
}

export interface UndoPointsCommandData {
  kind: "undo-points";
  points: UndoPoint[];
}

// Built-in commands available on every surface (TUI, RPC, headless).
export interface CoreCommandHooks {
  requestCompaction?: (
    focus?: string,
  ) => ManualCompactionResult | undefined | Promise<ManualCompactionResult | undefined>;
  costReport?: () => CostReport;
  undo?: (turnCount?: number) => Promise<CheckpointActionResult>;
  undoPoints?: () => UndoPoint[];
  redo?: () => Promise<CheckpointActionResult>;
  // Without an entry the fork copies the whole branch.
  fork?: (beforeEntryId?: string) => Promise<ForkResult>;
  forkPoints?: () => ForkPoint[];
  diff?: () => Promise<CheckpointDiffFile[]>;
  // Answers /undo, /redo and /diff when checkpoints are off.
  checkpointUnavailable?: string;
}

export function coreCommands(hooks: CoreCommandHooks = {}): Command[] {
  return [
    {
      name: "help",
      description: "List available commands",
      side: true,
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
        try {
          // The surface owns model resolution because it may have extension models
          // that are intentionally absent from the process-wide catalog.
          ctx.setModel(target);
        } catch (error) {
          return {
            handled: true,
            message: error instanceof Error ? error.message : String(error),
          };
        }
        return { handled: true, message: `Model set to ${ctx.getModel()}` };
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
      description: "Choose prompts to revert — both the workspace and the conversation",
      run: async (ctx) => {
        if (hooks.checkpointUnavailable)
          return { handled: true, message: hooks.checkpointUnavailable };
        if (!hooks.undo) return { handled: true, message: "Undo is not available here." };
        const count = ctx.args.trim();
        if (!count && hooks.undoPoints) {
          const points = hooks.undoPoints();
          if (points.length === 0) return { handled: true, message: "Nothing to undo." };
          return {
            handled: true,
            data: { kind: "undo-points", points } satisfies UndoPointsCommandData,
          };
        }
        if (count && !/^[1-9]\d*$/.test(count)) {
          return { handled: true, message: "Usage: /undo [positive prompt count]" };
        }
        const result = await hooks.undo(count ? Number(count) : 1);
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
        if (hooks.checkpointUnavailable)
          return { handled: true, message: hooks.checkpointUnavailable };
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
      description: "Start a new session from an earlier prompt or from here",
      run: async (ctx) => {
        if (!hooks.fork) return { handled: true, message: "Fork is not available here." };
        const target = ctx.args.trim();
        if (!target) {
          const points = hooks.forkPoints?.() ?? [];
          if (points.length === 0) return { handled: true, message: "Nothing to fork yet." };
          const data: ForkPointsCommandData = { kind: "fork-points", points };
          return {
            handled: true,
            message: [
              "here · the whole conversation",
              ...points.map(
                (point) => `${point.id} · before: ${point.prompt.replace(/\s+/g, " ").trim()}`,
              ),
            ].join("\n"),
            data,
          };
        }
        const result = await hooks.fork(target === "here" ? undefined : target);
        if (!result.ok || !result.sessionId || !result.sourceSessionId) {
          return { handled: true, message: result.message };
        }
        const data: ForkedCommandData = {
          kind: "forked",
          sessionId: result.sessionId,
          sourceSessionId: result.sourceSessionId,
          ...(result.prompt !== undefined ? { prompt: result.prompt } : {}),
        };
        return { handled: true, message: result.message, data };
      },
    },
    {
      name: "diff",
      description: "Show everything this session has changed",
      side: true,
      run: async () => {
        if (hooks.checkpointUnavailable)
          return { handled: true, message: hooks.checkpointUnavailable };
        if (!hooks.diff) return { handled: true, message: "Diff is not available here." };
        let files: CheckpointDiffFile[];
        try {
          files = await hooks.diff();
        } catch (error) {
          return {
            handled: true,
            message: `Could not show the diff: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        if (files.length === 0) return { handled: true, message: "No changes yet." };
        return { handled: true, data: { kind: "diff", files } satisfies DiffCommandData };
      },
    },
    {
      name: "cost",
      description: "Show token usage, cost and what fills the context",
      run: () => {
        const report = hooks.costReport?.();
        return report
          ? { handled: true, data: report }
          : { handled: true, message: "Usage is reported by the surface that owns the session." };
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
    side: true,
    run: (ctx) => {
      const lines = registry.list().map((c) => `  /${c.name.padEnd(12)} ${c.description}`);
      ctx.print(`Available commands:\n${lines.join("\n")}`);
      return { handled: true };
    },
  });
  return registry;
}
