# @mu/cli

The terminal distribution of mu, a general-purpose extensible AI agent.

```sh
bun install -g @mu/cli
mu
```

The matching OS/CPU package supplies a pinned ripgrep binary for fast search; installs
without it fall back to `rg` on `PATH` or mu's built-in search.

Run `/login` to sign in with an account or API key and `/logout` to remove a credential
saved that way. Environment variables are not changed by `/logout`. `/model` only lists
providers authenticated through `/login`; `openai-codex/*` rows use the ChatGPT plan and
`openai/*` rows use a saved API key. Both OpenAI routes default to GPT-5.6 Sol. See the
project repository for configuration, SDK, and development documentation.

Interactive runs are saved by working-directory scope under `~/.mu/sessions`; use
`/resume` to choose one or `mu --resume <session-id>` to continue it directly. Mu prints
the direct resume command when an interactive session closes. Use `/new` to clear the
terminal and start a fresh chat without deleting the previous saved session. Use
`/permissions` to choose `default`, `accept-edits`, `plan-readonly`, or full-access
behavior, including while the agent is running.
