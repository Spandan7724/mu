// The mu integration layer: an AgentEvent consumer that commits transcript
// cells to scrollback and keeps the bottom region (composer / approval / footer)
// up to date. It holds no agent logic — everything arrives as events.
import type { AgentEvent, PermissionRequest } from "@mu/core";
import {
  agentCell,
  compactionCell,
  errorCell,
  type RenderContext,
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
import { type ColorDepth, MARGIN, styleText } from "./style.ts";

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
}

export interface AppOptions {
  width: number;
  depth: ColorDepth;
  model: string;
  callbacks: AppCallbacks;
  registry?: RendererRegistry;
}

export class App {
  readonly editor = new Editor();
  readonly registry: RendererRegistry;
  private spinner = new Spinner();
  private commandList = new SelectList([]);
  private mode: AppMode = "composing";
  private running = false;
  private approval: PermissionRequest | undefined;
  private approvalIndex = 0;
  private pendingTools = new Map<string, ToolRenderInfo>();
  private footerData: FooterData;
  private commands: { label: string; description?: string }[] = [];
  private picker: PickerRequest | undefined;
  private mentionStart = -1;

  constructor(private options: AppOptions) {
    this.registry = options.registry ?? new RendererRegistry();
    this.footerData = { model: options.model, contextPercent: 0, costUsd: 0 };
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

      case "agent_end":
        this.running = false;
        return event.reason === "error" ? errorCell("run ended with an error", this.ctx) : [];

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
        this.approval = event.request;
        this.approvalIndex = 0;
        this.mode = "approval";
        return [];

      case "permission_resolved":
        this.approval = undefined;
        this.mode = "composing";
        return [];

      case "compaction_end":
        return [...compactionCell(event.tokensFreed, this.ctx), ""];

      case "usage_updated":
        this.footerData = {
          ...this.footerData,
          contextPercent: event.contextPercent,
          costUsd: event.sessionTotals.costUsd ?? 0,
        };
        return [];

      case "task_started":
        this.footerData = {
          ...this.footerData,
          backgroundTasks: (this.footerData.backgroundTasks ?? 0) + 1,
        };
        return [];

      case "task_exited":
        this.footerData = {
          ...this.footerData,
          backgroundTasks: Math.max(0, (this.footerData.backgroundTasks ?? 0) - 1),
        };
        return [];

      default:
        return [];
    }
  }

  tickSpinner(): void {
    this.spinner.tick();
  }

  // The managed bottom region, rebuilt from state on every paint.
  renderBottom(): string[] {
    const { width, depth } = this.ctx;
    const lines: string[] = [composerRule(width, depth)];

    if (this.mode === "approval" && this.approval) {
      lines.push(
        ...approvalOverlay(
          {
            title: this.approval.description,
            preview: [this.approval.pattern],
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

    const hint = this.running ? `${this.spinner.render(depth)} esc to interrupt` : undefined;
    lines.push(footer({ ...this.footerData, ...(hint ? { hint } : {}) }, width, depth));
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
            this.mentionStart = this.editor.text.length - 1;
            this.commandList.setItems(this.options.callbacks.onMentionQuery(""));
            this.mode = "mention";
          }
        }
    }
  }

  private handleApprovalKey(key: Key): void {
    const request = this.approval;
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
        // Replace the partial "@query" with the chosen path.
        const text = this.editor.text;
        this.editor.setText(text.slice(0, this.mentionStart) + selected.label + " ");
      }
      this.mode = "composing";
      this.mentionStart = -1;
      return;
    }
    if (key.name === "backspace") {
      this.editor.backspace();
      if (this.editor.text.length <= this.mentionStart) {
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

  private refreshMentions(): void {
    const query = this.editor.text.slice(this.mentionStart + 1);
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
      if (!this.editor.text.startsWith("/")) this.mode = "composing";
      return;
    }
    if (key.text) {
      this.editor.insert(key.text);
      const query = this.editor.text.slice(1).toLowerCase();
      this.commandList.setItems(
        this.commands.filter((c) => c.label.toLowerCase().startsWith(query)),
      );
    }
  }
}
