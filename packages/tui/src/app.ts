// The mu integration layer: an AgentEvent consumer that retains transcript
// cells and keeps the live region (composer / approval / footer) up to date. It
// holds no agent logic — everything arrives as events.
import type { AgentEvent, AgentMessage, AssistantMessage, PermissionRequest } from "@mu/core";
import {
  agentCell,
  compactionCell,
  diffLinesFromHunks,
  errorCell,
  type RenderContext,
  taskCell,
  thinkingCell,
  toolOutputCell,
  userCell,
} from "./cells.ts";
import {
  APPROVAL_OPTIONS,
  approvalOverlay,
  composerRule,
  Editor,
  type FooterData,
  footer,
  type QueuedInputKind,
  queuedInputPreview,
  type SelectItem,
  SelectList,
  Spinner,
} from "./components.ts";
import type { InputEvent, Key } from "./input.ts";
import { RendererRegistry, type ToolRenderInfo } from "./registry.ts";
import { AGENT_LABEL, type ColorDepth, GLYPHS, MARGIN, styleText } from "./style.ts";
import { terminalRows, wrapText } from "./wrap.ts";

export type AppMode = "composing" | "approval" | "select" | "mention" | "picker" | "prompt";

export interface PickerRequest {
  title: string;
  items: SelectItem[];
  onChoose: (value: string) => void;
  onBack?: () => void;
  onCancel?: () => void;
  filterable?: boolean;
}

export interface InputPromptRequest {
  title: string;
  secret?: boolean;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}

export interface AppCallbacks {
  onSubmit: (text: string) => void;
  onSteer?: (text: string) => boolean;
  onFollowUp?: (text: string) => boolean;
  onEditQueued?: (kind: QueuedInputKind, text: string) => boolean;
  // Explicit user shell escape. The leading `!` stays in editor history, but
  // only the command text is passed to the surface.
  onShell?: (command: string) => void;
  // Supplies file paths for the `@` mention popup.
  onMentionQuery?: (query: string) => { label: string; description?: string }[];
  onAbort: () => void;
  onExit: () => void;
  // Present only for a conversation attached from agent view. Plain mu omits
  // it, so Left remains ordinary editor navigation there.
  onDetach?: () => void;
  onPermissionReply?: (requestId: string, outcome: "allow" | "deny", remember: boolean) => void;
  onCommand?: (text: string) => void;
  onThinkingChange?: (level: string) => void;
  // Shift+Tab. The surface owns the mode list (profile-defined), so this is
  // just a "cycle to the next one" signal, same shape as onAbort/onExit.
  onCyclePermissionMode?: () => void;
}

export interface AppOptions {
  width: number;
  height?: number;
  depth: ColorDepth;
  model: string;
  version?: string;
  cwd?: string;
  contextWindow?: number;
  thinkingLevels?: readonly string[];
  callbacks: AppCallbacks;
  registry?: RendererRegistry;
}

interface LiveTask {
  taskId: string;
  command: string;
  startedAt: number;
  tail: string[];
  partial: string;
}

interface PendingInput {
  kind: QueuedInputKind;
  text: string;
}

const TASK_TAIL_LINES = 5;
const TASK_PARTIAL_CHARS = 2_000;
const LIVE_TOOL_OUTPUT_LINES = 50;
const EXPANDED_TOOL_ROWS = 24;
const PENDING_INPUT_ROWS = 3;
const MIN_STREAMING_PREVIEW_CHARS = 8_000;
const MAX_STREAMING_PREVIEW_CHARS = 16_000;
const STREAMING_VIEWPORTS = 2;
// Idle Ctrl+C arms a "press again to exit" window instead of exiting on the
// first press, so one stray keystroke can't kill the session.
export const CTRL_C_EXIT_WINDOW_MS = 2_000;

interface MarkdownFence {
  marker: string;
  language?: string;
}

// A completed response is always rendered in full. While it is still growing,
// cap the expensive Markdown/syntax-highlight pass to a few viewports. If the
// retained suffix is inside a fence, recreate that fence so live code keeps
// its language-aware highlighting.
function streamingMarkdownPreview(
  text: string,
  maxChars: number,
): { text: string; omittedChars: number } {
  if (text.length <= maxChars) return { text, omittedChars: 0 };

  let start = text.length - maxChars;
  const nextLine = text.indexOf("\n", start);
  if (nextLine !== -1) start = nextLine + 1;

  const prefix = text.slice(0, start);
  const tail = text.slice(start);
  const fence = openFenceAtEnd(prefix);
  const context = fence ? `${fence.marker}${fence.language ? fence.language : ""}\n${tail}` : tail;
  return {
    text: `… ${start.toLocaleString()} earlier characters retained while streaming\n\n${context}`,
    omittedChars: start,
  };
}

