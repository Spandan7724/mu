import type { WebSearchMode } from "mu";

export interface ParsedArgs {
  mode:
    | "tui"
    | "headless"
    | "rpc"
    | "agents"
    | "agents-stop"
    | "agents-supervisor"
    | "agents-worker"
    | "help"
    | "version"
    | "self-update"
    | "self-uninstall";
  prompt?: string | undefined;
  json: boolean;
  model?: string | undefined;
  profile?: string | undefined;
  resumeSessionId?: string | undefined;
  maxTurns?: number | undefined;
  maxCostUsd?: number | undefined;
  permissionMode?: string | undefined;
  webSearch?: WebSearchMode | undefined;
  allowAll: boolean;
  noInstructions: boolean;
  purgeData: boolean;
  workerSessionId?: string | undefined;
  workerOwnershipToken?: string | undefined;
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

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    mode: "tui",
    json: false,
    allowAll: false,
    noInstructions: false,
    purgeData: false,
    errors: [],
  };

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
      case "agents":
        if (argv[i + 1] === "stop") {
          i++;
          parsed.mode = "agents-stop";
        } else {
          parsed.mode = "agents";
        }
        break;
      case "__agents-supervisor":
        parsed.mode = "agents-supervisor";
        break;
      case "__agents-worker":
        parsed.mode = "agents-worker";
        break;
      case "--session-id":
        parsed.workerSessionId = argv[++i];
        if (!parsed.workerSessionId) parsed.errors.push("--session-id requires a value");
        break;
      case "--ownership-token":
        parsed.workerOwnershipToken = argv[++i];
        if (!parsed.workerOwnershipToken) parsed.errors.push("--ownership-token requires a value");
        break;
      case "self": {
        const sub = argv[++i];
        if (sub === "update") parsed.mode = "self-update";
        else if (sub === "uninstall") parsed.mode = "self-uninstall";
        else parsed.errors.push('self expects "update" or "uninstall"');
        break;
      }
      case "--purge":
        parsed.purgeData = true;
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
      case "--web-search": {
        const mode = argv[++i];
        if (mode === "disabled" || mode === "cached" || mode === "indexed" || mode === "live") {
          parsed.webSearch = mode;
        } else {
          parsed.errors.push(
            mode
              ? `--web-search expects disabled, cached, indexed, or live; got "${mode}"`
              : "--web-search requires a value",
          );
        }
        break;
      }
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
  mu --resume <session>    resume an interactive session
  mu -p "<prompt>"         run one prompt and print the result
  mu --rpc                 newline-delimited JSON: events out, ops in
  mu agents                manage several ordinary sessions
  mu agents stop           stop the managed-session supervisor
  mu self update           update a global npm, Bun, or GitHub-release install
  mu self uninstall        remove a global npm, Bun, or GitHub-release install

Options:
  -p, --print <prompt>     headless one-shot mode
      --json               stream events as JSON (headless mode)
      --model <ref>        model to use, e.g. anthropic/claude-opus-5
      --profile <name>     profile to load (default: coding)
      --resume <session>   resume an earlier session (interactive, headless, or RPC)
      --max-turns <n>      stop after n turns
      --max-cost <usd>     stop once the run costs this much
      --permission-mode <mode>
                           default | accept-edits | plan-readonly | yolo
      --web-search <mode>  disabled | cached | indexed | live (OpenAI/Codex)
      --allow-all          alias for --permission-mode yolo
      --no-instructions    disable global and project instruction loading
      --purge              with self uninstall, also delete ~/.mu (config, credentials, sessions)
  -h, --help               show this help
  -v, --version            show the version
`;
