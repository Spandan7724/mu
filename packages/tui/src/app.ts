// The mu integration layer: an AgentEvent consumer that commits transcript
// cells to scrollback and keeps the bottom region (composer / approval / footer)
// up to date. It holds no agent logic — everything arrives as events.
import type { AgentEvent, PermissionRequest } from "@mu/core";
import {
  agentCell,
  compactionCell,
  errorCell,
  type RenderContext,
  taskCell,
  thinkingCell,
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

export type AppMode = "composing" | "approval" | "select" | "mention" | "picker";

export interface PickerRequest {
  title: string;
  items: { label: string; description?: string }[];
  onChoose: (label: string) => void;
}

export interface AppCallbacks {
  onSubmit: (text: string) => void;
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
  private pendingTools = new Map<string, ToolRenderInfo & { tail: string[] }>();
  private backgroundTasks = new Map<string, LiveTask>();
  // The assistant message currently streaming, shown live above the composer.
  private streaming: string | undefined;
  private lastError: string | undefined;
  private footerData: FooterData;
  private commands: { label: string; description?: string }[] = [];
  private thinkingLevel = "off";
  private picker: PickerRequest | undefined;
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

  // Opens a selection list (used by /model and /resume).
  openPicker(request: PickerRequest): void {
    this.picker = request;
    this.commandList.setItems(request.items);
    this.mode = "picker";
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
        if (event.message.role === "assistant") this.streaming = "";
        return [];

      case "message_update":
        if (event.delta.kind === "text_delta") {
          this.streaming = (this.streaming ?? "") + event.delta.text;
        }
        return [];

      case "tool_execution_update": {
        const pending = this.pendingTools.get(event.toolCallId);
        if (pending) {
          for (const block of event.partial) {
            if (block.type === "text") pending.tail.push(...block.text.split("\n"));
          }
          // Bounded tail — a chatty tool must not grow the region without limit.
          if (pending.tail.length > 5) pending.tail = pending.tail.slice(-5);
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
          this.streaming = undefined;
          if (message.stopReason === "error" && message.errorMessage) {
            this.lastError = message.errorMessage;
          }
          const lines: string[] = [];
          for (const block of message.content) {
            if (block.type === "thinking" && block.thinking.trim()) {
              lines.push(...thinkingCell(block.thinking, this.ctx));
            } else if (block.type === "text" && block.text.trim()) {
              lines.push(...agentCell(block.text, this.ctx));
            }
          }
          return lines.length > 0 ? [...lines, ""] : [];
        }
        return [];
      }

      case "tool_execution_start":
        this.pendingTools.set(event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
          running: true,
          tail: [],
        });
        return [];

      case "tool_execution_end": {
        const pending = this.pendingTools.get(event.toolCallId);
        this.pendingTools.delete(event.toolCallId);
        const info: ToolRenderInfo = {
          toolName: pending?.toolName ?? event.result.toolName,
          args: pending?.args ?? {},
          result: event.result,
        };
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
    const { depth } = this.ctx;
    return [
      "",
      `${MARGIN}${styleText(AGENT_LABEL, { accent: true, bold: true }, depth)}  ${styleText(
        "a general-purpose, extensible agent",
        { dim: true },
        depth,
      )}`,
      `${MARGIN}${styleText(
        `${this.footerData.model} ${GLYPHS.separator} / for commands ${GLYPHS.separator} @ for files ${GLYPHS.separator} ctrl+t thinking ${GLYPHS.separator} ctrl+c to exit`,
        { dim: true },
        depth,
      )}`,
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

    // Live region: streaming assistant text and running tool cells, so a long
    // turn is never a frozen screen with only a spinner.
    if (this.streaming && this.streaming.trim().length > 0) {
      lines.push(...agentCell(this.streaming, this.ctx).slice(-6));
    }
    for (const pending of this.pendingTools.values()) {
      lines.push(
        ...this.registry.render(
          { toolName: pending.toolName, args: pending.args, running: true },
          this.ctx,
        ),
      );
      for (const line of pending.tail.slice(-3)) {
        if (line.trim().length > 0) lines.push(`${MARGIN}${GLYPHS.rule} ${line}`);
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
      lines.push(
        ...approvalOverlay(
          {
            title: this.approvals[0].description,
            preview: [this.approvals[0].pattern],
            selectedIndex: this.approvalIndex,
          },
          width,
          depth,
        ),
      );
    } else {
      if (this.mode === "picker" && this.picker) {
        lines.push(MARGIN + styleText(this.picker.title, { bold: true }, depth));
        lines.push(...this.commandList.render(width, depth));
      } else {
        lines.push(...this.editor.render(width, depth));
        if (this.mode === "select" || this.mode === "mention") {
          lines.push(...this.commandList.render(width, depth));
        }
      }
    }

    const hint = this.running
      ? `${this.spinner.render(depth)} esc to interrupt`
      : `think ${this.thinkingLevel} ${GLYPHS.separator} ctrl+t`;
    lines.push(...footer({ ...this.footerData, hint }, width, depth));
    return lines;
  }

  handleInput(event: InputEvent): void {
    if (event.type === "paste") {
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

    if (this.mode === "select" || this.mode === "mention") {
      if (this.mode === "mention") this.handleMentionKey(key);
      else this.handleSelectKey(key);
      return;
    }

    switch (key.name) {
      case "escape":
        if (this.running) this.options.callbacks.onAbort();
        return;
      case "return": {
        const text = this.editor.submit();
        if (text.trim().length === 0) return;
        if (text.startsWith("/") && this.options.callbacks.onCommand) {
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
            this.commandList.setItems(this.commands);
            this.mode = "select";
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
    if (key.name === "escape") {
      this.picker = undefined;
      this.mode = "composing";
      return;
    }
    if (key.name === "return") {
      const selected = this.commandList.selected;
      this.picker = undefined;
      this.mode = "composing";
      if (selected) picker.onChoose(selected.label);
    }
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
