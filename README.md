# mu

A general-purpose, extensible AI agent platform. Out of the box mu is a polished coding
agent; swap its **profile** (tools + prompts + permissions + UI renderers) and the same
kernel becomes a computer-use agent, an automation agent, or any other tool-using agent.

Three surfaces, one kernel, one event stream:

- **TUI** — interactive terminal app (`mu`)
- **RPC / headless** — `mu --rpc` (NDJSON events/ops), `mu -p "..."` one-shot
- **SDK** — `import { Agent } from "mu"` for building automations in TypeScript

Design docs live in `docs/` — start with `docs/PROJECT.md`.

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run ci        # typecheck + lint + tests + kernel-purity check
```
