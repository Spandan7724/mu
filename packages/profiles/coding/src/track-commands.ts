import type { Command, CommandContext, CommandResult } from "@mu/core";
import type { ShadowCheckpointProvider } from "./checkpoint.ts";
import { saveCheckpointIncludes } from "./permissions.ts";

export interface TrackCommandOptions {
  root: string;
  checkpoints?: ShadowCheckpointProvider;
  unavailable?: string;
  save?: (root: string, include: string[]) => Promise<void>;
}

function argumentPath(args: string): string {
  const trimmed = args.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted?.[2] ?? trimmed;
}

function listMessage(paths: string[]): string {
  if (paths.length === 0) {
    return "No extra paths are included in checkpoints. /track <path> adds an ignored file or folder.";
  }
  return ["Also included in checkpoints:", ...paths.map((path) => `  ${path}`)].join("\n");
}

export function trackCommands(options: TrackCommandOptions): Command[] {
  const save = options.save ?? saveCheckpointIncludes;

  const change = async (
    ctx: CommandContext,
    update: (paths: string[], path: string) => string[] | string,
    done: (path: string) => string,
  ): Promise<CommandResult> => {
    const checkpoints = options.checkpoints;
    if (!checkpoints) {
      return { handled: true, message: options.unavailable ?? "Checkpoints are off here." };
    }
    if (ctx.isRunning?.()) {
      // Mid-turn, the path would read as created by this turn, and undoing the
      // turn would delete it.
      return {
        handled: true,
        message: "Wait for the run to finish before changing what checkpoints include.",
      };
    }
    let path: string;
    try {
      path = checkpoints.workspacePath(argumentPath(ctx.args));
    } catch (error) {
      return { handled: true, message: error instanceof Error ? error.message : String(error) };
    }
    const next = update(checkpoints.includedPaths, path);
    if (typeof next === "string") return { handled: true, message: next };
    try {
      await save(options.root, [...new Set(next)].sort());
    } catch (error) {
      return {
        handled: true,
        message: `Could not save checkpoint paths: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    checkpoints.setIncludedPaths(next);
    return { handled: true, message: done(path) };
  };

  return [
    {
      name: "track",
      description: "Include an ignored file or folder in /undo and /redo, or list included paths",
      sessionScoped: true,
      run: (ctx) => {
        if (!ctx.args.trim()) {
          return {
            handled: true,
            message: options.checkpoints
              ? listMessage(options.checkpoints.includedPaths)
              : (options.unavailable ?? "Checkpoints are off here."),
          };
        }
        return change(
          ctx,
          (paths, path) =>
            paths.includes(path) ? `${path} is already included in checkpoints.` : [...paths, path],
          (path) => `${path} is included in checkpoints from the next prompt.`,
        );
      },
    },
    {
      name: "untrack",
      description: "Stop including a path added with /track",
      sessionScoped: true,
      run: (ctx) => {
        if (!ctx.args.trim()) return { handled: true, message: "Usage: /untrack <path>" };
        return change(
          ctx,
          (paths, path) =>
            paths.includes(path)
              ? paths.filter((candidate) => candidate !== path)
              : `${path} was not added with /track.`,
          (path) => `${path} is no longer included in checkpoints.`,
        );
      },
    },
  ];
}
