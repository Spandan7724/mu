# mu code review

## Review summary

- **Reviewed at:** 2026-07-26 21:34 UTC
- **Current milestone:** Tracker claims M7 complete and points to M8. This review verifies
  neither M6 nor M7 completion because checked acceptance criteria for both are
  contradicted by open findings below.
- **Reviewed revision:** `433a5b2` (`add context accounting and llm compaction with
  profile carryover`) plus the newly started M8 worktree; M7 findings below were
  reproduced against the committed state.
- **Scope this cycle:** M6 terminal/input/rendering/integration; M7 context accounting,
  compaction, resume/carryover/commands/usage; initial M8 checkpoint interface,
  shadow-git provider, SDK undo/redo/history integration
- **Open findings:** P0: 0 · P1: 19 · P2: 11 · P3: 1
- **Possibly fixed:** 0
- **Verified fixed:** 0
- **Accepted:** 0

### Validation

- M6 commit gate: `bun run ci` **passed** — 342 tests, 836 assertions.
- In-progress M7 focused tests: **passed** — 27 tests, 48 assertions; `tsc -b` passed.
  Focused multi-turn and resume reproductions below expose gaps not covered by them.
- Current M8 worktree: `tsc -b` passed before the latest checkpoint delta;
  `bun run ci` currently stops at two formatting/import-order errors in the in-progress
  checkpoint files. Focused shadow-checkpoint tests: **8 passed, 2 failed** (diff sees
  shadow metadata in the test worktree; the “user repo untouched” assertion sees
  `.shadow-git/`). The supposedly passing created-file restore test is insufficient, as
  shown by MU-CR-026.
- Focused read-only reproductions confirmed MU-CR-001 through MU-CR-008,
  MU-CR-010, MU-CR-011, MU-CR-014, and MU-CR-019. MU-CR-009, MU-CR-012,
  MU-CR-013, and MU-CR-015 through MU-CR-018 are direct code-path or
  contract/architecture contradictions. MU-CR-020 through MU-CR-025 remain confirmed
  against committed M7 revision `433a5b2`; MU-CR-026 through MU-CR-031 are confirmed
  against the current M8 worktree and must be rechecked as it changes.

### Highest-priority unresolved issues

1. MU-CR-001 — SIGINT/SIGTERM restore the terminal but prevent the process from exiting.
2. MU-CR-002 — untrusted model/tool text can emit arbitrary terminal control sequences.
3. MU-CR-003 / MU-CR-004 — common emoji widths and editor cursor boundaries are wrong.
4. MU-CR-005 — a bracketed-paste terminator split across reads permanently stalls paste.
5. MU-CR-011 — concurrent permission requests overwrite each other and can deadlock a run.
6. MU-CR-014 — a lone Esc is never flushed, so the advertised interrupt key does nothing.
7. MU-CR-015 — input during a run starts overlapping runs instead of steering.
8. MU-CR-020 — compaction is only a one-request transform and repeats every tool turn.
9. MU-CR-021 — persisted compaction drops the intended tail and carryover on resume.
10. MU-CR-022 — empty or length-truncated summaries can silently discard history.
11. MU-CR-026 — shadow restore cannot remove files created by an agent action.
12. MU-CR-027 / MU-CR-028 — undo/redo refs and conversation checkpoints are paired
    incorrectly and are not persisted.

`TODO.md` marks M6 and M7 complete. Its M6 claims about streaming, Esc abort, clean
Ctrl+C/SIGTERM exit, bracketed-paste splitting, kitty input, Unicode correctness,
differential rendering, and profile-independent renderer behavior conflict with the M6
findings. Its M7 claims about real accounting, one coherent compaction transition,
tail/carryover fidelity, and resume conflict with MU-CR-020 through MU-CR-025. M8 should
not be treated as the only remaining work. Later milestones were not reported merely for
being unfinished.

---

## Confirmed defects

### MU-CR-001 — P1 — Open — SIGINT and SIGTERM no longer terminate the process

- **Affected:** `packages/tui/src/terminal.ts:67-77`, `packages/tui/src/terminal.ts:92-98`
- **Requirement:** `docs/MILESTONES.md` M6 AC requires “Ctrl+C exits cleanly” and terminal
  cleanup to survive a kill test.
- **Defect:** `Terminal.start()` installs `restoreOnce` as the SIGINT and SIGTERM handler.
  Once a process installs a handler, the runtime's default signal termination no longer
  occurs. `restoreOnce` restores terminal state and removes listeners, but it neither exits
  nor re-raises the signal. An idle TUI therefore remains alive after Ctrl+C or SIGTERM.
- **Failure scenario / impact:** A user presses Ctrl+C to leave mu, or a supervisor sends
  SIGTERM. The terminal is restored, but mu continues running with its event loop and
  resources alive. A second signal may terminate it only because the handler was removed.
- **Evidence / reproduction (2026-07-26, `3ef83510b0d4` + worktree):**

  ```sh
  timeout --signal=INT --kill-after=0.2 0.1 bun -e \
    'import {Terminal} from "./packages/tui/src/terminal.ts";
     new Terminal({write:()=>{},columns:80,rows:24,isTty:true,setRawMode:()=>{}}).start();
     setInterval(()=>{},1000)'
  ```

  The process survived SIGINT and had to be SIGKILLed (`timeout_exit=137`).
- **Recommended correction:** Give each signal its own one-shot handler that restores
  terminal state and then preserves normal signal semantics (for example, remove the
  handler and re-send the same signal, or exit with the conventional 128+signal status).
  Keep fatal-error reporting separate from normal signal shutdown.
- **Tests to add:** Spawn the TUI lifecycle in a child process/PTY, send SIGINT and SIGTERM,
  assert prompt termination with the expected status, and assert that raw mode, cursor,
  bracketed paste, and any enabled keyboard protocol are restored.

### MU-CR-002 — P1 — Open — Untrusted content can inject terminal control sequences

- **Affected:** `packages/tui/src/wrap.ts:11-28`,
  `packages/tui/src/cells.ts:65-80`, `packages/tui/src/components.ts:276-303`
- **Requirement:** M6 must provide a reliable terminal surface; the review mandate
  explicitly includes security and terminal-safety problems. ANSI-aware wrapping must not
  turn model or subprocess output into trusted terminal commands.
