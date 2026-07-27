import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyTool, exitNotification, ProcessManager } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent, optionsFromProfile } from "mu";
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
    for (const name of [
      "task_output",
      "task_write_stdin",
      "task_kill",
      "task_detach",
      "task_list",
    ]) {
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

    await profile.processes.killAll();
  });

  test("task_list reports started tasks", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const tools = toolsOf(profile);
    await run(tools.get("bash"), { command: "sleep 5", run_in_background: true });

    const listed = await run(tools.get("task_list"), {});
    expect(textOf(listed)).toContain("sleep 5");
    expect(textOf(listed)).toContain("running");

    await profile.processes.killAll();
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
    await profile.processes.wait(taskId);
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
    await profile.processes.wait(taskId);
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
    await profile.processes.killAll();
    expect(profile.processes.runningCount).toBe(0);
  });

  test("task_detach is the explicit session-cleanup escape hatch", async () => {
    const root = await scratch();
    const marker = join(root, "detached.txt");
    const profile = await codingProfile({ root });
    const tools = toolsOf(profile);
    const started = await run(tools.get("bash"), {
      command: `sleep 0.2; echo survived > ${marker}`,
      run_in_background: true,
    });
    const taskId = (started.details as { taskId: string }).taskId;

    const detached = await run(tools.get("task_detach"), { taskId });
    expect(textOf(detached)).toContain("Detached");
    await profile.processes.killAll();
    expect(profile.processes.get(taskId)?.status).toBe("running");

    await profile.processes.wait(taskId);
    expect(await readFile(marker, "utf8")).toContain("survived");
  });
});

describe("PTY-backed task sessions", () => {
  test("stdin, stdout, and stderr are attached to a terminal", async () => {
    const manager = new ProcessManager(shellSpawner(await scratch()));
    const task = manager.start(
      "if [ -t 0 ]; then input=tty; else input=pipe; fi; " +
        "if [ -t 1 ]; then output=tty; else output=pipe; fi; " +
        "if [ -t 2 ]; then error=tty; else error=pipe; fi; " +
        'printf "stdin=%s stdout=%s stderr=%s\\n" "$input" "$output" "$error"',
    );

    await manager.wait(task.id);
    expect(manager.output(task.id, "start")?.text).toContain("stdin=tty stdout=tty stderr=tty");
  });

  test("drives an interactive prompt through terminal input", async () => {
    const manager = new ProcessManager(shellSpawner(await scratch()));
    const task = manager.start('printf "name? "; read name; printf "hello:%s\\n" "$name"');
    manager.writeStdin(task.id, "mu\n");

    await manager.wait(task.id);
    const output = manager.output(task.id, "start")?.text ?? "";
    expect(output).toContain("name?");
    expect(output).toContain("hello:mu");
  });

  test("resizes the child terminal", async () => {
    const manager = new ProcessManager(shellSpawner(await scratch()));
    const task = manager.start("stty size; read line; stty size", { cols: 93, rows: 31 });
    await Bun.sleep(100);
    expect(manager.resize(task.id, 120, 40)).toBe(true);
    manager.writeStdin(task.id, "continue\n");

    await manager.wait(task.id);
    const output = manager.output(task.id, "start")?.text ?? "";
    expect(output).toContain("31 93");
    expect(output).toContain("40 120");
  });

  test("preserves ANSI output and split UTF-8 sequences", async () => {
    const manager = new ProcessManager(shellSpawner(await scratch()));
    const task = manager.start(
      "printf '\\033[31mred\\033[0m '; printf '\\360\\237'; sleep 0.1; printf '\\230\\200\\n'",
    );

    await manager.wait(task.id);
    const output = manager.output(task.id, "start")?.text ?? "";
    expect(output).toContain("\u001b[31mred\u001b[0m");
    expect(output).toContain("😀");
    expect(output).not.toContain("�");
    expect(manager.get(task.id)?.outputBytes).toBe(new TextEncoder().encode(output).length);
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

  test("the coding profile publishes task events and resumes an idle Agent", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const provider = new FakeProvider([
      {
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: {
              command: "sleep 0.15; echo background-done",
              run_in_background: true,
            },
          },
        ],
      },
      { content: [{ type: "text", text: "waiting for the task" }] },
      { content: [{ type: "text", text: "the task finished" }] },
    ]);
    const agent = new Agent(
      await optionsFromProfile(profile, "fake/fake-1", {
        model: fakeModel,
        provider,
        permissions: [{ permission: "*", pattern: "*", action: "allow" }],
      }),
    );
    const eventTypes: string[] = [];
    agent.subscribe((event) => {
      eventTypes.push(event.type);
    });

    await agent.run("start a background command");
    const task = profile.processes.list()[0];
    expect(task).toBeDefined();
    await profile.processes.wait(task?.id ?? "");
    await agent.waitForIdle();

    expect(provider.callCount).toBe(3);
    expect(eventTypes).toContain("task_started");
    expect(eventTypes).toContain("task_output");
    expect(eventTypes).toContain("task_exited");
    expect(JSON.stringify(provider.requests[2]?.messages)).toContain("Background task task_1");
    await agent.shutdown();
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
    await manager.wait(task.id);

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

    await manager.killAll();

    const first = await readFile(marker, "utf8").catch(() => "");
    await Bun.sleep(400);
    expect(await readFile(marker, "utf8").catch(() => "")).toBe(first);
  });
});
