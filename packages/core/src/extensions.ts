import type { Provider } from "@mu/ai";
import { type Command, CommandRegistry } from "./commands.ts";
import type { AgentEvent, AgentEventType } from "./events.ts";
import type { AgentMessage } from "./messages.ts";
import type { AnyTool, ToolResult } from "./tools.ts";

// Directives returned from the defined block/modify points.
export interface ToolCallDirective {
  block?: boolean;
  reason?: string;
  args?: Record<string, unknown>;
}

export interface ToolResultDirective {
  content?: ToolResult["content"];
  isError?: boolean;
}

export interface InputDirective {
  consume?: boolean;
  text?: string;
}

export interface ToolCallHookInfo {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

export interface ToolResultHookInfo {
  toolName: string;
  toolCallId: string;
  result: ToolResult;
  isError: boolean;
}

export type LifecycleEvent = "session_start" | "session_shutdown" | "input" | "model_select";

// Renderers are declared here so profiles/extensions can register them before
// the TUI exists; the TUI consumes this registry in M6.
export interface ToolRenderer {
  render: (info: { toolName: string; args: unknown; result?: ToolResult }) => string[];
}

export interface ExtensionAPI {
  on(event: AgentEventType | LifecycleEvent, handler: (event: AgentEvent) => void): void;
  onToolCall(
    handler: (
      info: ToolCallHookInfo,
    ) => ToolCallDirective | undefined | Promise<ToolCallDirective | undefined>,
  ): void;
  onToolResult(
    handler: (
      info: ToolResultHookInfo,
    ) => ToolResultDirective | undefined | Promise<ToolResultDirective | undefined>,
  ): void;
  onContext(handler: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>): void;
  onInput(
    handler: (text: string) => InputDirective | undefined | Promise<InputDirective | undefined>,
  ): void;
  registerTool(tool: AnyTool): void;
  registerCommand(command: Command): void;
  registerProvider(provider: Provider): void;
  registerRenderer(toolName: string, renderer: ToolRenderer): void;
  log(message: string): void;
}

export interface Extension {
  name: string;
  activate: (api: ExtensionAPI) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}

// In-process host. Loading extensions from disk is a surface concern (the
// kernel may not touch the filesystem) — the loader lives in the SDK and hands
// already-imported Extension objects to `register`.
export class ExtensionHost {
  readonly tools = new Map<string, AnyTool>();
  readonly commands = new CommandRegistry();
  readonly providers = new Map<string, Provider>();
  readonly renderers = new Map<string, ToolRenderer>();
  readonly logs: string[] = [];

  private extensions: Extension[] = [];
  private eventHandlers = new Map<string, ((event: AgentEvent) => void)[]>();
  private toolCallHooks: ((
    info: ToolCallHookInfo,
  ) => ToolCallDirective | undefined | Promise<ToolCallDirective | undefined>)[] = [];
  private toolResultHooks: ((
    info: ToolResultHookInfo,
  ) => ToolResultDirective | undefined | Promise<ToolResultDirective | undefined>)[] = [];
  private contextHooks: ((messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>)[] =
    [];
  private inputHooks: ((
    text: string,
  ) => InputDirective | undefined | Promise<InputDirective | undefined>)[] = [];

  async register(extension: Extension): Promise<void> {
    const api: ExtensionAPI = {
      on: (event, handler) => {
        const list = this.eventHandlers.get(event) ?? [];
        list.push(handler);
        this.eventHandlers.set(event, list);
      },
      onToolCall: (handler) => void this.toolCallHooks.push(handler),
      onToolResult: (handler) => void this.toolResultHooks.push(handler),
      onContext: (handler) => void this.contextHooks.push(handler),
      onInput: (handler) => void this.inputHooks.push(handler),
      registerTool: (tool) => void this.tools.set(tool.name, tool),
      registerCommand: (command) => this.commands.register(command),
      registerProvider: (provider) => void this.providers.set(provider.id, provider),
      registerRenderer: (name, renderer) => void this.renderers.set(name, renderer),
      log: (message) => void this.logs.push(`[${extension.name}] ${message}`),
    };
    await extension.activate(api);
    this.extensions.push(extension);
  }

  async shutdown(): Promise<void> {
    for (const extension of this.extensions) await extension.deactivate?.();
    this.extensions = [];
  }

  emit(event: AgentEvent): void {
    for (const handler of this.eventHandlers.get(event.type) ?? []) handler(event);
  }

  emitLifecycle(event: LifecycleEvent, payload: AgentEvent): void {
    for (const handler of this.eventHandlers.get(event) ?? []) handler(payload);
  }

  // First extension to block wins; arg rewrites chain through all of them.
  async runToolCallHooks(info: ToolCallHookInfo): Promise<ToolCallDirective | undefined> {
    let args = info.args;
    for (const hook of this.toolCallHooks) {
      const directive = await hook({ ...info, args });
      if (directive?.block) return directive;
      if (directive?.args) args = directive.args;
    }
    return args === info.args ? undefined : { args };
  }

  async runToolResultHooks(info: ToolResultHookInfo): Promise<ToolResultDirective | undefined> {
    let content = info.result.content;
    let isError = info.isError;
    let touched = false;
    for (const hook of this.toolResultHooks) {
      const directive = await hook({ ...info, result: { ...info.result, content }, isError });
      if (!directive) continue;
      if (directive.content) {
        content = directive.content;
        touched = true;
      }
      if (directive.isError !== undefined) {
        isError = directive.isError;
        touched = true;
      }
    }
    return touched ? { content, isError } : undefined;
  }

  async runContextHooks(messages: AgentMessage[]): Promise<AgentMessage[]> {
    let current = messages;
    for (const hook of this.contextHooks) current = await hook(current);
    return current;
  }

  // A consuming handler stops the chain: the input never reaches the agent.
  async runInputHooks(text: string): Promise<InputDirective | undefined> {
    let current = text;
    for (const hook of this.inputHooks) {
      const directive = await hook(current);
      if (directive?.consume)
        return { consume: true, ...(directive.text !== undefined ? { text: directive.text } : {}) };
      if (directive?.text !== undefined) current = directive.text;
    }
    return current === text ? undefined : { text: current };
  }

  get hasContextHooks(): boolean {
    return this.contextHooks.length > 0;
  }
}
