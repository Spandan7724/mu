# @mu/cli

The terminal distribution of mu, a general-purpose extensible AI agent.

```sh
bun install -g @mu/cli
mu
```

The matching OS/CPU package supplies a pinned ripgrep binary for fast search; installs
without it fall back to `rg` on `PATH` or mu's built-in search.

Run `/login` to sign in with an account or API key. See the project repository for
configuration, SDK, and development documentation.

Interactive runs are saved by working-directory scope under `~/.mu/sessions`; use
`/resume` to continue one. Use `/permissions` to choose `default`, `accept-edits`,
`plan-readonly`, or full-access behavior.