- **Defect:** Model text, tool output, paths, arguments, and approval previews are rendered
  without sanitizing terminal controls. The wrapper only special-cases a loose
  `ESC [ ... m` shape and otherwise preserves ESC, OSC, DCS, APC, BEL, and other controls.
  As a result, untrusted content can clear/move the screen, alter the title, create
  deceptive links, or issue OSC 52 clipboard operations.
- **Failure scenario / impact:** A command prints an OSC 52 payload or a malicious
  repository file causes the model/tool renderer to echo one. Rendering the tail sends
  that sequence to the user's terminal, modifying their clipboard or terminal state.
  This is also an output-spoofing vector.
- **Evidence / reproduction (2026-07-26):** Passing
  `"\u001b]52;c;dGVzdA==\u0007"` through `toolCell`/`wrapText` leaves the OSC sequence in
  the returned line. Non-SGR CSI sequences are likewise not safely tokenized.
- **Recommended correction:** Introduce one terminal-output sanitizer used at every
  untrusted-text boundary. Strip C0/C1 controls and OSC/DCS/APC/PM sequences, and allow
  only a narrowly validated SGR subset if external ANSI color is intentionally supported.
  Internal styling should be represented structurally or emitted only after content is
  sanitized. Do not use a broad ANSI regex that conflates arbitrary CSI with SGR.
- **Tests to add:** Golden tests for OSC 52, OSC 8, cursor movement, clear-screen, DCS,
  embedded BEL, CR, and malformed/split escapes across agent markdown, tool tails, paths,
  approval previews, and diff content. Assert no forbidden control survives.

### MU-CR-003 — P1 — Open — Width and “grapheme” logic mismeasure common emoji

- **Affected:** `packages/tui/src/width.ts:7-43`, `packages/tui/src/width.ts:46-67`,
  `packages/tui/src/wrap.ts:70-89`
- **Requirement:** `docs/ARCHITECTURE.md` requires grapheme/EAW/emoji width measurement;
  M6 AC requires CJK/emoji input not to break layout.
- **Defect:** Width is summed per code point using incomplete hand-written ranges, and
  `graphemes()` merely attaches combining characters to the preceding code point. It does
  not form Unicode extended grapheme clusters. It therefore misses emoji such as U+1F680,
  counts ZWJ sequences and skin-tone sequences as multiple cells, and can wrap inside a
  single displayed glyph.
- **Failure scenario / impact:** Footer alignment, cursor placement, wrapping, diff
  gutters, and repaint height drift from the terminal's actual cells. A ZWJ glyph can be
  split across physical lines, leaving broken glyphs and corrupting differential repaint.
- **Evidence / reproduction (2026-07-26):**

  ```text
  stringWidth("🚀")    => 1   (terminal width: 2)
  stringWidth("👩‍💻") => 4   (terminal width: 2)
  stringWidth("👍🏽")  => 4   (terminal width: 2)
  ```

  The existing test covers only one emoji inside the implemented range.
- **Recommended correction:** Segment with a real extended-grapheme implementation
  (`Intl.Segmenter` is built into the selected runtime) and calculate width per grapheme
  using comprehensive, versioned Unicode/East-Asian-width data and emoji presentation
  rules. If a dependency is chosen, record it per .
- **Tests to add:** ZWJ families/professions, skin tones, VS15/VS16, keycaps, flags and
  singleton regional indicators, emoji outside the current ranges, combining scripts,
  ambiguous-width characters, and streaming partial graphemes. Assert wrapping never
  splits a grapheme and every returned line matches terminal cell width.

### MU-CR-004 — P1 — Open — Editor movement and deletion can split Unicode graphemes

- **Affected:** `packages/tui/src/components.ts:31-52`,
  `packages/tui/src/components.ts:58-113`
- **Requirement:** M6 AC requires CJK/emoji input not to break layout; the editor is the
  primary input component.
- **Defect:** `col` is a UTF-16 offset, but left/right movement changes it by one code
  unit. This can position the cursor between a surrogate pair or inside a multi-code-point
  grapheme. Backspace delegates to MU-CR-003's incomplete clusters, so it deletes only the
  final pictograph/modifier of many emoji sequences.
- **Failure scenario / impact:** Moving left across `🎉` and inserting text creates an
  invalid surrogate sequence. Backspacing `👩‍💻` leaves `👩‍`; backspacing a skin-tone
  emoji can leave the base glyph behind. Cursor rendering will also disagree with the
  logical editing position.
- **Evidence / reproduction (2026-07-26):** `setText("🎉")` sets `col=2`;
  `move("left")` sets `col=1`, an invalid boundary. `setText("👩‍💻"); backspace()` removes
  only `💻`.
- **Recommended correction:** Maintain cursor positions only at extended-grapheme
  boundaries (UTF-16 indices are fine if derived from a grapheme-boundary table). Make
  left/right/delete/backspace and vertical preferred-column movement use the same
  segmentation and cell-width primitives as rendering.
- **Tests to add:** Cursor movement, insertion, forward deletion, and backspace over
  astral emoji, ZWJ sequences, skin tones, flags, combining marks, and mixed CJK/ASCII.
  Add property tests asserting edits never create unpaired surrogates and cursor positions
  are always grapheme boundaries.

### MU-CR-005 — P1 — Open — A split bracketed-paste terminator stalls input permanently

- **Affected:** `packages/tui/src/input.ts:76-89`
- **Requirement:** M6 AC requires bracketed multi-line paste never to submit; the decoder
  explicitly promises that paste sequences may be split across reads.
- **Defect:** While pasting, if the complete end marker is absent, the decoder appends the
  entire buffer to `pasteBuffer`. It does not retain a suffix that could be the prefix of
  `ESC[201~`. When the terminator is split across reads, its first half becomes paste
  content and its second half can never match; the decoder remains in paste mode and
  consumes every later key.
- **Failure scenario / impact:** A normal chunk boundary inside the six-byte end marker
  makes the composer appear frozen and prevents submission or escape handling for the rest
  of the session.
- **Evidence / reproduction (2026-07-26):**

  ```ts
  const d = new InputDecoder();
  d.push("\u001b[200~abc\u001b[20"); // []
  d.push("1~");                      // [], still pasting
  d.push("x");                       // [], x is swallowed too
  ```

  The current split-paste test splits the payload, not the end marker.
