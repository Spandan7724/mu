# @mu-agent/mu

The terminal and TypeScript SDK distribution of Mu, a general-purpose extensible AI
agent platform. Coding is the default profile, not a constraint of the underlying kernel.

```sh
# npm (requires Bun)
npm install -g @mu-agent/mu

# Bun
bun install -g @mu-agent/mu
mu
```

Update a global npm or Bun installation:

```sh
mu self update
```

Install the package locally to embed Mu:

```sh
npm install @mu-agent/mu
# or: bun add @mu-agent/mu
```

```ts
import { Agent, createAgent } from "@mu-agent/mu";

// A domain-neutral agent with a general prompt and no tools.
const assistant = new Agent();
console.log((await assistant.run("Explain how an AI agent loop works")).text);

// Mu's built-in coding profile: file, search, shell, task, and checkpoint tools.
const codingAgent = await createAgent({
  profile: "coding",
  profileOptions: { root: process.cwd() },
});
console.log((await codingAgent.run("Summarize this directory")).text);
await codingAgent.shutdown();
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

Mu loads coding instructions from `~/.mu/AGENTS.md` and from the active project, stopping
at its Git root. `AGENTS.override.md` takes precedence over `AGENTS.md`; Claude-compatible
fallback files, `.mu/rules/`, `.claude/rules/`, conditional `paths` frontmatter, and safe
`@file` imports are supported. Run `/instructions` to see the exact loaded files and
warnings, `/instructions reload` (or `/reload`) to rescan, or start with
`--no-instructions` to disable loading for one invocation.

Instruction settings can be placed in user or project `.mu/config.json`; project values
override user values:

```json
{
  "instructions": {
    "enabled": true,
    "maxBytes": 32768,
    "fallbackFilenames": [".mu/AGENTS.md", "CLAUDE.md"],
    "projectRootMarkers": [".git"],
    "imports": true,
    "claudeRules": true
  }
}
```
