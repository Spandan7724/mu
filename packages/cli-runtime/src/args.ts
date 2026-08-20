import type { ProductArgResult, ProductDescriptor } from "./product.ts";

export interface ParsedArgs<Options = unknown> {
  // The three runtime surfaces plus the two zero-cost informational modes.
  // Anything else a product offers arrives as `product` with `productCommand`.
  mode: "tui" | "headless" | "rpc" | "help" | "version" | "product";
  productCommand?: string | undefined;
  product: Options;
  prompt?: string | undefined;
  json: boolean;
  model?: string | undefined;
  profile?: string | undefined;
  resumeSessionId?: string | undefined;
  maxTurns?: number | undefined;
  maxCostUsd?: number | undefined;
  permissionMode?: string | undefined;
  allowAll: boolean;
  noInstructions: boolean;
  errors: string[];
}

function numberFlag(raw: string | undefined, name: string, errors: string[]): number | undefined {
  if (raw === undefined) {
    errors.push(`${name} requires a value`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    errors.push(`${name} expects a number (finite), got "${raw}"`);
    return undefined;
  }
  if (value < 0 || (name === "--max-turns" && (!Number.isSafeInteger(value) || value === 0))) {
    errors.push(
      name === "--max-turns"
        ? `${name} expects a positive integer, got "${raw}"`
        : `${name} expects a non-negative number, got "${raw}"`,
    );
    return undefined;
  }
  return value;
}

export function parseArgs<Options>(
  argv: string[],
  product?: ProductDescriptor<Options>,
): ParsedArgs<Options> {
  const claimed: string[][] = [];
  const productTokens = product?.argTokens ?? {};
  const parsed: ParsedArgs<Options> = {
    mode: "tui",
    product: undefined as Options,
    json: false,
    allowAll: false,
    noInstructions: false,
    errors: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (Object.hasOwn(productTokens, arg)) {
      const arity = productTokens[arg] as number;
      claimed.push(argv.slice(i, i + arity + 1));
      i += arity;
      continue;
    }
    switch (arg) {
      case "-h":
      case "--help":
        parsed.mode = "help";
        break;
      case "-v":
      case "--version":
        parsed.mode = "version";
        break;
      case "-p":
      case "--print":
        parsed.mode = "headless";
        parsed.prompt = argv[++i];
        if (parsed.prompt === undefined) parsed.errors.push("-p requires a prompt");
        break;
      case "--rpc":
        parsed.mode = "rpc";
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--model":
        parsed.model = argv[++i];
        if (!parsed.model) parsed.errors.push("--model requires a value");
        break;
      case "--profile":
        parsed.profile = argv[++i];
        if (!parsed.profile) parsed.errors.push("--profile requires a value");
        break;
      case "--resume":
        parsed.resumeSessionId = argv[++i];
        if (!parsed.resumeSessionId) parsed.errors.push("--resume requires a session id");
        break;
      case "--max-turns":
        parsed.maxTurns = numberFlag(argv[++i], "--max-turns", parsed.errors);
        break;
      case "--max-cost":
        parsed.maxCostUsd = numberFlag(argv[++i], "--max-cost", parsed.errors);
        break;
      case "--allow-all":
        parsed.allowAll = true;
        break;
      case "--no-instructions":
        parsed.noInstructions = true;
        break;
      case "--permission-mode":
        parsed.permissionMode = argv[++i];
        if (!parsed.permissionMode) parsed.errors.push("--permission-mode requires a value");
        break;
      default:
        if (arg.startsWith("-")) parsed.errors.push(`Unknown flag: ${arg}`);
        else if (parsed.prompt === undefined && parsed.mode === "headless") parsed.prompt = arg;
        else parsed.errors.push(`Unexpected argument: ${arg}`);
    }
  }

  const productArgs: ProductArgResult<Options> | undefined = product?.parseProductArgs(claimed);
  if (productArgs) {
    parsed.product = productArgs.options;
    parsed.errors.push(...productArgs.errors);
    if (productArgs.command) {
      parsed.productCommand = productArgs.command;
      // A product command outranks a surface: `mu agents --resume x` manages
      // sessions, it does not start one.
      if (parsed.mode === "tui") parsed.mode = "product";
    }
  }

  return parsed;
}

// Usage and option descriptions line up in one column, so a product with a
// longer command name still produces a readable block.
export const HELP_DESCRIPTION_COLUMN = 27;

export function usageLine(invocation: string, description: string): string {
  const prefix = `  ${invocation}`;
  return `${prefix}${" ".repeat(Math.max(1, HELP_DESCRIPTION_COLUMN - prefix.length))}${description}`;
}

export function helpText(
  product: Pick<ProductDescriptor, "commandName" | "tagline" | "help" | "defaultProfile">,
): string {
  const command = product.commandName;
  const usage = [
    usageLine(command, "start the interactive terminal app"),
    usageLine(`${command} --resume <session>`, "resume an interactive session"),
    usageLine(`${command} -p "<prompt>"`, "run one prompt and print the result"),
    usageLine(`${command} --rpc`, "newline-delimited JSON: events out, ops in"),
    ...(product.help?.usage ?? []),
  ];
  const options = [
    "  -p, --print <prompt>     headless one-shot mode",
    "      --json               stream events as JSON (headless mode)",
    "      --model <ref>        model to use, e.g. anthropic/claude-opus-5",
    `      --profile <name>     profile to load (default: ${product.defaultProfile})`,
    "      --resume <session>   resume an earlier session (interactive, headless, or RPC)",
    "      --max-turns <n>      stop after n turns",
    "      --max-cost <usd>     stop once the run costs this much",
    "      --permission-mode <mode>",
    "                           default | accept-edits | plan-readonly | yolo",
    "      --allow-all          alias for --permission-mode yolo",
    "      --no-instructions    disable global and project instruction loading",
    ...(product.help?.options ?? []),
    "  -h, --help               show this help",
    "  -v, --version            show the version",
  ];
  return `${command} — ${product.tagline}\n\nUsage:\n${usage.join("\n")}\n\nOptions:\n${options.join("\n")}\n`;
}