- **Recommended correction:** When no full terminator is found, retain the longest suffix
  of the current buffer that is a prefix of `PASTE_END`; append only the definitely
  non-marker prefix to paste content.
- **Tests to add:** Split both start and end markers at every possible byte boundary,
  including one-byte chunks; include marker-like text inside payloads and keys immediately
  following a completed paste.

### MU-CR-006 — P2 — Open — Styled truncation emits malformed ANSI

- **Affected:** `packages/tui/src/width.ts:70-83`, `packages/tui/src/style.ts:75-78`
- **Requirement:** M6 architecture requires ANSI-aware text measurement/wrapping and
  components rely on `truncateToWidth`.
- **Defect:** `truncateToWidth` first measures after stripping ANSI but then iterates
  `graphemes(text)` over the original escape-coded string. Escape parameters are treated
  as visible characters, so the returned prefix can cut through the SGR sequence and omit
  its text/reset.
- **Failure scenario / impact:** Truncating styled selection text, metadata, or nested
  component output prints broken escape fragments and can leak style into subsequent
  terminal content.
- **Evidence / reproduction (2026-07-26):**

  ```text
  truncateToWidth(styleText("abcdef", {accent:true}, "ansi16"), 4)
  => "\u001b[36…"
  ```

- **Recommended correction:** Tokenize safe SGR separately from grapheme content, truncate
  visible graphemes, and close active styles before the ellipsis/reset. Share this parser
  with wrapping after addressing MU-CR-002.
- **Tests to add:** Truncation inside one and nested styles, style changes and resets,
  wide/combining graphemes under style, ellipses wider than the limit, and malicious
  non-SGR controls.

### MU-CR-007 — P2 — Open — Kitty functional keys are inserted as private-use text

- **Affected:** `packages/tui/src/input.ts:132-162`,
  `packages/tui/src/terminal.ts:80-82`, `packages/tui/src/terminal.ts:92-98`
- **Requirement:** `docs/ARCHITECTURE.md` explicitly requires the input decoder to support
  the kitty keyboard protocol.
- **Defect:** Kitty `CSI codepoint;modifiers u` input is treated uniformly as printable
  Unicode. Kitty's functional key codes (arrows, navigation keys, etc.) live in the
  private-use range and require mapping. For example, the Up key code is returned as a
  printable private-use character with `text`, not `name: "up"`. Colon subparameters and
  key event types are also not parsed. The terminal layer does not negotiate/enable and
  later restore a keyboard protocol, so behavior depends on terminal configuration.
- **Failure scenario / impact:** In a kitty-enabled terminal, pressing an arrow can insert
  a private-use glyph into the prompt instead of moving the cursor; repeats/releases may
  become spurious edits.
- **Evidence / reproduction (2026-07-26):**

  ```text
  new InputDecoder().push("\u001b[57352;1u")
  => key { name: "\uE008", text: "\uE008", ... }  // should be "up"
  ```

- **Recommended correction:** Implement the protocol's functional-key table, modifier
  subparameters, and press/repeat/release semantics. Negotiate the protocol in the
  terminal lifecycle and restore the prior mode during every shutdown path.
- **Tests to add:** Kitty arrows/navigation/function keys, shifted Enter/Tab, colon
  alternate-key fields, repeat/release events, split sequences, negotiation response, and
  cleanup.

### MU-CR-008 — P2 — Open — Rendered component lines can exceed the supplied terminal width

- **Affected:** `packages/tui/src/cells.ts:25-27`,
  `packages/tui/src/cells.ts:65-81`, `packages/tui/src/cells.ts:119-138`,
  `packages/tui/src/components.ts:193-211`, `packages/tui/src/components.ts:263-273`
- **Requirement:** M6 components render lines at width W; resize must repaint correctly,
  and golden lines should lock component layout.
- **Defect:** `body()` forces at least 20 cells even when the terminal is narrower. Tool
  heads, selection labels, approval titles/options, and diff headers are not bounded.
  Diff content also has an off-by-one budget: at width 80 the prefix consumes 12 cells but
  content is allowed 69, permitting an 81-cell line.
- **Failure scenario / impact:** Narrow windows and long model names/paths/arguments cause
  physical terminal auto-wrap. `InlineRenderer` counts logical array entries, not physical
  wrapped rows, so its cursor-up/clear calculations target the wrong rows and corrupt the
  bottom pane or transcript.
- **Evidence / reproduction (2026-07-26):** The arithmetic at
  `cells.ts:119-137` permits `2 + 2 + 5 + 1 + 1 + 1 + 69 = 81` cells for a width-80
  context. A context width below 22 still gets a 20-cell body plus margin/prefix.
- **Recommended correction:** Centralize exact prefix/content width budgeting, clamp
  available content to zero rather than imposing an oversized minimum, and truncate or
  wrap every dynamic field. Renderer inputs must be guaranteed not to auto-wrap.
- **Tests to add:** For every component and every width in a narrow-to-normal range,
  assert `stringWidth(line) <= width`; include long Unicode labels, paths, summaries,
  approval options, empty widths, and diff continuation lines.

### MU-CR-009 — P2 — Open — Compaction cell violates the no-separators visual contract

- **Affected:** `packages/tui/src/cells.ts:91-97`
- **Requirement:** `docs/STYLES.md` Layout Grammar says there are no horizontal separator
  lines inside the transcript and that the only rule line on screen is above the composer.
- **Defect:** `compactionCell()` intentionally fills the transcript width with `─` before
  the compaction label.
- **Failure scenario / impact:** Every compaction introduces a prominent transcript rule,
  breaking the settled quiet-minimal visual identity and making the composer rule no
  longer unique.
- **Evidence:** Direct inspection of the returned line and the normative style text.
- **Recommended correction:** Render compaction as terse dim metadata using whitespace,
  the activity rule, or another existing grammar element without a horizontal separator.
- **Tests to add:** Golden snapshot asserting the compaction cell has the page margin,
  semantic metadata styling, and no horizontal rule run.

### MU-CR-010 — P3 — Open — Hanging indent reduces the first line's usable width

- **Affected:** `packages/tui/src/wrap.ts:48-83`
- **Requirement:** Components return lines at width W; a hanging indent applies to
  continuation lines, not the first line.
- **Defect:** `usable` subtracts `indentWidth` for every line even though `flush()` only
  prepends the indent after the first line. The first line wraps early and wastes exactly
  the indent width.
