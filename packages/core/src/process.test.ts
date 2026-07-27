import { describe, expect, test } from "bun:test";
import {
  exitNotification,
  type ManagedProcessHandle,
  OutputBuffer,
  ProcessManager,
  type Spawner,
  type TaskInfo,
} from "./process.ts";

// A controllable stand-in for a real process.
function fakeSpawner(): {
  spawner: Spawner;
  emit: (chunk: string) => void;
  finish: (code: number | null) => void;
  written: string[];
  killed: () => boolean;
} {
  let onOutput: ((chunk: string) => void) | undefined;
  let resolveExit: ((code: number | null) => void) | undefined;
  const written: string[] = [];
  let wasKilled = false;

  const spawner: Spawner = (request) => {
    onOutput = request.onOutput;
    const handle: ManagedProcessHandle = {
      write: (data) => written.push(data),
      kill: () => {
        wasKilled = true;
        resolveExit?.(null);
      },
      exited: new Promise<number | null>((resolve) => {
        resolveExit = resolve;
      }),
    };
    return handle;
  };

  return {
    spawner,
    emit: (chunk) => onOutput?.(chunk),
    finish: (code) => resolveExit?.(code),
    written,
    killed: () => wasKilled,
  };
}

describe("OutputBuffer", () => {
  test("keeps short output intact", () => {
    const buffer = new OutputBuffer();
    buffer.append("hello");
    expect(buffer.read()).toBe("hello");
    expect(buffer.truncated).toBe(false);
  });

  test("bounds memory with head + tail and reports the gap", () => {
    const buffer = new OutputBuffer(100, 100);
    buffer.append("H".repeat(100));
    buffer.append("M".repeat(5_000));
    buffer.append("T".repeat(100));

    const text = buffer.read();
    expect(buffer.truncated).toBe(true);
    expect(text).toContain("bytes omitted");
    expect(text.startsWith("H")).toBe(true);
    expect(text.endsWith("T")).toBe(true);
    // The retained text stays bounded regardless of how much was written.
    expect(text.length).toBeLessThan(500);
    expect(buffer.bytes).toBe(5_200);
  });

  test("incremental reads return only what is new", () => {
    const buffer = new OutputBuffer();
    buffer.append("first ");
    const a = buffer.readSince(0);
    expect(a.text).toBe("first ");

    buffer.append("second");
    const b = buffer.readSince(a.offset);
    expect(b.text).toBe("second");
    expect(buffer.readSince(b.offset).text).toBe("");
  });
});

describe("ProcessManager", () => {
  test("starts a task and reports it as running", () => {
    const fake = fakeSpawner();
    const manager = new ProcessManager(fake.spawner);
    const task = manager.start("bun dev");

    expect(task.status).toBe("running");
    expect(manager.runningCount).toBe(1);
    expect(manager.list().map((t) => t.command)).toEqual(["bun dev"]);
  });

  test("collects output and serves it incrementally", () => {
    const fake = fakeSpawner();
    const manager = new ProcessManager(fake.spawner);
    const task = manager.start("bun dev");

    fake.emit("listening on 3000\n");
    expect(manager.output(task.id, "new")?.text).toContain("listening on 3000");
    // Nothing new the second time.
    expect(manager.output(task.id, "new")?.text).toBe("");

    fake.emit("request received\n");
    expect(manager.output(task.id, "new")?.text).toContain("request received");
    // A full read returns everything.
    expect(manager.output(task.id, "start")?.text).toContain("listening on 3000");
  });

  test("writes to stdin for REPL-style interaction", () => {
    const fake = fakeSpawner();
    const manager = new ProcessManager(fake.spawner);
    const task = manager.start("node");

    expect(manager.writeStdin(task.id, "1 + 1\n")).toBe(true);
    expect(fake.written).toEqual(["1 + 1\n"]);
  });

  test("kill stops a running task and marks it killed", async () => {
    const fake = fakeSpawner();
    const manager = new ProcessManager(fake.spawner);
    const task = manager.start("sleep 999");

    expect(manager.kill(task.id)).toBe(true);
    expect(fake.killed()).toBe(true);
    await Bun.sleep(1);
    expect(manager.get(task.id)?.status).toBe("killed");
    // Killing twice is reported, not thrown.
    expect(manager.kill(task.id)).toBe(false);
  });

  test("exit is recorded with its code", async () => {
    const fake = fakeSpawner();
    const exited: TaskInfo[] = [];
    const manager = new ProcessManager(fake.spawner, { onExited: (t) => exited.push(t) });
    const task = manager.start("bun test");

    fake.finish(0);
    await Bun.sleep(1);

    expect(manager.get(task.id)?.status).toBe("exited");
    expect(manager.get(task.id)?.exitCode).toBe(0);
    expect(exited.length).toBe(1);
    expect(manager.runningCount).toBe(0);
  });

  test("events fire for start and output", async () => {
    const fake = fakeSpawner();
    const started: TaskInfo[] = [];
    const chunks: string[] = [];
    const manager = new ProcessManager(fake.spawner, {
      onStarted: (t) => started.push(t),
      onOutput: (_id, chunk) => chunks.push(chunk),
    });
    manager.start("bun dev");
    fake.emit("hello");

    expect(started.length).toBe(1);
    expect(chunks).toEqual(["hello"]);
  });

  test("killAll stops everything the session owns", async () => {
    const first = fakeSpawner();
    const manager = new ProcessManager(first.spawner);
    manager.start("a");
    manager.start("b");
    expect(manager.runningCount).toBe(2);

    manager.killAll();
    expect(manager.list().every((t) => t.status === "killed")).toBe(true);
  });

  test("operations on an unknown task are reported, not thrown", () => {
    const manager = new ProcessManager(fakeSpawner().spawner);
    expect(manager.get("nope")).toBeUndefined();
    expect(manager.output("nope")).toBeUndefined();
    expect(manager.writeStdin("nope", "x")).toBe(false);
    expect(manager.kill("nope")).toBe(false);
  });
});

