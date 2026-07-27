// Process manager. A core service rather than something buried in a bash tool,
// because automation and computer-use profiles need background work too.
// Spawning itself is injected — the kernel does not know what a directory is.

export interface ManagedProcessHandle {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  detach: () => void;
  // Must terminate the whole process tree: a shell that started a server
  // leaves descendants holding ports and files otherwise.
  kill: () => void;
  // Resolves with the exit code (null when killed by a signal).
  exited: Promise<number | null>;
}

export interface SpawnRequest {
  command: string;
  onOutput: (chunk: string) => void;
  cols: number;
  rows: number;
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
  detached: boolean;
}

const HEAD_BYTES = 8_000;
const TAIL_BYTES = 8_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

function utf8PrefixLength(bytes: Uint8Array<ArrayBufferLike>, limit: number): number {
  let end = Math.min(bytes.length, Math.max(0, limit));
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  if (end === bytes.length) return end;
  const first = bytes[end] ?? 0;
  const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
  return end + width <= limit ? end + width : end;
}

function utf8SuffixStart(bytes: Uint8Array<ArrayBufferLike>, minimum: number): number {
  let start = Math.max(0, minimum);
  while (start < bytes.length && (bytes[start] ?? 0) >= 0x80 && (bytes[start] ?? 0) < 0xc0) {
    start += 1;
  }
  return start;
}

// Head + tail with the middle dropped. An unbounded buffer on a chatty dev
// server is a real way to exhaust memory, and the gap is reported honestly.
export class OutputBuffer {
  private head: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private tail: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private headComplete = false;
  private total = 0;

  constructor(
    private headLimit = HEAD_BYTES,
    private tailLimit = TAIL_BYTES,
  ) {}

  append(chunk: string): void {
    let bytes: Uint8Array<ArrayBufferLike> = encoder.encode(chunk);
    this.total += bytes.length;
    if (!this.headComplete && this.head.length < this.headLimit) {
      const room = this.headLimit - this.head.length;
      const take = utf8PrefixLength(bytes, room);
      this.head = concatBytes(this.head, bytes.subarray(0, take));
      bytes = bytes.subarray(take);
      if (bytes.length === 0) return;
      this.headComplete = true;
    }
    this.tail = concatBytes(this.tail, bytes);
    if (this.tail.length > this.tailLimit) {
      const excess = this.tail.length - this.tailLimit;
      this.tail = this.tail.slice(utf8SuffixStart(this.tail, excess));
    }
  }

  get bytes(): number {
    return this.total;
  }

  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  read(): string {
    const head = decoder.decode(this.head);
    const tail = decoder.decode(this.tail);
    if (this.droppedBytes === 0) return head + tail;
    return `${head}\n\n… [${this.droppedBytes} bytes omitted] …\n\n${tail}`;
  }

  // Everything appended since a source-stream position. Returns the new
  // position so the caller can poll incrementally; if the reader fell behind
  // data we already discarded, it is told so rather than silently skipped.
  readSince(position: number): { text: string; offset: number; gap: boolean } {
    if (position >= this.total) return { text: "", offset: this.total, gap: false };
    const tailStart = this.total - this.tail.length;

    // Still inside the head we retained verbatim.
    if (position < this.head.length) {
      const headPart = decoder.decode(this.head.slice(position));
      const gap = tailStart > this.head.length;
      const text = gap
        ? `${headPart}\n\n… [output omitted] …\n\n${decoder.decode(this.tail)}`
        : headPart + decoder.decode(this.tail);
      return { text, offset: this.total, gap };
    }

    if (position < tailStart) {
      // The reader fell behind: hand back everything retained plus a marker.
      return {
        text: `… [output omitted] …\n\n${decoder.decode(this.tail)}`,
        offset: this.total,
        gap: true,
      };
    }
    return {
      text: decoder.decode(this.tail.slice(position - tailStart)),
      offset: this.total,
      gap: false,
    };
  }

  private get droppedBytes(): number {
    return this.total - this.head.length - this.tail.length;
  }
}

interface Task {
  info: TaskInfo;
  buffer: OutputBuffer;
  handle: ManagedProcessHandle;
  readOffset: number;
  killRequested: boolean;
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

  start(command: string, size: { cols?: number; rows?: number } = {}): TaskInfo {
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
      detached: false,
    };

    const handle = this.spawn({
      command,
      cols: size.cols ?? 80,
      rows: size.rows ?? 24,
      onOutput: (chunk) => {
        buffer.append(chunk);
        info.outputBytes = buffer.bytes;
        info.truncated = buffer.truncated;
        this.events.onOutput?.(id, chunk);
      },
    });

    const task: Task = { info, buffer, handle, readOffset: 0, killRequested: false };
    this.tasks.set(id, task);
    this.events.onStarted?.({ ...info });

    void handle.exited.then((code) => {
      if (info.status === "running") {
        info.status = task.killRequested || code === null ? "killed" : "exited";
      }
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

  resize(id: string, cols: number, rows: number): boolean {
    const task = this.tasks.get(id);
    if (!task || task.info.status !== "running" || cols <= 0 || rows <= 0) return false;
    task.handle.resize(cols, rows);
    return true;
  }

  resizeAll(cols: number, rows: number): void {
    for (const task of this.tasks.values()) {
      if (task.info.status === "running") task.handle.resize(cols, rows);
    }
  }

  detach(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.info.status !== "running" || task.info.detached) return false;
    task.info.detached = true;
    task.handle.detach();
    return true;
  }

  kill(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.info.status !== "running" || task.killRequested) return false;
    task.killRequested = true;
    task.handle.kill();
    return true;
  }

  // Session-scoped lifecycle: everything this session started is killed when it
  // ends, unless a task was explicitly detached.
  async killAll(): Promise<void> {
    const exits: Promise<number | null>[] = [];
    for (const task of this.tasks.values()) {
      if (task.info.status === "running" && !task.info.detached) {
        task.killRequested = true;
        task.handle.kill();
        exits.push(task.handle.exited);
      }
    }
    await Promise.allSettled(exits);
  }

  async wait(id: string): Promise<TaskInfo | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    await task.handle.exited;
    return this.get(id);
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