- **Failure scenario / impact:** User/error/markdown text takes extra rows, increasing
  repaint work and causing avoidable transcript churn. At width 12 with a four-cell indent,
  a ten-cell word is split into 8+2 although it fits on the first line.
- **Evidence / reproduction (2026-07-26):**

  ```text
  wrapLine("1234567890", 12, "    ") => ["12345678", "    90"]
  ```

- **Recommended correction:** Use full `width` for the first physical line and
  `width - indentWidth` only for continuation lines; recompute the limit after each flush.
- **Tests to add:** First-line exact fit, multiple continuations, wide graphemes, explicit
  newlines, and indent widths equal to or greater than the terminal width.

### MU-CR-011 — P1 — Open — Concurrent permission asks overwrite each other and can deadlock

- **Affected:** `packages/tui/src/app.ts:52-54`, `packages/tui/src/app.ts:137-146`,
  `packages/tui/src/app.ts:276-295`
- **Requirement:** `docs/ARCHITECTURE.md` permits parallel batches of concurrency-safe
  tools; permission asks are event/reply pairs and must resolve the correct request.
  Review scope explicitly includes permission and concurrency errors.
- **Defect:** App stores only one `approval`. A second `permission_asked` overwrites the
  first, and any `permission_resolved` clears the overlay without checking `requestId`.
  Core prepares concurrency-safe tool calls inside `Promise.all`, so multiple asks can
  legitimately be pending at once.
- **Failure scenario / impact:** Requests A and B arrive. The overlay shows B. Resolution
  of A (from another surface/hook or event ordering) clears B; alternatively the user
  resolves B and A remains hidden. The unresolved SDK permission callback holds the whole
  parallel batch open forever.
- **Evidence / reproduction (2026-07-26):** Feed an `App` asks A then B, followed by
  `permission_resolved` for A. Before the resolution `renderBottom()` shows “ask b”;
  afterward it returns to the composer and B is lost.
- **Recommended correction:** Maintain a FIFO queue/map keyed by request ID. Display one
  active request, remove only the matching resolved request, and advance to the next.
  Decide and document ordering when asks arrive while one is visible. On exit/abort,
  explicitly deny or otherwise settle every outstanding request.
- **Tests to add:** Two parallel asks resolved in both orders, denial/escape, a resolution
  for an unknown/stale ID, abort/exit with queued asks, and an end-to-end parallel-safe
  tool batch proving no permission promise remains pending.

### MU-CR-012 — P1 — Open — TUI bypasses the public SDK boundary

- **Affected:** `packages/tui/src/app.ts:4`,
  `packages/tui/src/registry.ts:1`, `packages/tui/package.json`
- **Requirement:** `docs/PROJECT.md` and : “The CLI/TUI is built on the public SDK” and
  “If the TUI needs private internals, that's a bug in the SDK surface.” Dependency
  direction is `cli → tui → sdk → core`.
- **Defect:** TUI source imports `AgentEvent`, `PermissionRequest`, and
  `ToolResultMessage` directly from `@mu/core`, even though `@mu/tui` declares only `mu`
  as a dependency. `mu` already publicly re-exports the event and permission types; the
  missing tool-result type should be added to that public surface or avoided. Emitted TUI
  declarations can also reference an undeclared package, failing under strict package
  managers/consumers.
- **Failure scenario / impact:** The flagship SDK consumer no longer validates the SDK's
  completeness. A published `@mu/tui` can fail type resolution when transitive
  dependencies are not hoisted, and core changes can silently couple directly into TUI.
- **Evidence:** Direct source/package-manifest inspection at the reviewed worktree.
- **Recommended correction:** Import all kernel-facing public types from `mu`. If the
  required result shape is absent, expose an appropriate SDK contract rather than reaching
  through the facade. Add a package-boundary/import-direction check to CI.
- **Tests to add:** Pack/install the workspace packages into a strict isolated fixture and
  typecheck a TUI consumer; lint imports so `packages/tui` cannot reference `@mu/core` or
  `@mu/ai`.

### MU-CR-013 — P2 — Open — Coding renderers are owned by the TUI instead of the coding profile

- **Affected:** `packages/tui/src/registry.ts:78-122`,
  `packages/profiles/coding/src/index.ts:20-58`
- **Requirement:** `docs/PROJECT.md` principle 1 and `docs/ARCHITECTURE.md` Profiles:
  renderers are part of a profile bundle; the renderer registry is what makes the TUI
  domain-swappable.
- **Defect:** The TUI package hard-codes renderer behavior for `read`, `edit`, and `bash`
  and exports it as `codingRenderers`, while the completed coding profile supplies no
  `renderers`. Avoiding an import from the profile does not remove the coding-domain
  assumption; it only relocates it into the supposedly profile-neutral surface.
- **Failure scenario / impact:** Profile-specific detail schemas and visual behavior drift
  separately from their tools. A new or renamed coding tool requires changing the TUI,
  and alternative frontends cannot obtain the coding renderers from the profile bundle.
- **Evidence:** Direct comparison of the implemented registry, `Profile.renderers`
  contract, and `codingProfile()` return value.
- **Recommended correction:** Define the coding renderer descriptors/implementations in
  `@mu/profile-coding` using the public renderer abstraction, return them through
  `Profile.renderers`, and have the TUI adapt registered public renderers without knowing
  tool names. If renderers require TUI primitives, make those primitives a stable public
  extension UI contract without reversing package dependencies.
- **Tests to add:** Load the coding profile and assert its renderer set follows its toolset;
  load a non-coding profile and assert no coding renderer is present; verify a profile or
  extension renderer overrides the generic fallback end to end.

### MU-CR-014 — P1 — Open — Esc never reaches the app in the real interactive loop

- **Affected:** `packages/tui/src/input.ts:129-130`,
  `packages/tui/src/input.ts:182-189`,
  `packages/cli/src/interactive.ts:106-115`
- **Requirement:** M6 AC explicitly requires Esc to abort an active run.
- **Defect:** A lone ESC is intentionally buffered until an idle timeout distinguishes it
  from an escape sequence, but the interactive loop never schedules or calls
  `flushPendingEscape()`. It only calls `push()` when another stdin chunk arrives.
- **Failure scenario / impact:** The user presses Esc during a long provider response.
  `push("\u001b")` returns no event, so `App.handleInput()` never invokes `agent.abort()`.
  If another key is later pressed, the buffered ESC may instead be decoded as Alt+that
  key.
