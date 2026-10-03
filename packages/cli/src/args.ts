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
    | "self-uninstall"
    | "browser-login"
    | "browser-status"
    | "browser-close";
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
  purgeData: boolean;
  browserProfile?: string | undefined;
  cdpUrl?: string | undefined;
  headless?: boolean | undefined;
  loginUrl?: string | undefined;
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
      case "browser":
        if (i !== 0) {
          parsed.errors.push('"browser" must come first: mu browser [login] [options]');
          break;
        }
        parsed.profile = "browser";
        if (argv[i + 1] === "status" || argv[i + 1] === "close") {
          parsed.mode = argv[++i] === "status" ? "browser-status" : "browser-close";
        } else if (argv[i + 1] === "login") {
          i++;
          parsed.mode = "browser-login";
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith("-")) {
            parsed.loginUrl = next;
            i++;
          }
        }
        break;
      case "--browser-profile":
        parsed.browserProfile = argv[++i];
        if (!parsed.browserProfile) parsed.errors.push("--browser-profile requires a name");
        break;
      case "--cdp":
        parsed.cdpUrl = argv[++i];
        if (!parsed.cdpUrl) parsed.errors.push("--cdp requires an endpoint URL");
        break;
      case "--headless":
        parsed.headless = true;
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
      default:
        if (arg.startsWith("-")) parsed.errors.push(`Unknown flag: ${arg}`);
        else if (parsed.prompt === undefined && parsed.mode === "headless") parsed.prompt = arg;
        else parsed.errors.push(`Unexpected argument: ${arg}`);
    }
  }

  return parsed;
}

