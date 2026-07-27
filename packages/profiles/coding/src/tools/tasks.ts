// Background-task tools plus the spawner that binds the kernel's process
// manager to a real shell in the session root.
import {
  errorResult,
  type ManagedProcessHandle,
  type ProcessManager,
  type Spawner,
  type ToolResult,
} from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { truncateOutput, withNotice } from "../truncate.ts";

export function shellSpawner(root: string): Spawner {
  return ({ command, onOutput, cols, rows }): ManagedProcessHandle => {
    const decoder = new TextDecoder();
    let flushed = false;
    let resolveTerminalExit: (() => void) | undefined;
    const terminalExited = new Promise<void>((resolve) => {
      resolveTerminalExit = resolve;
    });

    const flushOutput = () => {
      if (flushed) return;
      flushed = true;
      const final = decoder.decode();
      if (final) onOutput(final);
    };

    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: root,
      detached: true,
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        cols,
        rows,
        data: (_terminal, data) => {
          const text = decoder.decode(data, { stream: true });
          if (text) onOutput(text);
        },
        exit: () => {
          flushOutput();
          resolveTerminalExit?.();
        },
      },
    });

    const terminal = proc.terminal;
    if (!terminal) throw new Error("Could not allocate a pseudo-terminal.");
    const exited = Promise.all([proc.exited, terminalExited]).then(([code]) => {
      flushOutput();
      if (!terminal.closed) terminal.close();
      return code ?? null;
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === "win32") proc.kill(signal);
        else process.kill(-proc.pid, signal);
      } catch {
        proc.kill(signal);
      }
    };

    return {
      write: (data) => void terminal.write(data),
      resize: (nextCols, nextRows) => terminal.resize(nextCols, nextRows),
      detach: () => {
        proc.unref();
        terminal.unref();
      },
      kill: () => {
        signalGroup("SIGTERM");
        killTimer = setTimeout(() => {
          if (proc.exitCode === null) signalGroup("SIGKILL");
        }, 1_000);
        killTimer.unref?.();
      },
      exited: exited.finally(() => {
        if (killTimer) clearTimeout(killTimer);
      }),
    };
  };
}

export function taskTools(manager: ProcessManager) {
  const taskOutput = tool({
    name: "task_output",
    description:
      "Read output from a background task. Returns only what is new since the last read unless full is set.",
    inputSchema: z.object({
      taskId: z.string(),
      full: z.boolean().optional().describe("Return all output rather than only what is new"),
    }),
    isConcurrencySafe: () => true,
    execute: ({ taskId, full }): ToolResult | string => {
      const task = manager.get(taskId);
      if (!task) return errorResult(`No such task: ${taskId}`);
      const output = manager.output(taskId, full ? "start" : "new");
      const status =
        task.status === "running"
          ? "still running"
          : `${task.status}${task.exitCode !== null ? ` (exit ${task.exitCode})` : ""}`;
      const body = output?.text.trim().length ? output.text : "(no new output)";
      return {
        content: [
          {
            type: "text",
            text: `${withNotice(truncateOutput(body), "task output is large")}\n\n[${status}]`,
          },
        ],
        details: { taskId, status: task.status, exitCode: task.exitCode },
      };
    },
  });

  const taskWriteStdin = tool({
    name: "task_write_stdin",
    description:
      "Write to a background task's stdin — use for REPLs and interactive processes. Include a trailing newline to submit a line.",
    inputSchema: z.object({ taskId: z.string(), data: z.string() }),
    execute: ({ taskId, data }): ToolResult | string => {
      if (!manager.get(taskId)) return errorResult(`No such task: ${taskId}`);
      return manager.writeStdin(taskId, data)
        ? `Wrote ${data.length} characters to ${taskId}.`
        : errorResult(`Task ${taskId} is not running.`);
    },
  });

  const taskKill = tool({
    name: "task_kill",
    description: "Stop a background task.",
    inputSchema: z.object({ taskId: z.string() }),
    execute: ({ taskId }): ToolResult | string => {
      if (!manager.get(taskId)) return errorResult(`No such task: ${taskId}`);
      return manager.kill(taskId) ? `Killed ${taskId}.` : `Task ${taskId} had already stopped.`;
    },
  });

  const taskDetach = tool({
    name: "task_detach",
    description:
      "Detach a background task so it is not stopped when the mu session exits. Use only for work that must outlive the session.",
    inputSchema: z.object({ taskId: z.string() }),
    execute: ({ taskId }): ToolResult | string => {
      if (!manager.get(taskId)) return errorResult(`No such task: ${taskId}`);
      return manager.detach(taskId)
        ? `Detached ${taskId}. It will continue after this session exits.`
        : errorResult(`Task ${taskId} is not running or was already detached.`);
    },
  });

  const taskList = tool({
    name: "task_list",
    description: "List background tasks started in this session.",
    inputSchema: z.object({}),
    isConcurrencySafe: () => true,
    execute: (): ToolResult | string => {
      const tasks = manager.list();
      if (tasks.length === 0) return "No background tasks.";
      return tasks
        .map(
          (task) =>
            `${task.id} · ${task.status}${task.detached ? " (detached)" : ""}${task.exitCode !== null ? ` (exit ${task.exitCode})` : ""} · ${task.command}`,
        )
        .join("\n");
    },
  });

  return [taskOutput, taskWriteStdin, taskKill, taskDetach, taskList];
}