- **Evidence / reproduction (2026-07-26):**

  ```text
  new InputDecoder().push("\u001b") => []
  ```

  `interactive.ts` has no reference to `flushPendingEscape`; the current app test bypasses
  the decoder by manually constructing an Escape key after feeding raw ESC.
- **Recommended correction:** Own a short cancellable escape-disambiguation timer in the
  stdin integration. Reset it on new data, flush the pending ESC on idle, dispatch the
  resulting event, and cancel it during shutdown.
- **Tests to add:** Drive the actual stdin-decoder integration with a lone Esc and wait past
  the timeout; assert abort. Also test an arrow/Alt sequence arriving before the timeout,
  rapid repeated Esc, and shutdown with a timer pending.

### MU-CR-015 — P1 — Open — Input during a run launches a concurrent run instead of steering

- **Affected:** `packages/cli/src/interactive.ts:45-75`,
  `packages/tui/src/app.ts:233-245`
- **Requirement:** `docs/ARCHITECTURE.md` Agent Loop requires mid-run user input to be
  injected through steering before the next LLM call. The SDK exposes `Agent.send()` for
  that path.
- **Defect:** `onSubmit` always calls `startRun()`, even when `app.isRunning`. The composer
  remains active during a run, so pressing Enter starts another `agent.stream()` on the
  same Agent. The Agent is not a multi-run scheduler: a new execute resets its shared
  abort controller while both runs share session state, usage totals, steering queues,
  and provider instance.
- **Failure scenario / impact:** Typing a correction while the agent works creates
  overlapping transcripts and session writes; Esc aborts only the most recently assigned
  controller. Results and usage can interleave or corrupt resume state instead of the
  correction reaching the next turn.
- **Evidence:** Direct inspection of the wired default CLI path; `onSubmit` has no running
  branch and `Agent.send()` is never called.
- **Recommended correction:** When a run is active, route submitted user text to
  `agent.send()` and render/queue it as steering. Serialize top-level runs and retain/await
  the one active run promise. Decide separately how follow-ups are entered after a run
  becomes idle.
- **Tests to add:** Submit while a delayed fake run is active and assert one provider run,
  steering before the next call, ordered transcript/session entries, and Esc aborting the
  sole run.

### MU-CR-016 — P1 — Open — Exiting the TUI leaves the active run and permission promises alive

- **Affected:** `packages/cli/src/interactive.ts:42-75`,
  `packages/cli/src/interactive.ts:110-123`
- **Requirement:** M6 requires clean Ctrl+C exit; abort/cancellation must reach provider and
  tools. Permission asks must never remain hanging.
- **Defect:** Ctrl+C only sets `exiting = true`. `startRun()` was launched with `void` and
  its promise is not retained. The `finally` block restores the terminal but neither
  aborts nor awaits the active run and does not settle `pendingPermissions`.
- **Failure scenario / impact:** A user exits during a model request, tool execution, or
  approval. The UI disappears but the process can keep running, mutate files, repaint
  after restore, or wait forever on a permission promise. This also races terminal cleanup
  with `renderer.commit()` from the detached run.
- **Evidence:** Direct inspection of `onExit`, detached `startRun`, and the shutdown
  `finally` block.
- **Recommended correction:** Track the active run promise. On exit, abort the Agent,
  deny/settle all pending permissions, await run completion, stop painting, then restore
  the terminal. Make renderer callbacks no-op once shutdown begins.
- **Tests to add:** Exit during provider streaming, a long tool, and an approval; assert
  abort propagation, no writes after terminal restore, every permission settled, and
  prompt process exit.

### MU-CR-017 — P2 — Open — “Always allow” is treated exactly like “allow once”

- **Affected:** `packages/tui/src/app.ts:291-295`,
  `packages/cli/src/interactive.ts:57-60`
- **Requirement:** `docs/STYLES.md` approval options include “always allow”; M5 AC requires
  the choice to persist and apply to the next session.
- **Defect:** App correctly passes `remember=true`, but the interactive callback accepts
  only `(id, outcome)` and discards the third argument. It merely resolves the current
  promise and never calls the coding profile's persistence mechanism or adds an in-memory
  rule.
- **Failure scenario / impact:** A user chooses “always allow” and is asked again on the
  next identical call and next session. The UI makes a durable-permission claim that is
  false.
- **Evidence:** Direct inspection of the callback and `rememberAllow` implementation in the
  coding profile.
- **Recommended correction:** Preserve the matched permission/pattern context, route a
  remembered allow through a profile/surface-neutral persistence callback, update the
  current run's rules immediately, and report persistence failures without silently
  granting permanence.
- **Tests to add:** Choose always-allow, repeat the call in the same run and in a new
  session, and assert no second ask. Test write failure and non-coding profiles.

### MU-CR-018 — P2 — Open — Interactive commands and CLI flags report/apply state incorrectly

- **Affected:** `packages/cli/src/interactive.ts:23-36`,
  `packages/cli/src/interactive.ts:78-90`
- **Requirement:** Commands are shared across surfaces; `/model` must switch the active
  model. CLI help advertises `--max-turns`, `--max-cost`, and `--allow-all` without limiting
  them to headless mode.
- **Defect:** The command context's `setModel` is a no-op while the command returns
  “Model set to …”; `getModel` closes over immutable `modelRef`. Interactive construction
  also ignores `args.maxTurns`, `args.maxCostUsd`, and `args.allowAll`.
- **Failure scenario / impact:** Users are told a model changed when subsequent provider
  calls use the old one. Budget and permission flags accepted by the parser have no effect
  in the default interactive product.
- **Evidence:** Direct code inspection of Agent construction and command callbacks.
- **Recommended correction:** Put mutable model selection behind a supported public Agent
  operation (or reconstruct safely between runs), update footer state, and share one
  validated option-resolution path across headless/RPC/TUI for budgets and permission
  presets. Never print success until state changed.
- **Tests to add:** `/model` followed by a provider call and footer assertion; invalid
  model leaves state unchanged; each advertised flag changes interactive Agent behavior.

### MU-CR-019 — P1 — Open — The wired TUI discards all streaming message and tool updates

- **Affected:** `packages/tui/src/app.ts:85-175`,
  `packages/tui/src/app.ts:182-206`,
  `packages/cli/src/interactive.ts:67-75`
