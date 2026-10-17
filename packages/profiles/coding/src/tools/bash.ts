import {
  errorResult,
  type ManagedProcessHandle,
  OutputBuffer,
  type ProcessManager,
  type ToolResult,
} from "@mu/core";
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
  // The process was handed over through BackgroundHandOff and is still running.
  backgrounded?: boolean;
}

export interface BackgroundHandOff {
  // Fires when the user moves the running command to the background.
  signal: AbortSignal;
  // The spawner has released its timeout and abort handling; the returned sink
  // receives everything the process prints from now on.
  adopt: (handle: ManagedProcessHandle) => (chunk: string) => void;
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
    background?: BackgroundHandOff,
  ) => Promise<SpawnResult>;
}

async function readProcessStream(
  stream: ReadableStream<Uint8Array>,
  kind: OutputStream,
  onOutput?: OutputChunk | undefined,
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
  background?: BackgroundHandOff,
): Promise<SpawnResult> {
  const proc = Bun.spawn(shellCommand(command), {
    cwd,
    // `detached` creates the POSIX process group used by
    // terminateProcessTree. Windows taskkill can walk descendants directly.
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

  let sink: OutputChunk | undefined = onOutput;
  const forward: OutputChunk = (text, stream) => sink?.(text, stream);
  const finished = Promise.all([
    readProcessStream(proc.stdout, "stdout", forward),
    readProcessStream(proc.stderr, "stderr", forward),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]): SpawnResult => ({ stdout, stderr, exitCode, timedOut }));

  let onBackground: (() => void) | undefined;
  const moved = new Promise<SpawnResult>((resolve) => {
    if (!background) return;
    onBackground = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const adopted = background.adopt({
        acceptsInput: false,
        write: () => {},
        resize: () => {},
        detach: () => {},
        kill: terminate,
        exited: finished.then((result) => result.exitCode),
      });
      sink = (text) => adopted(text);
      resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, backgrounded: true });
    };
    if (background.signal.aborted) onBackground();
    else background.signal.addEventListener("abort", onBackground, { once: true });
  });

  try {
    return await Promise.race([finished, moved]);
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    signal.removeEventListener("abort", onAbort);
    if (onBackground) background?.signal.removeEventListener("abort", onBackground);
  }
}

function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
    canBackground: ({ run_in_background }) =>
      run_in_background !== true && deps.processes !== undefined,
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
      { signal, update, background },
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
      const printed = new OutputBuffer();
      const processes = deps.processes;
      let movedTo: string | undefined;
      let result: SpawnResult;
      try {
        result = await spawn(
          command,
          deps.root,
          signal,
          timeoutMs ?? DEFAULT_TIMEOUT_MS,
          (text, stream) => {
            printed.append(text);
            live.push(text, stream);
          },
          processes
            ? {
                signal: background,
                adopt: (handle) => {
                  const adopted = processes.adopt(command, handle, {
                    startedAt,
                    output: printed.read(),
                  });
                  movedTo = adopted.task.id;
                  return adopted.onOutput;
                },
              }
            : undefined,
        );
      } finally {
        live.flush();
      }
      const durationMs = Date.now() - startedAt;

      if (result.backgrounded && movedTo) {
        const sofar = printed.read().trimEnd();
        const body = sofar
          ? `\n\nOutput so far:\n${withNotice(truncateOutput(sofar), "command produced a lot of output")}`
          : "";
        return {
          content: [
            {
              type: "text",
              text: `The user moved this command to the background as ${movedTo} after ${formatSeconds(durationMs)}; it is still running. You will be notified when it exits. Use task_output to read it, task_kill to stop it.${body}`,
            },
          ],
          details: { taskId: movedTo, command, background: true, movedAfterMs: durationMs },
        };
      }

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
