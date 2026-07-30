# mu

A general-purpose, extensible AI agent platform. Out of the box mu is a polished coding
agent; swap its **profile** (tools + prompts + permissions + UI renderers) and the same
kernel becomes a computer-use agent, an automation agent, or any other tool-using agent.

Three surfaces, one kernel, one event stream:

- **TUI** — interactive terminal app (`mu`)
- **RPC / headless** — `mu --rpc` (NDJSON events/ops), `mu -p "..."` one-shot
- **SDK** — `import { Agent } from "@mu-agent/mu"` for building automations in TypeScript

## Install

```sh
# With npm (requires Bun)
npm install -g @mu-agent/mu

# Or with Bun
bun install -g @mu-agent/mu

# Update an existing global npm or Bun installation
mu self update

# Or download the packaged native release — no runtime needed.
# Linux:
tar -xzf mu-linux-x64.tar.gz
./mu-linux-x64/bin/mu --help

# macOS (Apple Silicon):
tar -xzf mu-darwin-arm64.tar.gz
./mu-darwin-arm64/bin/mu --help

# Windows PowerShell
Expand-Archive .\mu-windows-x64.zip
.\mu-windows-x64\bin\mu.exe --help
```

Native packages and npm installs include a pinned, checksum-verified ripgrep sidecar for
fast search. npm uses an OS/CPU-specific optional package, with no postinstall download.
The bare single-file binaries remain available and use `rg` from `PATH` or mu's built-in
fallback.

Install the same package locally to use the TypeScript SDK:

```sh
npm install @mu-agent/mu
# or: bun add @mu-agent/mu
```

```ts
import { Agent } from "@mu-agent/mu";

const result = await new Agent().run("Summarize this directory");
console.log(result.text);
```

Start mu and run `/login` to choose account sign-in or a stored API key. Account sign-in
supports OpenAI Codex/ChatGPT, GitHub Copilot, Kimi Code, OpenRouter, and xAI. Anthropic
is API-key-only. Z.AI Coding Plan and Qwen Token Plan are also available through their
API-key endpoints. Environment variables remain available for unattended use:

```sh
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY / GEMINI_API_KEY / provider-specific key
mu                             # interactive; /login configures authentication
mu --resume <session-id>       # continue a saved interactive session
mu -p "fix the failing test"   # one-shot
mu --rpc                       # NDJSON events out, ops in
```

## MCP servers

Add stdio servers to `~/.mu/config.json` or a project's `.mu/config.json`:

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

mu discovers tools and resources at startup. Remote tools are named
`mcp_<server>_<tool>` and use the normal permission rules, so an `mcp_*` rule can ask,
allow, or deny them. Project server entries override user entries with the same name.

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run ci        # typecheck + lint + tests + kernel-purity check
bun run build     # single-file binary at dist/mu
bun run pack:npm  # publishable @mu-agent/mu tarball in dist/
```

Building for other platforms:

```sh
bun run build:linux    # dist/mu-linux-x64
bun run build:macos    # dist/mu-darwin-arm64
bun run build:windows  # dist/mu-windows-x64.exe

# After building the matching native binary:
bun run package:linux    # dist/mu-linux-x64.tar.gz
bun run package:macos    # dist/mu-darwin-arm64.tar.gz
bun run package:windows  # dist/mu-windows-x64.zip
```
