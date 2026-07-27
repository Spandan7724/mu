# mu

A general-purpose, extensible AI agent platform. Out of the box mu is a polished coding
agent; swap its **profile** (tools + prompts + permissions + UI renderers) and the same
kernel becomes a computer-use agent, an automation agent, or any other tool-using agent.

Three surfaces, one kernel, one event stream:

- **TUI** — interactive terminal app (`mu`)
- **RPC / headless** — `mu --rpc` (NDJSON events/ops), `mu -p "..."` one-shot
- **SDK** — `import { Agent } from "mu"` for building automations in TypeScript

## Install

```sh
# From npm (requires Bun)
bun install -g @mu/cli

# Or download the native artifact for your platform from the GitHub release
# mu-linux-x64 or mu-darwin-arm64 — no runtime needed
chmod +x mu-linux-x64
./mu-linux-x64 --help
```

Start mu and run `/login` to choose account sign-in or a stored API key. OpenAI
account sign-in uses your ChatGPT plan. Environment variables remain available for
unattended use:

```sh
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY / GEMINI_API_KEY
mu                             # interactive; /login configures authentication
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
bun run pack:npm  # publishable @mu/cli tarball in dist/
```

Building for other platforms:

```sh
bun run build:linux    # dist/mu-linux-x64
bun run build:macos    # dist/mu-darwin-arm64
```