export const HELP_TEXT = `mu — a general-purpose, extensible AI agent for the terminal

mu ships two agents in one install. The coding agent is the default. The browser agent
starts with \`mu browser\` and drives a Chrome-family browser already installed on this
machine; it stays inert until you use it.

Usage:
  mu [options]                        coding agent, interactive terminal app
  mu -p "<prompt>" [options]          coding agent, run one prompt and print the result
  mu --rpc [options]                  coding agent over NDJSON (ops on stdin, events on stdout)
  mu browser [options]                browser agent, interactive terminal app
  mu browser -p "<prompt>" [options]  browser agent, run one prompt and print the result
  mu browser --rpc [options]          browser agent over NDJSON
  mu browser login [url] [options]    open the managed browser to sign in to sites yourself
  mu browser status [options]         show the browser binary, profile dir and whether it runs
  mu browser close [options]          close the managed browser left open by earlier runs
  mu agents [options]                 run and watch several sessions side by side
  mu agents stop                      stop the background supervisor behind \`mu agents\`
  mu self update                      update a global npm, Bun or GitHub-release install
  mu self uninstall [--purge]         remove that install (--purge also deletes ~/.mu)

Coding agent (default, or --profile coding)
  Works in the current directory: reads, searches, edits and creates files, runs shell
  commands and background processes, and delegates to subagents (task, search, counsel,
  recall). Each prompt gets a checkpoint outside your Git repo that /undo can restore.

  Permission modes (--permission-mode, /permissions or shift+tab in the app):
    default          read freely; ask before edits and commands
    accept-edits     read and edit files freely; ask before commands
    plan-readonly    inspect and plan only; deny file, command and task changes
    yolo             allow every tool call without asking (same as --allow-all)

  Coding options:
        --no-instructions    skip AGENTS.md and other global/project instruction files

  Coding slash commands:
    /undo [n]        revert the last n prompts, files and conversation together
    /redo            re-apply the step that was undone
    /diff            show everything this session changed in the workspace
    /instructions [reload]
                     show the loaded instruction files, or reload them
    /reload          reload instruction files
    /subagents       list subagents and how to ask for each one

Browser agent (mu browser, or --profile browser)
  Navigates, reads, clicks, types, fills forms, uploads and downloads in real tabs, keeps
  notes and a record of consequential actions (sends, purchases, deletions), and can run
  parallel sub-tasks in separate tabs. It uses mu's own persistent Chrome profile under
  ~/.mu/browser/profiles/<name>, or any browser you point --cdp at. When a site needs
  you (sign-in, captcha, 2FA) it hands you the window and continues once the page moves
  on or you reply. Page content is treated as untrusted data.

  Permission modes (--permission-mode, /permissions or shift+tab in the app):
    default          browse and interact freely; ask before sending, buying, deleting,
                     entering secrets, uploading and running page scripts
    supervised       ask before every navigation and interaction
    read-only        look and navigate only; deny clicks, typing and consequential actions
    autonomous       allow everything, including sending, buying and deleting, without
                     asking (same as --allow-all)

  Browser options:
        --browser-profile <name>
                             managed browser profile to use (default: default)
        --cdp <url>          drive an existing browser's DevTools endpoint instead of
                             launching one (not for login or close)
        --headless           run the managed browser without a window (not for login)

  Browser slash commands:
    /browser         browser status, active tab and consequential actions taken
    /tabs            list the browser's open tabs
    /login [url]     open a site in the browser window so you can sign in yourself

Options for both agents:
  -p, --print <prompt>       headless one-shot mode; prints the final answer
      --json                 with -p, stream every event as JSON lines instead
      --rpc                  NDJSON mode for other programs (see RPC below)
      --model <ref>          model to use, e.g. anthropic/claude-opus-5 or openai/gpt-5.1
                             (default: "model" in ~/.mu/config.json)
      --profile <name>       profile to load: coding, browser, or a module path/package
      --resume <session>     resume an earlier session (interactive, -p or --rpc)
      --permission-mode <mode>
                             start in this mode (see each agent above)
      --allow-all            start in the profile's unrestricted mode (yolo / autonomous)
      --max-turns <n>        stop after n model turns (-p and --rpc)
      --max-cost <usd>       stop once the run has cost this much (-p and --rpc)
  -h, --help                 show this help
  -v, --version              show the version

  In -p mode nothing can ask: any action that would ask is denied and reported. Use
  --permission-mode or --allow-all to permit it.

Slash commands in every session:
  /help            list the commands available in this session
  /model [ref]     show or switch the model
  /login           configure a provider account or API key
  /logout          remove provider authentication
  /permissions     choose the permission mode
  /compact [focus] summarize older context now, keeping recent work
  /fork            branch the conversation from an earlier point
  /resume          resume an earlier session
  /rename          name the current conversation
  /new             clear the screen and start a new chat
  /btw             open an ephemeral side conversation
  /export [path]   save the transcript as Markdown
  /cost            token usage and cost for this session
  /keybindings     list every key binding
  Markdown commands from ~/.mu/commands and .mu/commands are added as /<name>.

In the app:
  !<command>       run a shell command yourself    @<path>    mention a file
  ctrl+o           review tool output              ctrl+t     cycle thinking level
  shift+tab        cycle permission mode           esc        stop the current run
  ctrl+c           exit

RPC (--rpc):
  One JSON object per line. Ops in: input, steer, follow_up, command, shell,
  permission_reply, permission_mode, cycle_permission_mode, thinking, resume,
  remove_queued, snapshot, resize, abort, shutdown. Out: ready, event, snapshot,
  command_result, op_result, error, shutdown.

Files:
  ~/.mu/config.json        default model, and a "browser" section (browserProfile, connect,
                           cdpUrl, executable, channel, headless, vision, viewport, keepOpen,
                           downloadsDir, allowedHosts, blockedHosts, workspace)
  ~/.mu/auth.json          provider credentials (/login)
  ~/.mu/models.json        custom and local models
  ~/.mu/sessions/          saved conversations (per profile and project)
  ~/.mu/checkpoints/       coding checkpoints for /undo
  ~/.mu/AGENTS.md          global instructions; AGENTS.md in the project adds to it
  ~/.mu/commands/          Markdown slash commands (.mu/commands in a project too)
  ~/.mu/skills/            skills          ~/.mu/extensions/    extensions
  ~/.mu/browser/           browser profiles and downloads

Environment:
  NO_COLOR                 disable color
  MU_FORCE_COLOR           truecolor | ansi256 | ansi16 | none
  MU_HOME                  state directory for \`mu agents\` (default ~/.mu)

Exit codes (-p): 0 done · 1 error · 2 usage · 3 turn, cost or token budget hit · 130 aborted
`;