- **Requirement:** M6 AC requires streaming markdown and live/running tool cells with a
  bounded output tail; architecture says stream deltas are coalesced at 30–60 fps.
- **Defect:** `App.handleEvent()` has no cases for `message_start`, `message_update`, or
  `tool_execution_update`. `tool_execution_start` is stored in `pendingTools`, but
  `renderBottom()` never renders that map. Output appears only when `message_end` or
  `tool_execution_end` commits a completed cell, and assistant text is sent to
  `agentCell()` rather than the implemented markdown renderer.
- **Failure scenario / impact:** During a long model response or command the UI appears
  frozen except for the spinner. Tool progress is lost, Markdown is not rendered, and
  users cannot inspect a bounded live tail before completion.
- **Evidence / reproduction (2026-07-26):** A `message_update` and
  `tool_execution_start` both return `[]`; `renderBottom()` remains only composer/footer.
- **Recommended correction:** Maintain in-progress assistant/thinking/tool cell state from
  start/update/end events, render it in the managed bottom region, coalesce deltas through
  the existing throttled renderer, and commit the finalized cell exactly once. Use the
  markdown component for text while preserving safe sanitization per MU-CR-002.
- **Tests to add:** A delayed fake-agent event script asserting visible intermediate text,
  thinking, partial tool output, bounded tails, Markdown formatting, coalescing, final
  commit without duplication, and abort mid-stream.

### MU-CR-020 — P1 — Open — Compaction is not installed into live loop state and repeats

- **Affected:** `packages/sdk/src/agent.ts:342-393`,
  `packages/core/src/loop.ts:305-307`
- **Requirement:** M7 AC requires auto-compaction to replace old context with summary +
  carryover + tail and let the session continue coherently.
- **Defect:** Compaction is implemented in `transformContext`, whose return value is used
  only for one provider request. `runLoop` retains its original
  `currentContext.messages`; neither the compacted messages nor a compaction boundary are
  installed into that live state. Since the full context still exceeds the threshold,
  every following LLM call in the same tool-using run summarizes it again.
- **Failure scenario / impact:** A long prompt yields a tool call. Mu compacts before that
  call, executes the tool, then compacts the original long history again before returning
  the tool result. This adds latency/cost, produces inconsistent summaries, and can loop
  on every tool step.
- **Evidence / reproduction (2026-07-26 M7 worktree):** A tiny-window FakeProvider script
  with one tool-use turn required four provider requests:
  `summary1 → tool call → summary2 → final`, proving two compactions in a single run.
- **Recommended correction:** Make compaction a loop state transition, not a stateless
  pre-request transform. Add a control directive/API that atomically replaces
  `currentContext.messages` with summary + tail and records the same boundary. Extension
  context transforms may remain request-local and should not be conflated with persistent
  transcript replacement.
- **Tests to add:** A threshold-crossing tool-use conversation with multiple tool turns
  must compact exactly once, and every subsequent provider request must receive the same
  summary plus the growing post-compaction tail, never any summarized message.

### MU-CR-021 — P1 — Open — Resume keeps the wrong tail and omits carryover

- **Affected:** `packages/sdk/src/agent.ts:371-386`,
  `packages/core/src/session.ts:175-194`
- **Requirement:** M7 AC requires compaction to survive resume as summary + carryover file
  lists + untouched recent tail only.
- **Defect:** The compaction entry stores `firstKeptEntryId: this.tree.head`, which is the
  most recent pre-compaction entry, not the first entry of `result.keptMessages`.
  `SessionTree.messagesAt()` then resumes from that one ID. It also reconstructs the
  summary from `entry.summary` alone and ignores `entry.carryover`, unlike
  `applyCompaction()`.
- **Failure scenario / impact:** Immediate post-compaction context keeps 30% of history,
  but reopening the session keeps only the last old message (which can be an orphan tool
  result) and silently drops coding carryover. Resume behavior therefore differs from the
  running session and loses relevant work state.
- **Evidence / reproduction (2026-07-26):** After five user/assistant pairs, manual
  compaction planned a three-message tail. JSONL reload produced only
  `["summary", "continue", "final"]`, dropping the two earlier tail messages. The stored
  entry contained `modifiedFiles` and structured todos, but the resumed summary text was
  only `"summary"`.
- **Recommended correction:** Preserve a mapping from compacted message indices to session
  entry IDs and write the actual first-kept ID. Rebuild the exact same typed summary
  message in both live and resume paths, including deterministically serialized carryover.
  Validate that the first kept entry is on the compaction entry's ancestor path.
- **Tests to add:** Assert exact message identities/content for a multi-message tail before
  and after JSONL round-trip; cover a tool-call/result boundary, carryover file lists and
  todos, and malformed/missing first-kept IDs.

### MU-CR-022 — P1 — Open — Empty and length-truncated summaries are accepted as successful

- **Affected:** `packages/core/src/compaction.ts:129-150`,
  `packages/core/src/compaction.ts:155-175`
- **Requirement:** Full compaction replaces history; omitted content is lost. It must fail
  safely rather than discard history unless a complete usable summary exists.
- **Defect:** `compact()` rejects only `error` and `aborted`. A normal response with no text
  returns `summary: ""`, and a `stopReason: "length"` response is accepted as a complete
  summary. `applyCompaction()` treats an empty summary by returning only
  `keptMessages`, not the original input, so the summarized head is silently removed.
- **Failure scenario / impact:** A provider returns no textual block, a safety refusal, or
  hits the output limit. Mu reports compaction success and loses decisions/task state from
  the head of the conversation.
- **Evidence / reproduction (2026-07-26):** Compacting ten messages with a successful
  empty FakeProvider response yielded an empty summary and `applyCompaction()` returned
  only the three kept messages. A `length` response containing `"partial"` was accepted as
  the summary. The existing “empty summary leaves transcript untouched” test supplies the
  already-trimmed tail as `keptMessages`, so it does not test preservation.
- **Recommended correction:** Require `stopReason === "end"` and a non-empty text summary;
  otherwise throw and keep the complete original transcript. Consider validation/minimum
  content and an explicit retry policy for length truncation.
- **Tests to add:** Empty content, thinking-only/tool-call/refusal output, `length`,
  whitespace-only text, and failure fallback asserting every original message remains.

