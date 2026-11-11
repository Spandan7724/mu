# Changelog

## 0.3.1 — 2026-11-12

### Highlights

- **`/fork` picks where to branch.** Start a new session from before any earlier prompt, or
  copy the whole conversation with "here". The original session is left untouched.
- **`/skills` turns each skill on, manual or off.** Manual skills run only when you invoke
  them with `/name` or `$name`; off skills are ignored. Choices are saved by skill name in
  `~/.mu/config.json`.
- **`/cost` breaks down spend** by source (main turns, subagents, tools, compaction,
  `/btw`) and by model, and shows what fills the context window.

### Changes

- **`/btw` is a fixed read-only side conversation.** It can read files, list folders, run
  inspection commands and check background tasks. Everything else is denied rather than
  asked, configured denies still hold, and skills, MCP and subagents stay out of it. Its
  spend counts toward the session.
- `$name` attaches the named skill's instructions as hidden context, the same as `/name`.
- Codex models no longer offer the `ultra` alias; a saved `ultra` setting falls back to
  `max` instead of being rejected.
- Recall groups a fork's copied history under the entries it was copied from.

### Providers and cost

- Better prompt caching: Anthropic requests mark the last two user turns as cache
  breakpoints, and direct OpenAI requests send a cache key.
- The SSE parser treats a CRLF split across two chunks as one line ending.

### Reliability

- Every tool call gets a result after an interrupt, so an aborted turn never leaves a call
  unanswered. Parallel tool calls share one pool and report as each one settles.
- A refused `bash` call reads as denied or blocked instead of `exit ?`.
- The agent view shortens long command descriptions, so attaching no longer kills the
  worker.
- Session files grow by appending instead of being rewritten; listing sessions reads only
  their headers.

### Performance

- Streamed updates cross RPC, `mu -p --json` and the agent view as deltas instead of the
  whole partial message per token, and the agent roster is no longer rewritten per token.
- Streaming tool arguments are parsed on a timer instead of on every fragment.
- Faster TUI layout: a no-wrap fast path, remembered rows and markdown blocks, a cached
  review screen and row-level repaint.

### Terminal UI

- Parallel tool rows appear in call order and show each result as it settles.
- User turns carry a seafoam edge on every row with text.
- The running spinner is a one-cell braille eater whose tail grows every half lap.
- The `/btw` window titles its composer "side", drops the header row and shows its keys on
  the location row. The footer drops parts instead of truncating when space runs out.

### SDK and RPC

- **Wire format:** `message_update` events over RPC and `mu -p --json` carry only the
  `delta`, not the accumulated `message`. Rebuild the partial message with
  `WireEventDecoder`, or `toWireEvent` to produce the same format. `toolcall_start` and
  `toolcall_end` deltas now carry the tool name, and `toolcall_end` carries the parsed
  arguments.

**Full commit list:** https://github.com/Spandan7724/mu/compare/v0.3.0...v0.3.1

## 0.3.0 — 2026-11-03

### Breaking changes

- **The `todo` plan tool is gone** from the coding and browser profiles, and the SDK no
  longer exports `todoTool`, `TodoStore`, `renderTodos` or `TodoItem`. With/without evals
  on both profiles found no quality gain and up to 60% more time per task. Saved sessions
  still show their old plans.
- **The `search` subagent is removed.** Investigation is the main agent's work, or a `task`
  you ask for. A saved `search` pin is ignored, and old sessions still show `search` rows.
- **`task` subagents run only when asked:** by you, by operating or project instructions,
  or by a skill. The agent no longer delegates on its own.
- **In `mu -p`, `/model` and `/thinking` only list.** They never change saved defaults; use
  `--model` and `--thinking` to configure a run.
- **SDK:** `agent_end` is published after the turn's checkpoint and session save.

### Background work

- Move a running shell command or subagent to the background with `ctrl+z`, or with `b` on
  the selected row in transcript review. The model is told you want to keep working, so it
  does not wait on it. SDK: `Agent.backgroundToolCalls`; RPC: the `background_tools` op.
- Background `task` subagents, with `subagent_status`, `subagent_send` and `subagent_stop`.
  They follow the parent's live permission mode and share its budget.
- A background command or subagent finishing wakes a running agent, and `task_output` can
  wait for one.
- Press `x` twice in transcript review, or use `mu agents`, to stop a background command or
  subagent. The model is told that you stopped it.

### Skills and MCP

- Skills are found in other agents' skill folders as well as mu's own.
- MCP tools reach the model through `mcp_open`, `mcp_describe` and `mcp_call`. Servers start
  lazily, configs from other agents are picked up, and `${VAR}` placeholders work.
