// The mu integration layer: an AgentEvent consumer that commits transcript
// cells to scrollback and keeps the bottom region (composer / approval / footer)
// up to date. It holds no agent logic — everything arrives as events.
import type { AgentEvent, AssistantMessage, PermissionRequest } from "@mu/core";
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
  items: { label: string; description?: string }[];
  onChoose: (label: string) => void;
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
  // Explicit user shell escape. The leading `!` stays in editor history, but
  // only the command text is passed to the surface.
  onShell?: (command: string) => void;
  // Supplies file paths for the `@` mention popup.
  onMentionQuery?: (query: string) => { label: string; description?: string }[];
  onAbort: () => void;
  onExit: () => void;
  onPermissionReply?: (requestId: string, outcome: "allow" | "deny", remember: boolean) => void;
  onCommand?: (text: string) => void;
  onThinkingChange?: (level: string) => void;
}

export interface AppOptions {
  width: number;
  height?: number;
  depth: ColorDepth;
  model: string;
  cwd?: string;
  contextWindow?: number;
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

const TASK_TAIL_LINES = 5;
const TASK_PARTIAL_CHARS = 2_000;
const LIVE_TOOL_OUTPUT_LINES = 50;
const LIVE_ASSISTANT_ROWS = 6;
const EXPANDED_TOOL_ROWS = 24;
const RETAINED_TOOLS = 20;

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
type RetainedTurnItem =
  | { kind: "assistant"; message: AssistantMessage }
  | { kind: "tool"; info: ToolRenderInfo };

export class App {
  readonly editor = new Editor();
  readonly registry: RendererRegistry;
  private spinner = new Spinner();
  private commandList = new SelectList([]);
  private mode: AppMode = "composing";
  private running = false;
  // A parallel-safe tool batch can raise several asks at once, so they queue
  // rather than overwriting each other. One is shown; resolving removes only
  // the matching id and advances to the next.
  private approvals: PermissionRequest[] = [];
  private approvalIndex = 0;
  private pendingTools = new Map<string, PendingTool>();
  private retainedTurn: RetainedTurnItem[] = [];
  private toolOutputExpanded = false;
  private backgroundTasks = new Map<string, LiveTask>();
  // The assistant message currently streaming, shown live above the composer.
  private streaming: string | undefined;
  private streamingCommittedRows = 0;
  private lastError: string | undefined;
  private footerData: FooterData;
  private commands: { label: string; description?: string }[] = [];
  private thinkingLevel = "off";
  private picker: PickerRequest | undefined;
  private pickerQuery = "";
  private prompt: InputPromptRequest | undefined;
  private promptEditor = new Editor();
  private mentionStart = -1;