### MU-CR-023 — P1 — Open — Layer-0 accounting does not use real provider context usage

- **Affected:** `packages/sdk/src/agent.ts:342-352`,
  `packages/sdk/src/agent.ts:407-418`,
  `packages/core/src/compaction.ts:34-47`
- **Requirement:** M7 AC says footer ctx% tracks real usage; architecture says Layer 0 uses
  API usage plus estimation to drive thresholds.
- **Defect:** Although `contextState()` accepts `lastUsage`, Agent never passes it, so the
  auto threshold is always based on the character heuristic. Later `usage_updated`
  reports only `turn.message.usage.inputTokens`, omitting normalized cache-read and
  cache-write input tokens. `lastContextPercent` is set to the pre-request estimate and is
  not recomputed after compaction, while the footer event uses a different formula.
- **Failure scenario / impact:** A heavily cached Anthropic/OpenAI session can display a
  tiny context percentage and trigger compaction too late or inconsistently; `/cost` and
  the footer disagree about ctx%. After successful compaction, the reported percentage
  remains at the threshold-crossing value.
- **Evidence:** Provider adapters deliberately split uncached input from cache read/write;
  Agent ignores those fields in the emitted context count and never supplies any Usage to
  `contextState`.
- **Recommended correction:** Track the most recent assistant Usage, compute context tokens
  as uncached + cacheRead + cacheWrite (plus a conservative delta for messages added since
  that request), and use one authoritative `ContextState` for auto-trigger, public getter,
  and `usage_updated`. Recompute after compaction/provider completion.
- **Tests to add:** Dominant cached input, uncached input, new tool results after the last
  report, post-compaction percentage drop, and equality among event/footer/getter values.

### MU-CR-024 — P2 — Open — Compaction cost is omitted and tokens-freed is overstated

- **Affected:** `packages/core/src/compaction.ts:129-150`,
  `packages/sdk/src/agent.ts:361-370`, `packages/sdk/src/agent.ts:407-418`
- **Requirement:** Usage/cost tracking and budgets cover the agent's provider work;
  `compaction_end.tokensFreed` is a factual event field.
- **Defect:** The summarizer's assistant Usage is discarded, so session totals, max-cost
  budgets, `/cost`, and footer cost omit every compaction request. `tokensFreed` is simply
  the estimate of the removed head and does not subtract the newly inserted summary and
  carryover.
- **Failure scenario / impact:** Repeated/large compactions incur unreported spend and can
  exceed `maxCostUsd`; UI claims more context was freed than actually was.
- **Evidence:** `compact()` awaits the assistant result but returns no Usage; Agent only
  adds normal turn usage in `shouldStopAfterTurn`. The calculation subtracts
  `estimateTokens([])`, always zero.
- **Recommended correction:** Return compactor Usage, add it to session totals and budget
  checks, and compute freed tokens as `old-context estimate - compacted-context estimate`
  (clamped at zero), or use provider counts when available.
- **Tests to add:** Exact totals and budget crossing with a priced compaction response;
  summary/carryover large enough to materially reduce the freed count.

### MU-CR-025 — P2 — Open — Structured carryover is stringified as `[object Object]`

- **Affected:** `packages/core/src/compaction.ts:155-186`,
  `packages/profiles/coding/src/index.ts:48-53`
- **Requirement:** M7 coding carryover must preserve read/modified files and task state
  coherently.
- **Defect:** `formatCarryover()` joins arrays with `value.join(", ")`. Coding carryover's
  `todos` is an array of objects, so immediate compacted context renders every task as
  `[object Object]`. Non-array nested objects are also coerced with `String(value)`.
- **Failure scenario / impact:** The post-compaction model loses todo content/status even
  before resume; arbitrary profile carryover becomes ambiguous or unusable.
- **Evidence:** Direct comparison of `codingProfile().carryoverExtractor` with
  `formatCarryover`.
- **Recommended correction:** Define a JSON-serializable carryover contract and serialize
  it deterministically (or let each profile provide model-visible carryover text alongside
  structured persistence). Preserve nesting and escape delimiters.
- **Tests to add:** Coding todos with multiple statuses, nested objects, strings containing
  commas/newlines, empty values, and exact live/resume equivalence.

### MU-CR-026 — P1 — Open — Shadow restore does not remove files created after a checkpoint

- **Affected:** `packages/profiles/coding/src/checkpoint.ts:123-132`,
  `packages/profiles/coding/src/checkpoint.test.ts:38-52`
- **Requirement:** M8 AC requires `/undo` to restore files and the user's dirty state
  faithfully.
- **Defect:** `git checkout <ref> -- .` restores paths present in the target tree but does
  not delete worktree paths absent from it. The following `git reset <ref> -- .` only
  updates the shadow index; a file created after the checkpoint remains as untracked
  content. The test named “restore removes files created after the snapshot” never asserts
  that `added-later.txt` is absent.
- **Failure scenario / impact:** `write` creates a source file or `bash` generates several
  files. `/undo` reports success but all created files remain, leaving workspace and
  conversation out of sync.
- **Evidence / reproduction (2026-07-26 M8 worktree):** In a temporary worktree,
  snapshot `keep.txt`, create `added.txt`, then `restore(ref)`. `readdir` still returned
  `["keep.txt", ".shadow-git", "added.txt"]`; `access("added.txt")` succeeded.
- **Recommended correction:** Compute the exact path delta and remove only paths that were
  introduced after the target snapshot, using NUL-delimited literal pathspecs and explicit
  safety checks. Do not run a broad clean that could delete ignored/user-owned files.
  Restore tracked content and deletions atomically as far as possible.
- **Tests to add:** Assert actual absence of one and nested newly created files, renamed
  files, ignored files that must remain, odd filenames, and a mix of pre-existing dirty
  files plus agent-created files.

### MU-CR-027 — P1 — Open — CheckpointHistory skips states and cannot redo an action

- **Affected:** `packages/core/src/checkpoint.ts:31-63`,
  `packages/sdk/src/agent.ts:283-305` (snapshot occurs before tool execution)
- **Requirement:** M8 says snapshots occur before mutating batches and `/undo`/`/redo`
  reverse each other.
- **Defect:** History records pre-action refs. `popForUndo()` pops the last pre-action
  checkpoint but returns the *previous* ref as `restoreTo`. With checkpoints A(state 0),
  B(state 1), C(state 2) and current state 3, undo should restore C but restores B,
  removing two actions. `popForRedo()` returns C, which restores state 2 rather than the
  missing post-action state 3; the implementation never captured a ref capable of redoing
  the last action.