- `mu -p` runs skills and markdown commands.
- Invoking a skill or markdown command shows only what you typed. The instructions reach the
  model as hidden context.
- An MCP server's calls fold into one row marking each tool. `/mcp` and `/skills` reply on
  every surface, and approvals name the server's tool.

### Permissions

- Each command in a shell line is judged on its own, so `ls && rm -rf x` no longer passes as
  an inspection.
- Approvals show the rule they would add, can allow for the session, and take a typed
  reason when you deny. `/permissions` lists and removes saved rules.
- Prefix rules are saved to a gitignored local config, and configured denies hold in every
  mode, including full access.
- The permission mode is remembered per profile, including full access. Mode changes show
  in the footer instead of the transcript.

### Checkpoints and undo

- Inside a git repository, checkpoints record what the repository does not ignore. They
  rehash only changed paths and skip large untracked files. Outside a repository, and in
  your home directory or `/`, edits and writes can still be undone.
- `/track` and `/untrack` add ignored files or folders to checkpoints.
- Turn checkpoints off with `--no-checkpoints` or `checkpoints.enabled` in config.
- Faster checkpoints:
  - the before-turn checkpoint runs alongside the provider request;
  - read-only turns reuse it;
  - edit-only turns capture just the files they change;
  - stores repack in the background.
- `ctrl+c` cancels a slow checkpoint, a stale git index lock no longer blocks snapshots, and
  undo removes folders left empty by the files it deletes.

### Subagents

- Subagents run on your current model: `task` at your reasoning level, `recall` at `low`,
  and `counsel` one level above yours (at least `high`, at most `xhigh`).
- `/subagents` shows each role's model and level. Its editor can pin `task`, `counsel` or
  `recall` to any model you can use; pins are saved per profile.
- Name a model or level in a request ("use terra at low for them") and the delegation runs
  on it. An ambiguous or misspelled name makes the agent ask instead of guessing.

### Providers and models

- **Inception Labs** (`inception`): Mercury 3, 2.5 and 2, via `/login` or
  `INCEPTION_API_KEY`, with model discovery and reasoning levels.
- **Failed turns retry.** A turn that fails from a mid-stream overload, a rate limit, a
  dropped connection or a stalled stream runs again after the server's retry-after: up to 4
  attempts, waiting at most 10 minutes. Failed attempts are never sent back to the model.
- A reasoning request never falls back to off. Models with guessed metadata are marked
  inferred, and runs warn when the chosen thinking level is not offered.
- OpenAI fixes:
  - `cache_write_tokens` count as cache writes;
  - citation markup is stripped;
  - reasoning summary parts are kept separate;
  - a model call that returns nothing says so.
- Structured output reminds the model to report before failing, and failures carry the
  provider's error.

### Headless `mu -p`

- It now behaves like the app. Background tasks still running get one notice turn before
  they are stopped, and a browser hand-off is awaited in a visible window.
- `--thinking` sets the reasoning level for the run. `/diff` and `/undo` print text, and
  `/export` works.
- With `--json`, `/model` and `/thinking` return JSON data, and the output ends with a
  `result` line carrying the session id.
- Each reply prints once it is complete, so a retried attempt leaves no partial text.

### Terminal UI

- New transcript layout:
  - bodies step in two columns instead of sitting behind a rail;
  - thinking is dim italic;
  - one spacing rule for history and live rows;
  - background tasks sit in a rounded bracket.
- Transcript review (`ctrl+o`) scrolls with the mouse wheel and touchpad. It opens on the
  alternate screen and leaves your scrollback untouched.
- Diffs:
  - counts match git;
  - a dim `⋮` marks skipped lines between hunks;
  - large rewrites diff exactly;
  - running edits count lines instead of previewing a diff.
- Queued steers and follow-ups show in full above the composer.
- Web searches fold into exploration rows, and multi-line commands are one row until
  expanded.
- `/thinking` sets or lists the active model's reasoning level. The footer shows the
  permission mode.
- Smoother redraws: rows rebuild from the first changed item, and shrinking frames clear in
  place.
- The running spinner is a bouncing comet. Emoji width follows presentation, so symbols like
  `▪` take one cell.
- Up-arrow history recalls a command chosen from the `/` popup.

### Browser agent

- `select` and `fill_form` wait for a dropdown's search results instead of failing on
  "Loading…".
- Clicks on scrolled pages no longer report a false cover.
- Typing into a list combobox opens its list, and the agent is told when typed text is not
  a choice.
- The loop detector catches repeating call sequences, not only identical consecutive calls.

**Full commit list:** https://github.com/Spandan7724/mu/compare/v0.2.4...v0.3.0
