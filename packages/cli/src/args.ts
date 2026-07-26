export interface ParsedArgs {
  mode: "tui" | "headless" | "rpc" | "help" | "version";
  prompt?: string | undefined;
  json: boolean;
  model?: string | undefined;
  profile?: string | undefined;
  maxTurns?: number | undefined;
  maxCostUsd?: number | undefined;
  allowAll: boolean;
  errors: string[];
}

function numberFlag(raw: string | undefined, name: string, errors: string[]): number | undefined {
  if (raw === undefined) {
    errors.push(`${name} requires a value`);
    return undefined;
  }
  const value = Number(raw);
  if (Number.isNaN(value)) {
    errors.push(`${name} expects a number, got "${raw}"`);
    return undefined;
  }
  return value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { mode: "tui", json: false, allowAll: false, errors: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
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
      case "--max-turns":
        parsed.maxTurns = numberFlag(argv[++i], "--max-turns", parsed.errors);
        break;
      case "--max-cost":
        parsed.maxCostUsd = numberFlag(argv[++i], "--max-cost", parsed.errors);
        break;
      case "--allow-all":
        parsed.allowAll = true;
        break;
      default:
        if (arg.startsWith("-")) parsed.errors.push(`Unknown flag: ${arg}`);
        else if (parsed.prompt === undefined && parsed.mode === "headless") parsed.prompt = arg;
        else parsed.errors.push(`Unexpected argument: ${arg}`);
    }
  }

  return parsed;
}

export const HELP_TEXT = `mu — a general-purpose, extensible AI agent

Usage:
  mu                       start the interactive terminal app
  mu -p "<prompt>"         run one prompt and print the result
  mu --rpc                 newline-delimited JSON: events out, ops in

Options:
  -p, --print <prompt>     headless one-shot mode
      --json               stream events as JSON (headless mode)
      --model <ref>        model to use, e.g. anthropic/claude-opus-5
      --profile <name>     profile to load (default: coding)
      --max-turns <n>      stop after n turns
      --max-cost <usd>     stop once the run costs this much
      --allow-all          allow every tool call without asking
  -h, --help               show this help
  -v, --version            show the version
`;