- **Failure scenario / impact:** After two or more mutating turns, one `/undo` reverts too
  much. `/redo` only advances to a pre-action state and cannot recreate the action that was
  just undone.
- **Evidence:** Direct state-machine analysis of `record`, `popForUndo`, `popForRedo`, and
  the pre-execution call to `snapshotIfMutating`.
- **Recommended correction:** Represent each reversible step with explicit before and
  after refs (or reversible patches) plus before/after conversation IDs. Move a cursor
  through immutable steps; undo restores `before`, redo restores `after`. A fresh action
  truncates only the forward branch.
- **Tests to add:** Three distinct filesystem states with consecutive undo/undo/redo/redo,
  asserting exact content and conversation head after every operation; fresh mutation
  after undo invalidates only redo.

### MU-CR-028 — P1 — Open — Checkpoint refs are not persisted and undo rewinds to an invalid node

- **Affected:** `packages/sdk/src/agent.ts:185-215`,
  `packages/sdk/src/agent.ts:283-305`,
  `packages/core/src/session.ts:119-137`
- **Requirement:** M8 AC requires `checkpointRef` on session entries, paired
  conversation/workspace rewind, and trustworthy resume.
- **Defect:** Snapshot refs exist only in the Agent's in-memory `CheckpointHistory`; no
  session message is written or updated with `checkpointRef`. The recorded `entryId` is
  `tree.head` after the assistant tool-call message has already been appended. Undo forks
  to that same assistant entry, retaining tool calls while removing their results instead
  of rewinding to the pre-step parent. Reloading a session reconstructs no history at all.
- **Failure scenario / impact:** Immediate undo leaves a provider-invalid orphan tool call
  in context. After restart `/undo`, `/redo`, and `/diff` have no checkpoint history even
  though shadow commits exist.
- **Evidence:** No call passes a ref to `SessionTree.appendMessage(..., checkpointRef)`;
  `CheckpointHistory` has no reconstruction path. Event ordering appends the assistant
  message before `beforeToolCall` snapshots and records `tree.head`.
- **Recommended correction:** Persist the ref on the precise session step and record both
  the pre-step conversation parent and post-step node. Rebuild checkpoint history from the
  active JSONL branch on resume. Undo must validate the target before changing either
  workspace or conversation and avoid orphan tool protocol messages.
- **Tests to add:** Inspect JSONL for refs, resume a fresh Agent and undo/redo, assert
  provider-valid message pairing after rewind, and branch/fork histories.

### MU-CR-029 — P2 — Open — Checkpoint failures are silently ignored while mutations proceed

- **Affected:** `packages/sdk/src/agent.ts:283-305`
- **Requirement:** Checkpointing exists to make mutating steps recoverable; errors must not
  produce misleading guarantees.
- **Defect:** Snapshot exceptions and undefined refs are swallowed. The mutating tool then
  runs normally, no event or warning is emitted, and `snapshottedThisTurn` remains true so
  later mutations in the turn do not retry.
- **Failure scenario / impact:** Disk-full, missing-git, permissions, or repository
  corruption disables undo for a write while the UI continues as if the step were
  checkpointed.
- **Recommended correction:** Emit a typed/user-visible checkpoint failure and define a
  policy: block mutation by default or require an explicit proceed-without-undo choice.
  At minimum do not mark the turn snapshotted until a valid ref exists.
- **Tests to add:** Throwing/undefined provider, retry in the same turn, surface behavior,
  and a mutation proving no false history entry or success claim.

### MU-CR-030 — P1 — Open — Sanitized workspace keys can collide and share shadow history

- **Affected:** `packages/profiles/coding/src/checkpoint.ts:62-67`
- **Requirement:** Shadow state must be isolated per workspace and never restore unrelated
  user data.
- **Defect:** The default directory key replaces every non-alphanumeric run with `-`.
  Distinct roots such as `/tmp/a-b/c` and `/tmp/a/b-c` map to the same key. Both providers
  then use one Git directory with different work trees.
- **Failure scenario / impact:** Snapshots from one project become ancestors of another;
  diff/restore can introduce paths/content from the wrong workspace or erase files based
  on foreign history. This is a cross-project confidentiality and integrity issue.
- **Recommended correction:** Key by a collision-resistant hash of the canonical absolute
  root, optionally prefixed with a readable basename. Store and validate the canonical
  root in shadow metadata before every operation.
- **Tests to add:** Known sanitization collisions and symlink/case-normalization variants;
  assert separate repositories and refusal when metadata/root disagree.

### MU-CR-031 — P2 — Open — SDK hard-codes coding tool names as the mutation contract

- **Affected:** `packages/sdk/src/agent.ts:45-48`,
  `packages/sdk/src/agent.ts:283-291`
- **Requirement:** Profiles bundle domain behavior; SDK/custom profiles must support
  arbitrary tools without coding assumptions.
- **Defect:** The bare Agent defaults mutation detection to `write`, `edit`, and `bash`.
  A custom profile's mutating tool (database/API/computer-use) is not checkpointed, while
  a read-only command named `bash` is. The coding profile currently does not explicitly
  supply this policy.
- **Failure scenario / impact:** Non-coding users configure a CheckpointProvider and
  believe undo covers their state-changing tools, but no snapshot is taken.
- **Recommended correction:** Put mutation/checkpoint metadata on the Tool contract or in
  the profile bundle (prefer a predicate over parsed args where needed). The SDK should
  have no name-based domain default.
- **Tests to add:** Custom mutating tool with a non-coding name, argument-dependent
  mutation, and a coding profile asserting its own policy.

---

## Questions, risks, and incomplete work

- The inline renderer currently clears and redraws the entire managed region rather than
  performing a line-level differential update. Because the corresponding M6 tracker item
  remains unchecked and this worktree is actively changing, this is tracked as incomplete
  work rather than a defect for now.
- The current ANSI parser only understands a subset of SGR state (for example, exact
  `ESC[0m` reset). Selective resets and OSC hyperlinks need an explicit safe policy before
  streaming markdown is considered complete.
- The initial component test suite was not yet present during this cycle. M6 requires
  golden-line snapshots for every component and a fake-agent integration test.
