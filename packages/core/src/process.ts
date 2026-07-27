// Process manager. A core service rather than something buried in a bash tool,
// because automation and computer-use profiles need background work too.
// Spawning itself is injected — the kernel does not know what a directory is.

export interface ManagedProcessHandle {
  write: (data: string) => void;
  // Must terminate the whole process tree: a shell that started a server
  // leaves descendants holding ports and files otherwise.
  kill: () => void;
  // Resolves with the exit code (null when killed by a signal).
  exited: Promise<number | null>;
}

export interface SpawnRequest {
  command: string;
  onOutput: (chunk: string) => void;
}

export type Spawner = (request: SpawnRequest) => ManagedProcessHandle;

export type TaskStatus = "running" | "exited" | "killed";

export interface TaskInfo {
  id: string;
  command: string;
  status: TaskStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  outputBytes: number;
  truncated: boolean;
}

const HEAD_BYTES = 8_000;
const TAIL_BYTES = 8_000;

// Head + tail with the middle dropped. An unbounded buffer on a chatty dev
// server is a real way to exhaust memory, and the gap is reported honestly.
export class OutputBuffer {
  private head = "";
  private tail = "";
  private droppedBytes = 0;
  private total = 0;
  // Source position of the first byte still held in `tail`. Readers track
  // positions in the *source* stream, not in the rendered string, so tail
  // rollover can never make fresh output look like "nothing new".
  private tailStart = 0;

  constructor(
    private headLimit = HEAD_BYTES,
    private tailLimit = TAIL_BYTES,
  ) {}

  append(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.headLimit) {
      const room = this.headLimit - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      if (chunk.length === 0) return;
    }
    if (this.tailStart === 0) this.tailStart = this.head.length;
    this.tail += chunk;
    if (this.tail.length > this.tailLimit) {
      const excess = this.tail.length - this.tailLimit;
      this.tail = this.tail.slice(excess);
      this.droppedBytes += excess;
      this.tailStart += excess;
    }
  }

  get bytes(): number {
    return this.total;
  }

  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  read(): string {
    if (this.droppedBytes === 0) return this.head + this.tail;
    return `${this.head}\n\n… [${this.droppedBytes} bytes omitted] …\n\n${this.tail}`;
  }

  // Everything appended since a source-stream position. Returns the new
  // position so the caller can poll incrementally; if the reader fell behind
  // data we already discarded, it is told so rather than silently skipped.
  readSince(position: number): { text: string; offset: number; gap: boolean } {
    if (position >= this.total) return { text: "", offset: this.total, gap: false };

    // Still inside the head we retained verbatim.
    if (position < this.head.length) {
      const headPart = this.head.slice(position);
      const gap = this.tailStart > this.head.length;
      const text = gap
        ? `${headPart}\n\n… [output omitted] …\n\n${this.tail}`
        : headPart + this.tail;
      return { text, offset: this.total, gap };
    }

    if (position < this.tailStart) {
      // The reader fell behind: hand back everything retained plus a marker.
      return {
        text: `… [output omitted] …\n\n${this.tail}`,
        offset: this.total,
        gap: true,
      };
    }
    return { text: this.tail.slice(position - this.tailStart), offset: this.total, gap: false };
  }
}

interface Task {
  info: TaskInfo;
  buffer: OutputBuffer;
  handle: ManagedProcessHandle;
  readOffset: number;
}

export interface ProcessEvents {
  onStarted?: (task: TaskInfo) => void;
  onOutput?: (taskId: string, chunk: string) => void;
  onExited?: (task: TaskInfo) => void;
}

export class ProcessManager {
  private tasks = new Map<string, Task>();
  private counter = 0;

  constructor(
    private spawn: Spawner,
    private events: ProcessEvents = {},
  ) {}

  start(command: string): TaskInfo {
    const id = `task_${++this.counter}`;
    const buffer = new OutputBuffer();

    const info: TaskInfo = {
      id,
      command,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      outputBytes: 0,
      truncated: false,
    };

    const handle = this.spawn({
      command,
      onOutput: (chunk) => {
        buffer.append(chunk);
        info.outputBytes = buffer.bytes;
        info.truncated = buffer.truncated;
        this.events.onOutput?.(id, chunk);
      },
    });

    const task: Task = { info, buffer, handle, readOffset: 0 };
    this.tasks.set(id, task);
    this.events.onStarted?.({ ...info });

    void handle.exited.then((code) => {
      if (info.status === "running") info.status = code === null ? "killed" : "exited";
      info.exitCode = code;
      info.endedAt = Date.now();
      this.events.onExited?.({ ...info });
    });

    return { ...info };
  }

  get(id: string): TaskInfo | undefined {
    const task = this.tasks.get(id);
    return task ? { ...task.info } : undefined;
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()].map((task) => ({ ...task.info }));
  }

  get runningCount(): number {
    return [...this.tasks.values()].filter((t) => t.info.status === "running").length;
  }

  output(id: string, since?: "start" | "new"): { text: string; truncated: boolean } | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (since === "new") {
      const { text, offset } = task.buffer.readSince(task.readOffset);
      task.readOffset = offset;
      return { text, truncated: task.buffer.truncated };
    }
    task.readOffset = task.buffer.bytes;
    return { text: task.buffer.read(), truncated: task.buffer.truncated };
  }

  writeStdin(id: string, data: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.info.status !== "running") return false;
    task.handle.write(data);
    return true;
  }

  kill(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.info.status !== "running") return false;
    task.info.status = "killed";
    task.handle.kill();
    return true;
  }

  // Session-scoped lifecycle: everything this session started is killed when it
  // ends, unless a task was explicitly detached.
  killAll(): void {
    for (const task of this.tasks.values()) {
      if (task.info.status === "running") {
        task.info.status = "killed";
        task.handle.kill();
      }
    }
  }
}

// Exit notifications wake an idle agent through the follow-up queue — this is
// how "tell me when the build finishes" works without polling.
export function exitNotification(task: TaskInfo): string {
  const outcome =
    task.status === "killed"
      ? "was killed"
      : task.exitCode === 0
        ? "finished successfully"
        : `failed with exit code ${task.exitCode}`;
  const duration = task.endedAt ? `${task.endedAt - task.startedAt}ms` : "unknown duration";
  return `Background task ${task.id} (${task.command}) ${outcome} after ${duration}. Use task_output to read its output.`;
}