describe("exit notification", () => {
  test("describes a successful finish", () => {
    const text = exitNotification({
      id: "task_1",
      command: "bun test",
      status: "exited",
      exitCode: 0,
      startedAt: 1000,
      endedAt: 1340,
      outputBytes: 10,
      truncated: false,
    });
    expect(text).toContain("finished successfully");
    expect(text).toContain("340ms");
    expect(text).toContain("task_output");
  });

  test("describes a failure with its code", () => {
    const text = exitNotification({
      id: "task_2",
      command: "bun test",
      status: "exited",
      exitCode: 1,
      startedAt: 0,
      endedAt: 5,
      outputBytes: 0,
      truncated: false,
    });
    expect(text).toContain("failed with exit code 1");
  });

  test("describes a kill", () => {
    const text = exitNotification({
      id: "task_3",
      command: "sleep 999",
      status: "killed",
      exitCode: null,
      startedAt: 0,
      endedAt: 1,
      outputBytes: 0,
      truncated: false,
    });
    expect(text).toContain("was killed");
  });
});

describe("incremental reads survive tail rollover", () => {
  test("fresh output is never reported as nothing new after a rollover", () => {
    const buffer = new OutputBuffer(50, 50);
    buffer.append("H".repeat(50)); // fill the head
    let position = 0;

    // Repeatedly overflow the tail; every poll must return the new bytes.
    for (let round = 0; round < 5; round++) {
      buffer.append(`round-${round}-${"x".repeat(60)}`);
      const read = buffer.readSince(position);
      expect(read.text.length).toBeGreaterThan(0);
      expect(read.offset).toBe(buffer.bytes);
      position = read.offset;
    }

    // And once caught up, there genuinely is nothing new.
    expect(buffer.readSince(position).text).toBe("");
  });

  test("a reader that fell behind is told data was dropped", () => {
    const buffer = new OutputBuffer(10, 10);
    buffer.append("H".repeat(10));
    const early = buffer.readSince(0).offset;
    buffer.append("y".repeat(500));

    const read = buffer.readSince(early);
    expect(read.gap).toBe(true);
    expect(read.text).toContain("output omitted");
    // The retained tail is still delivered rather than lost silently.
    expect(read.text).toContain("y");
  });

  test("the manager's incremental polling keeps working across rollovers", () => {
    const fake = fakeSpawner();
    const manager = new ProcessManager(fake.spawner);
    const task = manager.start("chatty");

    fake.emit("first\n");
    expect(manager.output(task.id, "new")?.text).toContain("first");

    // Push far past the buffer limits, as a dev server would.
    for (let i = 0; i < 100; i++) fake.emit(`line ${i} ${"z".repeat(300)}\n`);

    const later = manager.output(task.id, "new");
    expect(later?.text.length).toBeGreaterThan(0);
    expect(later?.text).toContain("line 99");
  });
});