  constructor(private options: AppOptions) {
    this.registry = options.registry ?? new RendererRegistry();
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

  setThinking(level: string): void {
    this.thinkingLevel = level;
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

  // Events that produce transcript output return the lines to commit to
  // scrollback; everything else only affects the bottom region.
  handleEvent(event: AgentEvent): string[] {
    switch (event.type) {
      case "agent_start":
        this.running = true;
        this.retainedTurn = [];
        return [];

      case "agent_end": {
        this.running = false;
        if (event.reason !== "error") return [];
        // Show *why* it failed. "run ended with an error" tells the user
        // nothing and hides actionable messages like a missing API key.
        const detail = this.lastError ?? "the provider returned an error";
        this.lastError = undefined;
        return [...errorCell(detail, this.ctx), ""];
      }

      case "message_start":
        if (event.message.role === "assistant") {
          this.streaming = "";
          this.streamingCommittedRows = 0;
        }
        return [];

      case "message_update":
        if (event.delta.kind === "text_delta") {
          this.streaming = (this.streaming ?? "") + event.delta.text;
          const rows = this.streamingRows();
          const commitThrough = Math.max(0, rows.length - LIVE_ASSISTANT_ROWS);
          if (commitThrough > this.streamingCommittedRows) {
            const committed = rows.slice(this.streamingCommittedRows, commitThrough);
            this.streamingCommittedRows = commitThrough;
            return committed;
          }
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
          return text ? [...userCell(text, this.ctx), ""] : [];
        }
        if (message.role === "assistant") {
          if (this.assistantRows(message).length > 0) {
            this.retainedTurn.push({ kind: "assistant", message });
          }
          let committedRows = this.streamingCommittedRows;
          this.streaming = undefined;
          this.streamingCommittedRows = 0;
          if (message.stopReason === "error" && message.errorMessage) {
            this.lastError = message.errorMessage;
          }
          const lines: string[] = [];
          for (const block of message.content) {
            if (block.type === "thinking" && block.thinking.trim()) {
              lines.push(...thinkingCell(block.thinking, this.ctx));
            } else if (block.type === "text" && block.text.trim()) {
              const textRows = this.toTerminalRows(agentCell(block.text, this.ctx));
              lines.push(...textRows.slice(committedRows));
              committedRows = Math.max(0, committedRows - textRows.length);
            }
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
        this.retainedTurn.push({ kind: "tool", info });
        this.trimRetainedTurn();
        return this.registry.render(info, this.ctx);
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

      case "compaction_end":
        return [...compactionCell(event.tokensFreed, this.ctx), ""];

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
        return [
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
    const affordances = styleText(
      `${this.footerData.model} ${GLYPHS.separator} / for commands ${GLYPHS.separator} @ for files${shell} ${GLYPHS.separator} ctrl+o tools ${GLYPHS.separator} ctrl+t thinking ${GLYPHS.separator} ctrl+c to exit`,
      { dim: true },
      depth,
    );
    return [
      "",
      `${MARGIN}${styleText(AGENT_LABEL, { accent: true, bold: true }, depth)}  ${styleText(
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

  // The managed bottom region, rebuilt from state on every paint.
  renderBottom(): string[] {
    const { width, depth } = this.ctx;
    const lines: string[] = [];
    const height = this.options.height ?? 24;
    const expandedRows = Math.max(3, Math.min(EXPANDED_TOOL_ROWS, height - 12));

    if (this.toolOutputExpanded && this.retainedTurn.some((item) => item.kind === "tool")) {
      const expanded = this.retainedTurn.flatMap((item) =>
        item.kind === "tool"
          ? this.registry.render({ ...item.info, expanded: true }, this.ctx)
          : [...this.assistantRows(item.message), ""],
      );
      lines.push(
        MARGIN +
          styleText(
            `${GLYPHS.rule} expanded turn ${GLYPHS.separator} ctrl+o to collapse`,
            { dim: true },
            depth,
          ),
      );
      if (expanded.length <= expandedRows) {
        lines.push(...expanded);
      } else {
        const headRows = Math.floor((expandedRows - 1) / 2);
        const tailRows = expandedRows - headRows - 1;
        const omitted = expanded.length - headRows - tailRows;
        lines.push(
          ...expanded.slice(0, headRows),
          MARGIN +
            styleText(
              `${GLYPHS.rule} … +${omitted} lines ${GLYPHS.separator} ctrl+o keeps this view bounded`,
              { dim: true },
              depth,
            ),
          ...expanded.slice(-tailRows),
        );
      }
    }

    // Live region: streaming assistant text and running tool cells, so a long
    // turn is never a frozen screen with only a spinner.
    if (this.streaming && this.streaming.trim().length > 0) {
      lines.push(...this.streamingRows().slice(this.streamingCommittedRows));
    }
    for (const pending of this.pendingTools.values()) {
      lines.push(
        ...this.registry.render(
          {
            toolName: pending.toolName,
            args: pending.args,
            running: pending.running === true,
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
              styleText("shell mode", { accent: true, bold: true }, depth) +
              styleText(` ${GLYPHS.separator} runs locally`, { dim: true }, depth),
          );
        }
        lines.push(...this.editor.render(width, depth));
        if (this.mode === "select" || this.mode === "mention") {
          lines.push(...this.commandList.render(width, depth));
        }
      }
    }

    const toolHint = "ctrl+o";
    const hint = this.running
      ? `${this.spinner.render(depth)} esc to interrupt ${GLYPHS.separator} ${toolHint}`
      : this.isShellMode
        ? `shell mode ${GLYPHS.separator} enter to run ${GLYPHS.separator} esc to cancel`
        : `${toolHint} ${GLYPHS.separator} think ${this.thinkingLevel} ${GLYPHS.separator} ctrl+t`;
    lines.push(...footer({ ...this.footerData, hint }, width, depth));
    return this.fitToViewport(this.toTerminalRows(lines));
  }

  private streamingRows(): string[] {
    if (!this.streaming) return [];
    return this.toTerminalRows(agentCell(this.streaming, this.ctx));
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

  private trimRetainedTurn(): void {
    const toolCount = this.retainedTurn.filter((item) => item.kind === "tool").length;
    if (toolCount <= RETAINED_TOOLS) return;
    const oldestTool = this.retainedTurn.findIndex((item) => item.kind === "tool");
    this.retainedTurn = this.retainedTurn.slice(oldestTool + 1);
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

  handleInput(event: InputEvent): void {
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
      this.options.callbacks.onExit();
      return;
    }

    if (key.ctrl && key.name === "o") {
      this.toolOutputExpanded = !this.toolOutputExpanded;
      return;
    }

    // Ctrl+T cycles thinking depth without leaving the composer.
    if (key.ctrl && key.name === "t") {
      const levels = ["off", "low", "medium", "high"];
      const next = levels[(levels.indexOf(this.thinkingLevel) + 1) % levels.length] as string;
      this.thinkingLevel = next;
      this.options.callbacks.onThinkingChange?.(next);
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

    switch (key.name) {
      case "escape":
        if (this.running) this.options.callbacks.onAbort();
        else if (this.isShellMode) this.editor.setText("");
        return;
      case "return": {
        if (this.isShellMode && this.editor.text.slice(1).trim().length === 0) return;
        const text = this.editor.submit();
        if (text.trim().length === 0) return;
        if (text.startsWith("!") && this.options.callbacks.onShell) {
          this.options.callbacks.onShell(text.slice(1).trim());
        } else if (text.startsWith("/") && this.options.callbacks.onCommand) {
          this.options.callbacks.onCommand(text);
        } else {
          this.options.callbacks.onSubmit(text);
        }
        return;
      }
      case "backspace":
        this.editor.backspace();
        return;
      case "up":
      case "down":
        if (!this.editor.recallHistory(key.name)) this.editor.move(key.name);
        return;
      case "left":
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
      picker.onChoose(selected.label);
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
