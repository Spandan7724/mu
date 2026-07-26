import { errorResult, type ProcessManager, type ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { truncateOutput, withNotice } from "../truncate.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export interface BashDeps {
  root: string;
  // When present, `run_in_background: true` hands the command to it.
  processes?: ProcessManager;
  // Injectable so tests never spawn real processes.
  spawn?: (
    command: string,
    cwd: string,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
}

async function defaultSpawn(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const onAbort = () => proc.kill();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export function bashTool(deps: BashDeps) {
  const spawn = deps.spawn ?? defaultSpawn;
  return tool({
    name: "bash",
    description:
      "Run a shell command in the session root. Use for building, testing and inspecting the project. Prefer the dedicated read/edit/grep/glob tools for file work.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to run"),
      description: z
        .string()
        .optional()
        .describe("A short description of what this command does, for the user"),
      timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
      run_in_background: z
        .boolean()
        .optional()
        .describe("Start the command in the background and return a task id immediately"),
    }),
    execute: async (
      { command, timeoutMs, run_in_background },
      { signal },
    ): Promise<ToolResult | string> => {
      if (signal.aborted) return errorResult("Aborted before the command started.");

      if (run_in_background) {
        if (!deps.processes) {
          return errorResult("Background execution is not available in this session.");
        }
        const task = deps.processes.start(command);
        return {
          content: [
            {
              type: "text",
              text: `Started ${task.id} in the background. Use task_output to read it, task_kill to stop it.`,
            },
          ],
          details: { taskId: task.id, command, background: true },
        };
      }

      const result = await spawn(command, deps.root, signal, timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const parts: string[] = [];
      if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
      if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
      const body = withNotice(
        truncateOutput(parts.join("\n\n") || "(no output)"),
        "command produced a lot of output",
      );

      if (result.timedOut) {
        return {
          content: [{ type: "text", text: `${body}\n\n[command timed out and was killed]` }],
          details: { command, exitCode: result.exitCode, timedOut: true },
          isError: true,
        };
      }

      const failed = result.exitCode !== 0;
      return {
        content: [
          {
            type: "text",
            text: failed ? `${body}\n\n[exit code ${result.exitCode}]` : body,
          },
        ],
        details: { command, exitCode: result.exitCode },
        isError: failed,
      };
    },
  });
}
