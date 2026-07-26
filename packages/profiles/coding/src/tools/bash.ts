import { errorResult, type ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { truncateOutput, withNotice } from "../truncate.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export interface BashDeps {
  root: string;
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
    }),
    execute: async ({ command, timeoutMs }, { signal }): Promise<ToolResult | string> => {
      if (signal.aborted) return errorResult("Aborted before the command started.");

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
