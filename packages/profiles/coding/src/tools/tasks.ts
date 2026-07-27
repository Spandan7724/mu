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
  return ({ command, onOutput }): ManagedProcessHandle => {
    // `setsid` puts the task in its own process group so kill() can signal the
    // whole tree. Without it a shell's children outlive task_kill.
    const proc = Bun.spawn(["setsid", "bash", "-c", command], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });

    const pump = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const decoder = new TextDecoder();
      for await (const chunk of stream) onOutput(decoder.decode(chunk));
    };
    void pump(proc.stdout as ReadableStream<Uint8Array>);
    void pump(proc.stderr as ReadableStream<Uint8Array>);

    return {
      write: (data) => {
        proc.stdin?.write(data);
        proc.stdin?.flush?.();
      },
      kill: () => {
        // Negative pid signals the group; fall back to the process itself if
        // the platform or spawn did not give us a group leader.
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch {
          proc.kill();
        }
      },
      exited: proc.exited.then((code) => code ?? null),
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
            `${task.id} · ${task.status}${task.exitCode !== null ? ` (exit ${task.exitCode})` : ""} · ${task.command}`,
        )
        .join("\n");
    },
  });

  return [taskOutput, taskWriteStdin, taskKill, taskList];
}
