import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyTool, exitNotification, ProcessManager } from "@mu/core";
import { codingProfile } from "./index.ts";
import { shellSpawner } from "./tools/tasks.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-tasks-"));
}

const signal = new AbortController().signal;

function run(tool: unknown, args: Record<string, unknown>) {
  return (tool as AnyTool).execute("t1", args, signal);
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

function toolsOf(profile: Awaited<ReturnType<typeof codingProfile>>) {
  return new Map(profile.toolset.map((t) => [t.name, t]));
}

describe("task tools", () => {
  test("the profile ships the background-task toolset", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const names = profile.toolset.map((t) => t.name);
    for (const name of ["task_output", "task_write_stdin", "task_kill", "task_list"]) {
      expect(names).toContain(name);
    }
  });

  test("bash run_in_background returns a task id immediately", async () => {
    const root = await scratch();
    const profile = await codingProfile({ root });
    const bash = toolsOf(profile).get("bash");

    const result = await run(bash, { command: "sleep 5", run_in_background: true });
    const details = result.details as { taskId: string; background: boolean };
    expect(details.background).toBe(true);
    expect(details.taskId).toStartWith("task_");
    expect(textOf(result)).toContain("background");

    profile.processes.killAll();
  });

  test("task_list reports started tasks", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const tools = toolsOf(profile);
    await run(tools.get("bash"), { command: "sleep 5", run_in_background: true });

    const listed = await run(tools.get("task_list"), {});
    expect(textOf(listed)).toContain("sleep 5");
    expect(textOf(listed)).toContain("running");

    profile.processes.killAll();
  });

  test("task_output and task_kill operate on a real process", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const tools = toolsOf(profile);

    const started = await run(tools.get("bash"), {
      command: "echo hello-from-background; sleep 5",
      run_in_background: true,
    });
    const taskId = (started.details as { taskId: string }).taskId;

    await Bun.sleep(300);
    const output = await run(tools.get("task_output"), { taskId });
    expect(textOf(output)).toContain("hello-from-background");

    const killed = await run(tools.get("task_kill"), { taskId });
    expect(textOf(killed)).toContain("Killed");
  });

  test("task_write_stdin drives an interactive process", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const tools = toolsOf(profile);

    // `cat` echoes whatever is written to its stdin — a stand-in for a REPL.
    const started = await run(tools.get("bash"), { command: "cat", run_in_background: true });
    const taskId = (started.details as { taskId: string }).taskId;

    await run(tools.get("task_write_stdin"), { taskId, data: "ping\n" });
    await Bun.sleep(300);

    const output = await run(tools.get("task_output"), { taskId });
    expect(textOf(output)).toContain("ping");

    await run(tools.get("task_kill"), { taskId });
  });

  test("a task that exits reports its status and code", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const tools = toolsOf(profile);

    const started = await run(tools.get("bash"), {
      command: "echo done; exit 3",
      run_in_background: true,
    });
    const taskId = (started.details as { taskId: string }).taskId;

    await Bun.sleep(400);
    const output = await run(tools.get("task_output"), { taskId });
    expect(textOf(output)).toContain("done");
    expect(textOf(output)).toContain("exit 3");
  });

  test("unknown task ids are errors, not crashes", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const tools = toolsOf(profile);
    for (const name of ["task_output", "task_kill"]) {
      const result = await run(tools.get(name), { taskId: "task_999" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("No such task");
    }
  });

  test("session exit kills owned processes by default", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const tools = toolsOf(profile);
    await run(tools.get("bash"), { command: "sleep 30", run_in_background: true });
    expect(profile.processes.runningCount).toBe(1);

    // What a surface calls when the session ends.
    profile.processes.killAll();
    expect(profile.processes.runningCount).toBe(0);
  });
});

describe("exit wakes an idle agent", () => {
  test("an exit produces a follow-up notification naming the task", async () => {
    const notifications: string[] = [];
    const manager = new ProcessManager(shellSpawner(await scratch()), {
      onExited: (task) => notifications.push(exitNotification(task)),
    });

    manager.start("exit 0");
    await Bun.sleep(400);

    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("finished successfully");
    expect(notifications[0]).toContain("task_output");
  });
});

describe("killing a task terminates its descendants", () => {
  test("a grandchild process does not survive task_kill", async () => {
    const root = await scratch();
    const marker = join(root, "alive.txt");
    const manager = new ProcessManager(shellSpawner(root));

    // The shell starts a background loop that keeps touching a file. If the
    // descendant survives the kill, the file keeps changing afterwards.
    const task = manager.start(
      `bash -c 'while true; do date +%s%N > ${marker}; sleep 0.05; done' & wait`,
    );
    await Bun.sleep(400);
    expect(manager.get(task.id)?.status).toBe("running");

    manager.kill(task.id);
    await Bun.sleep(300);

    const first = await readFile(marker, "utf8").catch(() => "");
    await Bun.sleep(400);
    const second = await readFile(marker, "utf8").catch(() => "");

    // No further writes means the whole tree is gone.
    expect(second).toBe(first);
  });

  test("killAll also takes descendants with it", async () => {
    const root = await scratch();
    const marker = join(root, "alive2.txt");
    const manager = new ProcessManager(shellSpawner(root));
    manager.start(`bash -c 'while true; do date +%s%N > ${marker}; sleep 0.05; done' & wait`);
    await Bun.sleep(400);

    manager.killAll();
    await Bun.sleep(300);

    const first = await readFile(marker, "utf8").catch(() => "");
    await Bun.sleep(400);
    expect(await readFile(marker, "utf8").catch(() => "")).toBe(first);
  });
});