function openFenceAtEnd(text: string): MarkdownFence | undefined {
  let open: MarkdownFence | undefined;
  for (const line of text.split("\n")) {
    if (!open) {
      const match = /^\s*(`{3,}|~{3,})\s*([^ ]*)?.*$/.exec(line);
      if (match?.[1]) {
        open = {
          marker: match[1],
          ...(match[2]?.trim() ? { language: match[2].trim() } : {}),
        };
      }
      continue;
    }
    const close = new RegExp(`^\\s*${open.marker[0]}{${open.marker.length},}\\s*$`);
    if (close.test(line)) open = undefined;
  }
  return open;
}

function formatDuration(durationMs: number): string {
  const ms = Math.max(0, durationMs);
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

class LiveToolOutput {
  private lines: string[] = [];
  private partial = "";
  private omitted = 0;
  private afterCarriageReturn = false;

  append(chunk: string): void {
    for (const char of chunk) {
      if (char === "\n" && this.afterCarriageReturn) {
        this.afterCarriageReturn = false;
        continue;
      }
      if (char === "\n" || char === "\r") {
        this.finishLine();
        this.afterCarriageReturn = char === "\r";
        continue;
      }
      this.afterCarriageReturn = false;
      this.partial += char;
      if (this.partial.length > TASK_PARTIAL_CHARS) {
        this.partial = `…${this.partial.slice(-(TASK_PARTIAL_CHARS - 1))}`;
      }
    }
  }

  display(maxLines: number): string[] {
    const retained = [...this.lines, ...(this.partial.length > 0 ? [this.partial] : [])];
    const total = this.omitted + retained.length;
    if (total <= maxLines) return retained;
    const visibleCount = Math.max(1, maxLines - 1);
    const visible = retained.slice(-visibleCount);
    const hidden = total - visible.length;
    return [`… ${hidden} earlier lines · ctrl+o to expand`, ...visible];
  }

  private finishLine(): void {
    this.lines.push(this.partial);
    this.partial = "";
    if (this.lines.length > LIVE_TOOL_OUTPUT_LINES) {
      const removed = this.lines.length - LIVE_TOOL_OUTPUT_LINES;
      this.lines.splice(0, removed);
      this.omitted += removed;
    }
  }
}

type PendingTool = ToolRenderInfo & { output: LiveToolOutput };
type TranscriptItem =
  | { kind: "lines"; lines: string[] }
  | { kind: "user"; text: string }
  | {
      kind: "assistant";
      message: AssistantMessage;
      rendered?: { width: number; lines: string[] };
    }
  | {
      kind: "tool";
      info: ToolRenderInfo;
      rendered?: { width: number; expanded: boolean; lines: string[] };
    };

export class App {
  readonly editor = new Editor();
  readonly registry: RendererRegistry;
  private spinner = new Spinner();
  private commandList = new SelectList([]);
  private mode: AppMode = "composing";
  private running = false;
  private runStartedAt = 0;
  private compacting = false;
  private compactionStage: "clearing-tool-output" | "summarizing" | "installing" | undefined;
  // A parallel-safe tool batch can raise several asks at once, so they queue
  // rather than overwriting each other. One is shown; resolving removes only
  // the matching id and advances to the next.
  private approvals: PermissionRequest[] = [];
  private approvalIndex = 0;
  private pendingTools = new Map<string, PendingTool>();
  private pendingInputs: PendingInput[] = [];
  private transcript: TranscriptItem[] = [];
  private transcriptVersion = 0;
  private transcriptCache:
    | {
        version: number;
        width: number;
        expanded: boolean;
        rows: string[];
      }
    | undefined;
  private toolOutputExpanded = false;
  private backgroundTasks = new Map<string, LiveTask>();
  // The assistant message currently streaming, shown live above the composer.
  private streaming: string | undefined;
  private streamingCache:
    | {
        text: string;
        width: number;
        height: number;
        rows: string[];
      }
    | undefined;
  private lastError: string | undefined;
  private ctrlCArmedAt = 0;
  private footerData: FooterData;
  private commands: { label: string; description?: string }[] = [];
  private thinkingLevel = "off";
  private thinkingLevels: string[];
  private picker: PickerRequest | undefined;
  private pickerQuery = "";
  private prompt: InputPromptRequest | undefined;
  private promptEditor = new Editor();
  private mentionStart = -1;

  constructor(private options: AppOptions) {
    this.registry = options.registry ?? new RendererRegistry();
    this.thinkingLevels = [...new Set(options.thinkingLevels ?? ["off", "low", "medium", "high"])];
    this.footerData = {
      cwd: options.cwd ?? ".",
      model: options.model,
      contextPercent: 0,
      contextWindow: options.contextWindow ?? 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }

  private get ctx(): RenderContext {
    return { width: this.options.width, depth: this.options.depth };
  }

  setWidth(width: number): void {
    this.options.width = width;
  }

  setSize(width: number, height: number): void {
    this.options.width = width;
    this.options.height = height;
  }

  setCommands(commands: { label: string; description?: string }[]): void {
    this.commands = commands;
  }

  setModel(model: string, contextWindow?: number): void {
    this.footerData = {
      ...this.footerData,
      model,
      contextPercent: 0,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
  }

  setThinking(level: string, levels?: readonly string[]): void {
    if (levels && levels.length > 0) this.thinkingLevels = [...new Set(levels)];
    this.thinkingLevel = this.thinkingLevels.includes(level)
      ? level
      : (this.thinkingLevels[0] ?? "off");
  }

  get thinking(): string {
    return this.thinkingLevel;
  }

  get areToolOutputsExpanded(): boolean {
    return this.toolOutputExpanded;
  }

  get isShellMode(): boolean {
    return this.options.callbacks.onShell !== undefined && this.editor.text.startsWith("!");
  }

  // Opens a selection list (used by /model and /resume).
  openPicker(request: PickerRequest): void {
    this.picker = request;
    this.pickerQuery = "";
    this.commandList.setItems(request.items);
    this.mode = "picker";
  }

  openCommandMenu(): void {
    this.editor.setText("/");
    this.commandList.setItems(this.commands);
    this.mode = "select";
  }

  openPrompt(request: InputPromptRequest): void {
    this.prompt = request;
    this.promptEditor.setText("");
    this.mode = "prompt";
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentMode(): AppMode {
    return this.mode;
  }

  // True while a first idle Ctrl+C is armed, waiting for a confirming second
  // press within CTRL_C_EXIT_WINDOW_MS.
  get ctrlCPending(): boolean {
    return this.ctrlCArmedAt !== 0 && Date.now() - this.ctrlCArmedAt < CTRL_C_EXIT_WINDOW_MS;
  }

  // Events that produce transcript output return their rendered lines for
  // callers that inspect events directly; all durable output is also retained
  // as semantic transcript cells for whole-screen rendering.
  handleEvent(event: AgentEvent): string[] {
    switch (event.type) {
      case "agent_start":
        this.running = true;
        this.runStartedAt = Date.now();
        return [];

      case "agent_end": {
        this.running = false;
        this.compacting = false;
        this.compactionStage = undefined;
        const duration = styleText(
          `worked for ${formatDuration(Date.now() - this.runStartedAt)}`,
          { dim: true },
          this.ctx.depth,
        );
        if (event.reason !== "error") {
          const lines = [MARGIN + duration, ""];
          this.appendTranscript(lines);
          return lines;
        }
        // Show *why* it failed. "run ended with an error" tells the user
        // nothing and hides actionable messages like a missing API key.
        const detail = this.lastError ?? "the provider returned an error";
        this.lastError = undefined;
        const lines = [...errorCell(detail, this.ctx), MARGIN + duration, ""];
        this.appendTranscript(lines);
        return lines;
      }

      case "message_start":
        if (event.message.role === "assistant") {
          this.streaming = "";
          this.streamingCache = undefined;
        }
        return [];

      case "message_update":
        if (event.delta.kind === "text_delta") {
          this.streaming = (this.streaming ?? "") + event.delta.text;
          this.streamingCache = undefined;
        } else if (
          event.delta.kind === "toolcall_start" ||
          event.delta.kind === "toolcall_delta" ||
          event.delta.kind === "toolcall_end"
        ) {
          const block = event.message.content[event.delta.contentIndex];
          if (block?.type === "toolCall" && block.id) {
            const existing = this.pendingTools.get(block.id);
            this.pendingTools.set(block.id, {
              toolName: block.name,
              args: block.arguments,
              argsStreaming: event.delta.kind !== "toolcall_end",
              running: existing?.running ?? false,
              output: existing?.output ?? new LiveToolOutput(),
            });
          }
        }
        return [];

      case "tool_execution_update": {
        const pending = this.pendingTools.get(event.toolCallId);
        if (pending) {
          for (const block of event.partial) {
            if (block.type === "text") pending.output.append(block.text);
          }
        }
        return [];
      }

      case "message_end": {
        const message = event.message;
        if (message.role === "user") {
          const text = message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          if (!text) return [];
          const pendingIndex = this.pendingInputs.findIndex(
            (pending) => pending.kind === "steer" && pending.text === text,
          );
          const deliveredIndex =
            pendingIndex === -1
              ? this.pendingInputs.findIndex(
                  (pending) => pending.kind === "follow-up" && pending.text === text,
                )
              : pendingIndex;
          if (deliveredIndex !== -1) this.pendingInputs.splice(deliveredIndex, 1);
          this.pushTranscript({ kind: "user", text });
          return [...userCell(text, this.ctx), ""];
        }
        if (message.role === "assistant") {
          this.streaming = undefined;
          this.streamingCache = undefined;
          if (message.stopReason === "error" && message.errorMessage) {
            this.lastError = message.errorMessage;
          }
          const lines = this.assistantRows(message);
          if (lines.length > 0) {
            this.pushTranscript({
              kind: "assistant",
              message,
              rendered: { width: this.options.width, lines },
            });
          }
          return lines.length > 0 ? [...lines, ""] : [];
        }
        return [];
      }

      case "tool_execution_start":
        {
          const existing = this.pendingTools.get(event.toolCallId);
          this.pendingTools.set(event.toolCallId, {
            toolName: event.toolName,
            args: event.args,
            running: true,
            output: existing?.output ?? new LiveToolOutput(),
          });
        }
        return [];

      case "tool_execution_end": {
        const pending = this.pendingTools.get(event.toolCallId);
        this.pendingTools.delete(event.toolCallId);
        const info: ToolRenderInfo = {
          toolName: pending?.toolName ?? event.result.toolName,
          args: pending?.args ?? {},
          result: event.result,
        };
        const lines = this.registry.render(info, this.ctx);
        this.pushTranscript({
          kind: "tool",
          info,
          rendered: {
            width: this.options.width,
            expanded: false,
            lines,
          },
        });
        return lines;
      }

      case "permission_asked":
        this.approvals.push(event.request);
        this.approvalIndex = 0;
        this.mode = "approval";
        return [];

      case "permission_resolved": {
        const before = this.approvals.length;
        this.approvals = this.approvals.filter((r) => r.id !== event.requestId);
        // A resolution for an id we never showed must not close another ask.
        if (this.approvals.length === before) return [];
        this.approvalIndex = 0;
        if (this.approvals.length === 0) this.mode = "composing";
        return [];
      }

      case "compaction_start":
        this.compacting = event.layer !== 1;
        this.compactionStage = this.compacting ? "summarizing" : undefined;
        return [];

      case "compaction_update":
        this.compacting = true;
        this.compactionStage = event.stage;
        return [];

      case "compaction_end": {
        this.compacting = false;
        this.compactionStage = undefined;
        const lines =
          event.status === "failed" || event.status === "cancelled"
            ? [
                ...errorCell(
                  event.errorMessage ?? "Compaction failed; original context preserved.",
                  this.ctx,
                ),
                "",
              ]
            : [
                ...compactionCell(event.tokensFreed, this.ctx, {
                  ...(event.status ? { status: event.status } : {}),
                  ...(event.contextTokensBefore !== undefined
                    ? { contextTokensBefore: event.contextTokensBefore }
                    : {}),
                  ...(event.contextTokensAfter !== undefined
                    ? { contextTokensAfter: event.contextTokensAfter }
                    : {}),
                  ...(event.toolResultsCleared !== undefined
                    ? { toolResultsCleared: event.toolResultsCleared }
                    : {}),
                  ...(event.keptTokens !== undefined ? { keptTokens: event.keptTokens } : {}),
                }),
                "",
              ];
        this.appendTranscript(lines);
        return lines;
      }

      case "usage_updated":
        this.footerData = {
          ...this.footerData,
          contextPercent: event.contextPercent,
          inputTokens: event.sessionTotals.inputTokens,
          outputTokens: event.sessionTotals.outputTokens,
          costUsd: event.sessionTotals.costUsd ?? 0,
        };
        return [];

      case "task_started": {
        this.backgroundTasks.set(event.taskId, {
          taskId: event.taskId,
          command: event.command,
          startedAt: Date.now(),
          tail: [],
          partial: "",
        });
        this.footerData = {
          ...this.footerData,
          backgroundTasks: this.backgroundTasks.size,
        };
        return [];
      }

      case "task_output": {
        const task = this.backgroundTasks.get(event.taskId);
        if (!task) return [];
        const parts = `${task.partial}${event.chunk}`.split(/\r\n|\n|\r/);
        task.partial = parts.pop() ?? "";
        if (task.partial.length > TASK_PARTIAL_CHARS) {
          task.partial = `…${task.partial.slice(-(TASK_PARTIAL_CHARS - 1))}`;
        }
        task.tail.push(...parts);
        if (task.tail.length > TASK_TAIL_LINES) {
          task.tail = task.tail.slice(-TASK_TAIL_LINES);
        }
        return [];
      }

      case "task_exited": {
        const task = this.backgroundTasks.get(event.taskId);
        this.backgroundTasks.delete(event.taskId);
        this.footerData = {
          ...this.footerData,
          backgroundTasks: this.backgroundTasks.size,
        };
        if (!task) return [];
        const lines = [
          ...taskCell(
            {
              taskId: task.taskId,
              command: task.command,
              status: event.status === "killed" ? "killed" : "exited",
              exitCode: event.exitCode,
              durationMs: Date.now() - task.startedAt,
            },
            this.ctx,
          ),
          "",
        ];
        this.appendTranscript(lines);
        return lines;
      }

      default:
        return [];
    }
  }

  // Shown once at startup: an empty screen with a bare prompt gives the user
  // nothing to orient against.
  banner(): string[] {
    const { depth, width } = this.ctx;
    const shell = this.options.callbacks.onShell ? ` ${GLYPHS.separator} ! for shell` : "";
    const version = this.options.version
      ? ` ${styleText(`v${this.options.version}`, { dim: true }, depth)}`
      : "";
    const affordances = styleText(
      `${this.footerData.model} ${GLYPHS.separator} / for commands ${GLYPHS.separator} @ for files${shell} ${GLYPHS.separator} ctrl+o tools ${GLYPHS.separator} ctrl+t thinking ${GLYPHS.separator} ctrl+c to exit`,
      { dim: true },
      depth,
    );
    return [
      "",
      `${MARGIN}${styleText(AGENT_LABEL, { accent: true, bold: true }, depth)}${version}  ${styleText(
        "a general-purpose, extensible agent",
        { dim: true },
        depth,
      )}`,
      ...wrapText(affordances, width - MARGIN.length).map((line) => MARGIN + line),
      "",
    ];
  }

  tickSpinner(): void {
    this.spinner.tick();
  }

  appendTranscript(lines: string[]): void {
    if (lines.length > 0) this.pushTranscript({ kind: "lines", lines: [...lines] });
  }

  replaceTranscript(messages: readonly AgentMessage[], prefix: string[] = []): void {
    this.transcript = prefix.length > 0 ? [{ kind: "lines", lines: [...prefix] }] : [];
    this.transcriptVersion++;
    this.transcriptCache = undefined;
    this.pendingTools.clear();
    this.pendingInputs = [];
    this.streaming = undefined;
    this.streamingCache = undefined;

    const calls = new Map<string, { toolName: string; args: unknown }>();
    for (const message of messages) {
      if (message.role === "user") {
        const text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (text) this.pushTranscript({ kind: "user", text });
        continue;
      }
      if (message.role === "assistant") {
        const lines = this.assistantRows(message);
        if (lines.length > 0) {
          this.pushTranscript({
            kind: "assistant",
            message,
            rendered: { width: this.options.width, lines },
          });
        }
        for (const block of message.content) {
          if (block.type === "toolCall") {
            calls.set(block.id, { toolName: block.name, args: block.arguments });
          }
        }
        continue;
      }
      if (message.role === "toolResult") {
        const call = calls.get(message.toolCallId);
        this.pushTranscript({
          kind: "tool",
          info: {
            toolName: call?.toolName ?? message.toolName,
            args: call?.args ?? {},
            result: message,
          },
        });
        calls.delete(message.toolCallId);
      }
    }
  }

  renderScreen(): string[] {
    return [...this.transcriptRows(), ...this.toTerminalRows(this.renderManaged())];
  }

  renderTranscript(): string[] {
    return [...this.transcriptRows()];
  }

  renderBottom(): string[] {
    return this.fitToViewport(this.toTerminalRows(this.renderManaged()));
  }

  private transcriptRows(): string[] {
    const cached = this.transcriptCache;
    if (
      cached?.version === this.transcriptVersion &&
      cached.width === this.options.width &&
      cached.expanded === this.toolOutputExpanded
    ) {
      return cached.rows;
    }
    const logical = this.transcript.flatMap((item) => {
      if (item.kind === "lines") return item.lines;
      if (item.kind === "user") return [...userCell(item.text, this.ctx), ""];
      if (item.kind === "assistant") {
        if (item.rendered?.width !== this.options.width) {
          item.rendered = {
            width: this.options.width,
            lines: this.assistantRows(item.message),
          };
        }
        return [...item.rendered.lines, ""];
      }
      if (
        item.rendered?.width !== this.options.width ||
        item.rendered.expanded !== this.toolOutputExpanded
      ) {
        item.rendered = {
          width: this.options.width,
          expanded: this.toolOutputExpanded,
          lines: this.registry.render(
            { ...item.info, expanded: this.toolOutputExpanded },
            this.ctx,
          ),
        };
      }
      return item.rendered.lines;
    });
    const rows = this.toTerminalRows(logical);
    this.transcriptCache = {
      version: this.transcriptVersion,
      width: this.options.width,
      expanded: this.toolOutputExpanded,
      rows,
    };
    return rows;
  }

  // The live activity and composer region, rebuilt from state on every paint.
  private renderManaged(): string[] {
    const { width, depth } = this.ctx;
    const lines: string[] = [];
    const height = this.options.height ?? 24;

    // Live region: streaming assistant text and running tool cells, so a long
    // turn is never a frozen screen with only a spinner.
    if (this.streaming && this.streaming.trim().length > 0) lines.push(...this.streamingRows());
    for (const pending of this.pendingTools.values()) {
      lines.push(
        ...this.registry.render(
          {
            toolName: pending.toolName,
            args: pending.args,
            running: pending.running === true,
            argsStreaming: pending.argsStreaming === true,
            expanded: this.toolOutputExpanded,
          },
          this.ctx,
        ),
      );
      const output = pending.output.display(this.toolOutputExpanded ? EXPANDED_TOOL_ROWS : 4);
      for (const line of output) {
        if (line.trim().length > 0) lines.push(...toolOutputCell(line, this.ctx));
      }
    }
    for (const task of this.backgroundTasks.values()) {
      const tail = [...task.tail, ...(task.partial.length > 0 ? [task.partial] : [])].slice(-3);
      lines.push(
        ...taskCell(
          {
            taskId: task.taskId,
            command: task.command,
            status: "running",
            tail,
          },
          this.ctx,
        ),
      );
    }

    lines.push(composerRule(width, depth));

    const visiblePending = this.pendingInputs.slice(-PENDING_INPUT_ROWS);
    const hiddenPending = this.pendingInputs.length - visiblePending.length;
    if (hiddenPending > 0) {
      lines.push(
        MARGIN +
          styleText(
            `… ${hiddenPending} earlier queued input${hiddenPending === 1 ? "" : "s"}`,
            { dim: true },
            depth,
          ),
      );
    }
    for (const [index, pending] of visiblePending.entries()) {
      lines.push(
        ...queuedInputPreview(
          pending.kind,
          pending.text,
          width,
          depth,
          index === visiblePending.length - 1 && this.options.callbacks.onEditQueued !== undefined,
        ),
      );
    }

    if (this.mode === "approval" && this.approvals[0]) {
      const request = this.approvals[0];
      const preview = request.preview;
      lines.push(
        ...approvalOverlay(
          {
            title: request.description,
            ...(preview?.kind === "diff"
              ? {
                  diff: {
                    path: preview.file.path,
                    added: preview.file.added,
                    removed: preview.file.removed,
                    lines: diffLinesFromHunks(preview.file.hunks),
                  },
                }
              : {
                  preview: preview?.kind === "text" ? preview.lines : [request.pattern],
                }),
            maxPreviewRows: Math.max(3, Math.min(12, height - 8)),
            selectedIndex: this.approvalIndex,
          },
          width,
          depth,
        ),
      );
    } else {
      if (this.mode === "picker" && this.picker) {
        const query =
          this.picker.filterable && this.pickerQuery
            ? ` ${GLYPHS.separator} ${this.pickerQuery}`
            : "";
        const back = this.picker.onBack ? ` ${GLYPHS.separator} ← back` : "";
        lines.push(
          MARGIN + styleText(`${this.picker.title}${query}${back}`, { bold: true }, depth),
        );
        lines.push(...this.commandList.render(width, depth));
      } else if (this.mode === "prompt" && this.prompt) {
        lines.push(MARGIN + styleText(this.prompt.title, { bold: true }, depth));
        lines.push(
          ...(this.prompt.secret
            ? this.promptEditor.renderMasked(width, depth)
            : this.promptEditor.render(width, depth)),
        );
      } else {
        if (this.isShellMode) {
          lines.push(
            MARGIN +
              styleText("shell mode", { toolExec: true, bold: true }, depth) +
              styleText(` ${GLYPHS.separator} runs locally`, { dim: true }, depth),
          );
        }
        lines.push(...this.editor.render(width, depth));
        if (this.mode === "select" || this.mode === "mention") {
          lines.push(...this.commandList.render(width, depth));
        }
      }
    }

    // Closes the box opened above: the composer/overlay content sits between
    // the two rules, and the running-hint row below is footer-adjacent status
    // (it feeds the same idle `hint` slot the footer renders when not
    // running), not part of the input itself.
    lines.push(composerRule(width, depth));

    const toolHint = "ctrl+o";
    if (this.running) {
      const compactStage =
        this.compactionStage === "clearing-tool-output"
          ? "clearing tool output"
          : this.compactionStage === "installing"
            ? "installing checkpoint"
            : "summarizing earlier context";
      const elapsed = formatDuration(Date.now() - this.runStartedAt);
      lines.push(
        `${MARGIN}${this.spinner.render(depth)}${styleText(
          this.compacting
            ? ` ${elapsed} ${GLYPHS.separator} compacting context ${GLYPHS.separator} ${compactStage} ${GLYPHS.separator} enter queue ${GLYPHS.separator} esc cancel`
            : ` ${elapsed} ${GLYPHS.separator} enter steer ${GLYPHS.separator} tab follow-up ${GLYPHS.separator} esc/ctrl+c interrupt ${GLYPHS.separator} ${toolHint}`,
          { dim: true },
          depth,
        )}`,
      );
    }
    const hint = this.running
      ? undefined
      : this.ctrlCPending
        ? "press ctrl+c again to exit"
        : this.isShellMode
          ? `shell mode ${GLYPHS.separator} enter to run ${GLYPHS.separator} esc to cancel`
          : `${toolHint} ${GLYPHS.separator} think ${this.thinkingLevel} ${GLYPHS.separator} ctrl+t`;
    lines.push(...footer({ ...this.footerData, ...(hint ? { hint } : {}) }, width, depth));
    return lines;
  }

  private streamingRows(): string[] {
    if (!this.streaming) return [];
    const height = this.options.height ?? 24;
    const cached = this.streamingCache;
    if (
      cached?.text === this.streaming &&
      cached.width === this.options.width &&
      cached.height === height
    ) {
      return cached.rows;
    }
    const maxChars = Math.max(
      MIN_STREAMING_PREVIEW_CHARS,
      Math.min(MAX_STREAMING_PREVIEW_CHARS, this.options.width * height * STREAMING_VIEWPORTS),
    );
    const preview = streamingMarkdownPreview(this.streaming, maxChars);
    const rows = this.toTerminalRows(agentCell(preview.text, this.ctx));
    this.streamingCache = {
      text: this.streaming,
      width: this.options.width,
      height,
      rows,
    };
    return rows;
  }

  private pushTranscript(item: TranscriptItem): void {
    this.transcript.push(item);
    this.transcriptVersion++;
    this.transcriptCache = undefined;
  }

  private assistantRows(message: AssistantMessage): string[] {
    const lines: string[] = [];
    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking.trim()) {
        lines.push(...thinkingCell(block.thinking, this.ctx));
      } else if (block.type === "text" && block.text.trim()) {
        lines.push(...this.toTerminalRows(agentCell(block.text, this.ctx)));
      }
    }
    return lines;
  }

  private toTerminalRows(lines: string[]): string[] {
    return terminalRows(lines, this.options.width);
  }

  private fitToViewport(lines: string[]): string[] {
    const limit = Math.max(1, (this.options.height ?? 24) - 1);
    if (lines.length <= limit) return lines;
    if (limit === 1) return lines.slice(-1);
    const hidden = lines.length - limit + 1;
    return [
      MARGIN + styleText(`… ${hidden} rows above hidden`, { dim: true }, this.options.depth),
      ...lines.slice(-(limit - 1)),
    ];
  }

  // Mirrors Escape: aborts an active run rather than killing the session
  // outright. When idle, clears composer text like a normal interrupt (pi's
  // behavior); an empty composer arms a "press again" exit window instead of
  // exiting immediately, so a single stray keystroke can't drop in-flight work.
  private handleCtrlC(): void {
    if (this.running) {
      this.options.callbacks.onAbort();
      this.ctrlCArmedAt = 0;
      return;
    }
    if (this.mode === "composing" && this.editor.text.length > 0) {
      this.editor.setText("");
      this.ctrlCArmedAt = 0;
      return;
    }
    if (this.ctrlCPending) {
      this.options.callbacks.onExit();
      return;
    }
    this.ctrlCArmedAt = Date.now();
  }

  handleInput(event: InputEvent): void {
    // Any input other than the confirming Ctrl+C disarms the exit window.
    if (
      this.ctrlCArmedAt !== 0 &&
      !(event.type === "key" && event.key.ctrl && event.key.name === "c")
    ) {
      this.ctrlCArmedAt = 0;
    }
    if (event.type === "paste") {
      if (this.mode === "prompt") {
        this.promptEditor.insert(event.text.replace(/[\r\n]+/g, ""));
        return;
      }
      if (this.mode === "picker" && this.picker?.filterable) {
        this.pickerQuery += event.text.replace(/\s+/g, " ");
        this.refreshPicker();
        return;
      }
      // A paste never submits, however many newlines it contains.
      this.editor.insert(event.text);
      return;
    }
    if (event.type !== "key") return;
    const key = event.key;

    if (key.ctrl && key.name === "c") {
      this.handleCtrlC();
      return;
    }

    if (key.ctrl && key.name === "o") {
      this.toolOutputExpanded = !this.toolOutputExpanded;
      this.transcriptCache = undefined;
      return;
    }

    // Ctrl+T cycles thinking depth without leaving the composer.
    if (key.ctrl && key.name === "t") {
      const levels = this.thinkingLevels;
      if (levels.length < 2) return;
      const next = levels[(levels.indexOf(this.thinkingLevel) + 1) % levels.length] as string;
      this.thinkingLevel = next;
      this.options.callbacks.onThinkingChange?.(next);
      return;
    }

    // Shift+Tab cycles permission modes. The mode list itself is
    // profile-owned (the surface decides what "next" means), so this is a
    // bare signal — unlike Ctrl+T, App holds no permission-mode state.
    if (key.shift && key.name === "tab") {
      this.options.callbacks.onCyclePermissionMode?.();
      return;
    }

    if (this.mode === "approval") {
      this.handleApprovalKey(key);
      return;
    }

    if (this.mode === "picker") {
      this.handlePickerKey(key);
      return;
    }

    if (this.mode === "prompt") {
      this.handlePromptKey(key);
      return;
    }

    if (this.mode === "select" || this.mode === "mention") {
      if (this.mode === "mention") this.handleMentionKey(key);
      else this.handleSelectKey(key);
      return;
    }

    // Ctrl+J inserts a newline on every terminal — it's a raw control byte
    // (0x0A), not a reported modifier, so unlike Shift/Ctrl/Alt+Enter it needs
    // no terminal protocol support at all.
    if (key.ctrl && key.name === "j") {
      this.editor.newline();
      return;
    }

    switch (key.name) {
      case "escape":
        if (this.running) this.options.callbacks.onAbort();
        else if (this.isShellMode) this.editor.setText("");
        return;
      case "return": {
        // Two ways to insert a newline instead of submitting. Shift/Ctrl/Alt+Enter
        // work only where the terminal reports the modifier (kitty keyboard
        // protocol / xterm modifyOtherKeys — see terminal.ts). A trailing
        // backslash works on every terminal, needing no modifier reporting: an
        // odd run of backslashes before the cursor is a line continuation, so
        // one backslash is consumed and a newline is inserted.
        if (key.shift || key.ctrl || key.alt) {
          this.editor.newline();
          return;
        }
        const trailingBackslashes = /\\*$/.exec(this.editor.textBeforeCursor)?.[0].length ?? 0;
        if (trailingBackslashes % 2 === 1) {
          this.editor.backspace();
          this.editor.newline();
          return;
        }
        if (this.isShellMode && this.editor.text.slice(1).trim().length === 0) return;
        const text = this.editor.submit();
        if (text.trim().length === 0) return;
        if (text.startsWith("!") && this.options.callbacks.onShell) {
          this.options.callbacks.onShell(text.slice(1).trim());
        } else if (text.startsWith("/") && this.options.callbacks.onCommand) {
          this.options.callbacks.onCommand(text);
        } else {
          const queueDuringCompaction =
            this.running && this.compacting && this.options.callbacks.onFollowUp;
          const accepted = queueDuringCompaction
            ? this.options.callbacks.onFollowUp?.(text)
            : this.running && this.options.callbacks.onSteer
              ? this.options.callbacks.onSteer(text)
              : this.options.callbacks.onSubmit(text);
          if (this.running && accepted !== false) {
            this.pendingInputs.push({ kind: queueDuringCompaction ? "follow-up" : "steer", text });
          }
        }
        return;
      }
      case "tab": {
        if (!this.running || !this.options.callbacks.onFollowUp) return;
        const text = this.editor.submit();
        if (text.trim().length === 0) return;
        if (this.options.callbacks.onFollowUp(text) !== false) {
          this.pendingInputs.push({ kind: "follow-up", text });
        }
        return;
      }
      case "up": {
        if (key.alt) {
          const pending = this.pendingInputs.at(-1);
          if (
            !pending ||
            !this.options.callbacks.onEditQueued ||
            this.options.callbacks.onEditQueued(pending.kind, pending.text) === false
          ) {
            return;
          }
          this.pendingInputs.pop();
          const draft = this.editor.text;
          this.editor.setText(
            [pending.text, draft].filter((part) => part.trim().length > 0).join("\n\n"),
          );
          return;
        }
        if (!this.editor.recallHistory("up")) this.editor.move("up");
        return;
      }
      case "backspace":
        this.editor.backspace();
        return;
      case "down":
        if (!this.editor.recallHistory(key.name)) this.editor.move(key.name);
        return;
      case "left":
        if (this.editor.isEmpty && this.options.callbacks.onDetach) {
          this.options.callbacks.onDetach();
          return;
        }
        this.editor.move("left");
        return;
      case "right":
      case "home":
      case "end":
        this.editor.move(key.name);
        return;
      case "space":
        this.editor.insert(" ");
        return;
      default:
        if (key.alt || key.ctrl) return;
        if (key.text) {
          this.editor.insert(key.text);
          // "/" at the start of an empty line opens the command popup.
          if (key.text === "/" && this.editor.text === "/") {
            this.openCommandMenu();
          }
          // "@" anywhere opens the file-mention popup.
          if (key.text === "@" && this.options.callbacks.onMentionQuery) {
            // Anchor at the cursor, so a mention typed mid-buffer completes in
            // place instead of eating the rest of the line.
            this.mentionStart = this.editor.offset - 1;
            this.commandList.setItems(this.options.callbacks.onMentionQuery(""));
            this.mode = "mention";
          }
        }
    }
  }

  private handleApprovalKey(key: Key): void {
    const request = this.approvals[0];
    if (!request) return;
    if (key.name === "left") {
      this.approvalIndex =
        (this.approvalIndex - 1 + APPROVAL_OPTIONS.length) % APPROVAL_OPTIONS.length;
      return;
    }
    if (key.name === "right" || key.name === "tab") {
      this.approvalIndex = (this.approvalIndex + 1) % APPROVAL_OPTIONS.length;
      return;
    }
    if (key.name === "escape") {
      this.options.callbacks.onPermissionReply?.(request.id, "deny", false);
      return;
    }
    if (key.name === "return") {
      const option = APPROVAL_OPTIONS[this.approvalIndex];
      const outcome = option === "deny" ? "deny" : "allow";
      this.options.callbacks.onPermissionReply?.(request.id, outcome, option === "always allow");
    }
  }

  private handlePickerKey(key: Key): void {
    const picker = this.picker;
    if (!picker) return;
    if (key.name === "up" || key.name === "down") {
      this.commandList.move(key.name);
      return;
    }
    if (key.name === "left" && picker.onBack) {
      const onBack = picker.onBack;
      this.picker = undefined;
      this.pickerQuery = "";
      this.mode = "composing";
      onBack();
      return;
    }
    if (key.name === "escape") {
      const onCancel = picker.onCancel;
      this.picker = undefined;
      this.pickerQuery = "";
      this.mode = "composing";
      onCancel?.();
      return;
    }
    if (picker.filterable && key.name === "backspace") {
      this.pickerQuery = [...this.pickerQuery].slice(0, -1).join("");
      this.refreshPicker();
      return;
    }
    if (key.name === "return") {
      const selected = this.commandList.selected;
      if (!selected) return;
      this.picker = undefined;
      this.pickerQuery = "";
      this.mode = "composing";
      picker.onChoose(selected.value ?? selected.label);
      return;
    }
    if (picker.filterable && !key.ctrl && !key.alt && key.text) {
      this.pickerQuery += key.text;
      this.refreshPicker();
    }
  }

  private handlePromptKey(key: Key): void {
    const prompt = this.prompt;
    if (!prompt) return;
    if (key.name === "escape") {
      this.prompt = undefined;
      this.promptEditor.setText("");
      this.mode = "composing";
      prompt.onCancel?.();
      return;
    }
    if (key.name === "return") {
      const value = this.promptEditor.text;
      if (!value.trim()) return;
      this.prompt = undefined;
      this.promptEditor.setText("");
      this.mode = "composing";
      prompt.onSubmit(value);
      return;
    }
    if (key.name === "backspace") {
      this.promptEditor.backspace();
      return;
    }
    if (key.name === "left" || key.name === "right" || key.name === "home" || key.name === "end") {
      this.promptEditor.move(key.name);
      return;
    }
    if (key.name === "space") {
      this.promptEditor.insert(" ");
      return;
    }
    if (!key.ctrl && !key.alt && key.text) this.promptEditor.insert(key.text);
  }

  private refreshPicker(): void {
    const picker = this.picker;
    if (!picker) return;
    const query = this.pickerQuery.trim();
    if (!query) {
      this.commandList.setItems(picker.items);
      return;
    }
    this.commandList.setItems(
      picker.items
        .map((item, index) => ({
          item,
          index,
          score: fuzzyScore(`${item.label} ${item.description ?? ""}`, query),
        }))
        .filter(
          (candidate): candidate is typeof candidate & { score: number } =>
            candidate.score !== undefined,
        )
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .map((candidate) => candidate.item),
    );
  }

  // The `@` popup completes a path into the composer rather than submitting.
  // The `/` popup does the same on tab; see handleSelectKey.
  private handleMentionKey(key: Key): void {
    if (key.name === "up" || key.name === "down") {
      this.commandList.move(key.name);
      return;
    }
    if (key.name === "escape") {
      this.mode = "composing";
      this.mentionStart = -1;
      return;
    }
    if (key.name === "return" || key.name === "tab") {
      const selected = this.commandList.selected;
      if (selected && this.mentionStart >= 0) {
        // Replace just the "@query" span; the unsent suffix is preserved.
        this.editor.spliceBeforeCursor(this.mentionStart, `${selected.label} `);
      }
      this.mode = "composing";
      this.mentionStart = -1;
      return;
    }
    if (key.name === "backspace") {
      this.editor.backspace();
      if (this.editor.offset <= this.mentionStart) {
        this.mode = "composing";
        this.mentionStart = -1;
        return;
      }
      this.refreshMentions();
      return;
    }
    if (key.text) {
      if (key.text === " ") {
        this.editor.insert(" ");
        this.mode = "composing";
        this.mentionStart = -1;
        return;
      }
      this.editor.insert(key.text);
      this.refreshMentions();
    }
  }

  private filterCommands(): void {
    const query = this.editor.text.slice(1).toLowerCase();
    this.commandList.setItems(
      query.length === 0
        ? this.commands
        : this.commands.filter((c) => c.label.toLowerCase().startsWith(query)),
    );
  }

  private refreshMentions(): void {
    const query = this.editor.text.slice(this.mentionStart + 1, this.editor.offset);
    this.commandList.setItems(this.options.callbacks.onMentionQuery?.(query) ?? []);
  }

  private handleSelectKey(key: Key): void {
    if (key.name === "up" || key.name === "down") {
      this.commandList.move(key.name);
      return;
    }
    if (key.name === "escape") {
      this.mode = "composing";
      return;
    }
    // Tab completes into the composer rather than running, so a command that
    // takes arguments has somewhere to type them. The popup closes because its
    // filter is a prefix match on the whole line, which the trailing space and
    // any argument would immediately empty. Mirrors the `@` popup.
    if (key.name === "tab") {
      const selected = this.commandList.selected;
      if (!selected) return;
      this.editor.setText(`/${selected.label} `);
      this.mode = "composing";
      return;
    }
    if (key.name === "return") {
      const typed = this.editor.text;
      const selected = this.commandList.selected;
      this.mode = "composing";
      this.editor.submit();
      // Text the user typed wins when it carries arguments or names a command
      // the popup has filtered away; the highlighted item is only a shortcut.
      const hasArgs = typed.trim().includes(" ");
      const command = hasArgs || !selected ? typed.trim() : `/${selected.label}`;
      if (command.length > 1) this.options.callbacks.onCommand?.(command);
      return;
    }
    if (key.name === "backspace") {
      this.editor.backspace();
      if (!this.editor.text.startsWith("/")) {
        this.mode = "composing";
        return;
      }
      // Re-filter on the shortened query: deleting a character must widen the
      // list again rather than leaving it stuck on the previous filter.
      this.filterCommands();
      return;
    }
    if (key.text) {
      this.editor.insert(key.text);
      this.filterCommands();
    }
  }
}

function fuzzyScore(value: string, query: string): number | undefined {
  const candidate = value.toLowerCase();
  const needle = query.toLowerCase();
  let position = 0;
  let previous = -2;
  let score = 0;

  for (const char of needle) {
    const found = candidate.indexOf(char, position);
    if (found === -1) return undefined;
    const boundary = found === 0 || /[\s/_.-]/.test(candidate[found - 1] ?? "");
    score += found - previous - 1;
    if (found === previous + 1) score -= 4;
    if (boundary) score -= 3;
    previous = found;
    position = found + 1;
  }

  const contiguous = candidate.indexOf(needle);
  if (contiguous !== -1) score -= 20 - Math.min(contiguous, 10);
  return score;
}
