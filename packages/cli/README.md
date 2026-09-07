# @mu-agent/mu

The CLI and TypeScript SDK distribution of [Mu](https://github.com/Spandan7724/mu), an
extensible AI agent with a built-in coding profile.

The package provides:

- the `mu` interactive terminal application;
- headless and NDJSON RPC modes;
- the public `Agent` and `createAgent` TypeScript APIs;
- the coding profile, TUI, extensions, MCP support, and a platform-specific ripgrep
  sidecar.

This package requires Bun 1.3 or later at runtime.

## Install the CLI

```sh
npm install -g @mu-agent/mu
# or
bun install -g @mu-agent/mu

mu
```

Run `/login` to configure a provider account or API key, then `/model` to select a model.
Environment variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY`
also work.

```sh
mu                                  # interactive TUI
mu -p "fix the failing test"        # one-shot result
mu -p "review this patch" --json    # JSON event stream
mu --resume <session-id>            # resume a session
mu --rpc                            # NDJSON operations in, events out
mu agents                           # manage several sessions
```

Run `mu --help` for all flags. Global npm and Bun installs can update or remove themselves:

```sh
mu self update
mu self uninstall
```

Native, runtime-free installers and release archives are documented in the
[project README](https://github.com/Spandan7724/mu#install).

## Coding agent

The CLI loads the coding profile by default. It includes:

- `read`, `ls`, `edit`, and `write` file tools;
- foreground and PTY-backed background shell commands;
- repository search with `rg` and `rg --files`;
- read-before-write checks and diff previews for approvals;
- shadow-git workspace checkpoints with `/undo`, `/redo`, `/fork`, and `/diff`;
- durable sessions, automatic context compaction, and Markdown transcript export;
- managed `task` delegation and coding-specific `search` and `counsel` subagents.

The default permission mode allows inspection and asks before file changes or commands.
Use `/permissions` or `--permission-mode` to choose `default`, `accept-edits`,
`plan-readonly`, or `yolo`. These are permission rules, not an OS sandbox.

CLI sessions are scoped to the current project and stored under `~/.mu/sessions`.
Checkpoints are stored under `~/.mu/checkpoints` and do not add commits or refs to the
user's repository.

### Interactive commands

| Command | Purpose |
|---|---|
| `/login`, `/logout` | Add or remove credentials stored by Mu |
| `/model` | Select the active model |
| `/permissions` | Change the current permission mode |
| `/resume`, `/new`, `/rename` | Open, create, or name conversations |
| `/compact [focus]` | Compact the active model context |
| `/undo`, `/redo`, `/fork`, `/diff` | Navigate the session and workspace history |
| `/export [path.md]` | Export the complete active branch |
| `/btw [question]` | Open an ephemeral read-only side conversation |
| `/instructions [reload]`, `/reload` | Inspect or reload repository instructions |
| `/cost` | Show session token and cost totals |
| `/keybindings` | Show Mu-specific keyboard controls |

During a run, Enter steers the current turn and Tab queues a follow-up. `Ctrl+O` opens
transcript review, `Shift+Tab` cycles permission modes, and a leading `!` runs a command
directly without a model call. Direct shell commands are still recorded as session context.

## Providers

Account sign-in is available for OpenAI Codex/ChatGPT, GitHub Copilot, Kimi Code,
OpenRouter, and xAI. API-key routes include Anthropic, OpenAI, Google, Z.AI Coding Plan,
Qwen Token Plan, and providers supported by Mu's shared OpenAI-compatible and
Gemini-compatible transports. Anthropic subscription OAuth is not supported.

OpenAI API-key models use the `openai/*` namespace. ChatGPT-plan models use
`openai-codex/*`; the credentials are separate and may coexist. Both routes receive
provider-hosted web search automatically. Other providers currently run without web
search.

A local `llama-server` is discovered at `http://127.0.0.1:8000` and exposed as
`llama-cpp/<alias>`. Set `LLAMA_CPP_BASE_URL` or `LLAMA_CPP_API_KEY` when needed.

## Project instructions and extensions

The coding profile loads instructions from `~/.mu/AGENTS.md` and the active project,
stopping at its configured root marker (`.git` by default). It supports
`AGENTS.override.md`, `AGENTS.md`, configured fallback names such as `CLAUDE.md`,
`.mu/rules/`, `.claude/rules/`, conditional `paths` frontmatter, and scoped `@file`
imports.

Instruction settings can be placed in `~/.mu/config.json` or `.mu/config.json`. Project
values override user values.

```json
{
  "instructions": {
    "enabled": true,
    "fallbackFilenames": [".mu/AGENTS.md", "CLAUDE.md"],
    "projectRootMarkers": [".git"],
    "imports": true,
    "claudeRules": true
  }
}
```

The CLI also discovers:

- TypeScript extensions in `~/.mu/extensions` and `.mu/extensions`;
- Markdown slash commands in `~/.mu/commands` and `.mu/commands`;
- skills in `~/.mu/skills` and `.mu/skills`;
- MCP servers from user and project `.mu/config.json`.

```json
{
  "mcpServers": {
    "docs": {
      "command": "bunx",
      "args": ["-y", "your-mcp-server"],
      "env": { "SERVER_TOKEN": "..." }
    }
  }
}
```

MCP tools are named `mcp_<server>_<tool>` and use the same permission, event, and abort
paths as local tools.

## TypeScript SDK

Install the package in a Bun project:

```sh
bun add @mu-agent/mu
```

### Low-level agent

`new Agent()` is domain-neutral. It uses an in-memory session store and has no tools or
extensions unless they are supplied by the caller.

```ts
import { Agent } from "@mu-agent/mu";

const agent = new Agent({
  model: "anthropic/claude-sonnet-5",
  budget: { maxTurns: 8, maxCostUsd: 1 },
});

const result = await agent.run("Summarize the design trade-offs");
console.log(result.text);
console.log(result.reason, result.usage);
```

### Coding agent

`createAgent()` adds managed `task` delegation. With `profile: "coding"`, it also loads
the shipped coding tools, project instructions, permissions, checkpoints, background
runtime, and `search`/`counsel` specialists.

```ts
import { createAgent } from "@mu-agent/mu";

const agent = await createAgent({
  profile: "coding",
  profileOptions: { root: process.cwd() },
  budget: { maxCostUsd: 2 },
});

const result = await agent.run("Find and fix the failing test");
console.log(result.text);
await agent.shutdown();
```

### Custom tools

Tools use Zod schemas. Arguments are validated before `execute`, and the schema is
converted to JSON Schema for providers.

```ts
import { Agent, tool } from "@mu-agent/mu";
import { z } from "zod";

const add = tool({
  name: "add",
  description: "Add two numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }) => String(a + b),
});

const agent = new Agent({ tools: [add] });
const result = await agent.run("What is 17 + 25?");
console.log(result.text);
```

`Agent` also supports:

- `stream()` for the same serializable event stream used by the TUI and RPC;
- Zod-validated structured output through `run(prompt, { output: schema })`;
- permission callbacks and layered permission rules;
- model, turn, token, and cost budgets;
- custom providers and models;
- `MemorySessionStore`, `FileSessionStore`, and caller-defined session stores;
- extensions, shell hooks, skills, MCP, child agents, and transcript serialization.

See the [project README](https://github.com/Spandan7724/mu#typescript-sdk) and
[source](https://github.com/Spandan7724/mu) for the complete project overview.

## License

MIT
