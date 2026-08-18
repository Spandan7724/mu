import { errorResult, OutputBuffer, type ProcessManager, type ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { shellCommand, shellEnv, terminateProcessTree } from "../shell.ts";
import { isInspectionShellCommand, isSingleRipgrepCommand } from "../shell-inspection.ts";
import { truncateOutput, withNotice } from "../truncate.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const STREAM_UPDATE_INTERVAL_MS = 80;
const TERMINATION_GRACE_MS = 1_000;

type OutputStream = "stdout" | "stderr";
type OutputChunk = (text: string, stream: OutputStream) => void;

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

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
    onOutput?: OutputChunk,
  ) => Promise<SpawnResult>;
}

async function readProcessStream(
  stream: ReadableStream<Uint8Array>,
  kind: OutputStream,
  onOutput?: OutputChunk,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const output = new OutputBuffer();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (!text) continue;
    output.append(text);
    onOutput?.(text, kind);
  }

  const final = decoder.decode();
  if (final) {
    output.append(final);
    onOutput?.(final, kind);
  }
  return output.read();
}

async function defaultSpawn(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  onOutput?: OutputChunk,
): Promise<SpawnResult> {
  const proc = Bun.spawn(shellCommand(command), {
    cwd,
    // `detached` creates the POSIX process group used by
    // terminateProcessTree. Windows taskkill can walk descendants directly,
    // and this foreground command never needs to outlive mu.
    detached: process.platform !== "win32",
    env: shellEnv(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
  });

  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    terminateProcessTree(proc, "SIGTERM");
    escalation ??= setTimeout(() => terminateProcessTree(proc, "SIGKILL"), TERMINATION_GRACE_MS);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const onAbort = terminate;
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readProcessStream(proc.stdout, "stdout", onOutput),
      readProcessStream(proc.stderr, "stderr", onOutput),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut };
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    signal.removeEventListener("abort", onAbort);
  }
}

function streamingUpdates(update: (text: string) => void) {
  let buffered = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stderrStarted = false;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!buffered) return;
    update(buffered);
    buffered = "";
  };

  return {
    push(text: string, stream: OutputStream) {
      if (stream === "stderr" && !stderrStarted) {
        buffered += `${buffered.endsWith("\n") || buffered.length === 0 ? "" : "\n"}[stderr]\n`;
        stderrStarted = true;
      }
      buffered += text;
      timer ??= setTimeout(flush, STREAM_UPDATE_INTERVAL_MS);
    },
    flush,
  };
}

export function bashTool(deps: BashDeps) {
  const spawn = deps.spawn ?? defaultSpawn;
  return tool({
    name: "bash",
    changesState: ({ command, run_in_background }) =>
      run_in_background === true || !isInspectionShellCommand(command),
    isConcurrencySafe: ({ command, run_in_background }) =>
      run_in_background !== true && isInspectionShellCommand(command),
    permissionScope: ({ command, run_in_background }) =>
      run_in_background !== true && isInspectionShellCommand(command) ? "bash:inspect" : "bash",
    permissionPattern: ({ command }) => command,
    description:
      "Run a command with the platform-native shell in the session root. For repository exploration, batch read-only inspection and narrow before reading. Keep searches inspection-safe: do not add printf/echo headings, pipe to sort, or redirect stderr; use rg --sort path, --no-messages, and repeated -e arguments. Keep each pattern simply quoted and never splice quote characters inside a shell regex. Read only relevant line ranges unless full context is needed. Use write/edit tools for file changes.",
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
      { signal, update },
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

      const startedAt = Date.now();
      const live = streamingUpdates(update);
      let result: SpawnResult;
      try {
        result = await spawn(
          command,
          deps.root,
          signal,
          timeoutMs ?? DEFAULT_TIMEOUT_MS,
          live.push,
        );
      } finally {
        live.flush();
      }
      const durationMs = Date.now() - startedAt;

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
          details: { command, exitCode: result.exitCode, timedOut: true, durationMs },
          isError: true,
        };
      }

      if (result.exitCode === 1 && isSingleRipgrepCommand(command)) {
        return {
          content: [
            {
              type: "text",
              text: parts.length > 0 ? `${body}\n\n[no matches]` : "No matches",
            },
          ],
          details: { command, exitCode: result.exitCode, noMatches: true, durationMs },
          isError: false,
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
        details: { command, exitCode: result.exitCode, durationMs },
        isError: failed,
      };
    },
  });
}
