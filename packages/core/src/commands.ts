import type { AgentMessage } from "./messages.ts";

export interface CommandContext {
  // Text after the command name, verbatim.
  args: string;
  // Queue a message into the run (how most commands act on the agent).
  inject: (message: AgentMessage) => void;
  // Print user-visible output that is not part of the model transcript.
  print: (text: string) => void;
  // Read/replace the current session's model reference.
  getModel: () => string;
  setModel: (ref: string) => void;
}

export interface CommandResult {
  // A command may end the run (e.g. /clear) or hand control back.
  handled: boolean;
  message?: string;
}

export interface Command {
  name: string; // without the leading slash
  description: string;
  // biome-ignore lint/suspicious/noConfusingVoidType: a command may legitimately return nothing
  run: (ctx: CommandContext) => CommandResult | void | Promise<CommandResult | void>;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(command: Command): void {
    this.commands.set(command.name, command);
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  list(): Command[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  // Parses "/name rest of line". Returns undefined when the input is not a command.
  parse(input: string): { name: string; args: string } | undefined {
    if (!input.startsWith("/")) return undefined;
    const trimmed = input.slice(1);
    const space = trimmed.search(/\s/);
    return space === -1
      ? { name: trimmed, args: "" }
      : { name: trimmed.slice(0, space), args: trimmed.slice(space + 1).trim() };
  }

  async execute(input: string, ctx: Omit<CommandContext, "args">): Promise<CommandResult> {
    const parsed = this.parse(input);
    if (!parsed) return { handled: false };
    const command = this.commands.get(parsed.name);
    if (!command) {
      return { handled: true, message: `Unknown command: /${parsed.name}` };
    }
    const result = await command.run({ ...ctx, args: parsed.args });
    return result ?? { handled: true };
  }
}
