# mu

A general-purpose, extensible AI agent platform. Out of the box mu is a polished coding
agent; swap its **profile** (tools + prompts + permissions + UI renderers) and the same
kernel becomes a computer-use agent, an automation agent, or any other tool-using agent.

Three surfaces, one kernel, one event stream:

- **TUI** — interactive terminal app (`mu`)
- **RPC / headless** — `mu --rpc` (NDJSON events/ops), `mu -p "..."` one-shot
- **SDK** — `import { Agent } from "mu"` for building automations in TypeScript

Design docs live in `docs/` — start with `docs/PROJECT.md`.

## Install

```sh
# From npm (requires Bun)
bun install -g mu

# Or grab a compiled binary — no runtime needed
curl -fsSL -o mu https://github.com/…/releases/latest/download/mu-linux-x64
chmod +x mu && ./mu --help
```

Set a provider key and go:

```sh
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY / GEMINI_API_KEY
mu                             # interactive
mu -p "fix the failing test"   # one-shot
mu --rpc                       # NDJSON events out, ops in
```

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run ci        # typecheck + lint + tests + kernel-purity check
bun run build     # single-file binary at dist/mu
```

Building for other platforms:

```sh
bun run build:linux    # dist/mu-linux-x64
bun run build:macos    # dist/mu-darwin-arm64
```
