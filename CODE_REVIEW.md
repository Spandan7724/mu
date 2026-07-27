# mu code review

## Review summary

- **Reviewed at:** 2026-07-27 08:25 UTC
- **Current milestone:** Tracker still calls M10 “largely complete.” Runtime catalog
  refresh, skills, picker, `@`-mention, interactive-loop controls, terminal sanitization,
  and several M9 follow-up fixes have landed, while every M10 checklist item remains
  unchecked. Checked M6–M9 acceptance criteria and landed M10 claims remain contradicted
  by the open findings below.
- **Reviewed revision:** `4e0f9b4` (`fix catalog merge, recovery scope, mention cursor and
  process tree cleanup`), clean worktree at the validation boundary. A subsequent
  checkpoint-history worktree started during this review and is discussed only as
  in-progress revalidation where relevant.
- **Scope this cycle:** Revalidate the interactive-loop, signal, streaming, approval,
  picker, mention, catalog, skills, terminal-sanitization, paste, process-output, process
  tree, and reactive-recovery changes in `8389f4a` through `4e0f9b4`; rerun focused and
  full repository gates; preserve all earlier records.
- **Open findings:** P0: 0 · P1: 24 · P2: 19 · P3: 1
- **Possibly fixed:** 2 (P1: 2)
- **Verified fixed:** 11 (P1: 9 · P2: 2)
- **Accepted:** 0

### Validation

- M6 commit gate: `bun run ci` **passed** — 342 tests, 836 assertions.
- In-progress M7 focused tests: **passed** — 27 tests, 48 assertions; `tsc -b` passed.
  Focused multi-turn and resume reproductions below expose gaps not covered by them.
- Committed M8 focused validation: checkpoint/profile/session tests **passed** — 41 tests,
  89 assertions. The tests do not exercise the actual coding-profile-to-Agent route, exact
  multi-step state transitions, resume, ignored files, untracked-file diffs, restore
  failure atomicity, `/fork`, or TUI diff-cell integration.
- Committed M9-focused process/profile/SDK/TUI tests **passed** — 90 tests, 216 assertions.
  Focused reproductions nevertheless showed: no PTY (`stdin isatty=false`), lost
  incremental output after tail rollover, split UTF-8 becoming three replacement
  characters, and a child `sleep` surviving `task_kill`.
- M10 commit validation: full `bun test` **passed** — 457 tests, 1,080 assertions; focused
  compaction/loop tests **passed** — 48 tests, 95 assertions; `tsc -b` passed. A local
  compiled binary built outside the repository and returned `mu 0.0.1` plus help text.
  Focused reproductions still showed repeated request-local Layer 1 compaction and a
  second independent context overflow failing without recovery.
- Full `bun run ci` against the current post-commit worktree **passed** — typecheck, lint,
  477 tests with 1,118 assertions, and kernel purity. Biome reported six non-failing
  existing/in-progress unused-code warnings and one style suggestion.
- New picker/mention/skills focused tests **passed** — 46 tests, 94 assertions. A direct
  mid-buffer mention reproduction nevertheless changed `before  after` into
  `before @s aftchosen.ts ` and queried `r` rather than the typed `s`.
- Current catalog plus picker/mention/skills/CLI focused tests **passed** — 64 tests,
  157 assertions; `tsc -b` passed. Live catalog refresh changed the implicit default from
  `anthropic/claude-opus-5` to `anthropic/claude-sonnet-4-6`; a valid Google-only response
  reduced the seven-model catalog to one and removed every Anthropic/OpenAI model.
- A skill progressive-disclosure reproduction discovered a skill, rewrote its body, and
  then invoked the skill tool; it returned the stale pre-discovery `OLD BODY`, confirming
  bodies are eagerly cached rather than loaded on demand.
- Current focused terminal/input/App/Agent/skills/catalog/process/task validation
  **passed** — 164 tests, 380 assertions. This includes sanitizer coverage at transcript,
  list, approval, and diff boundaries; every paste-terminator split; concurrent
  approvals; live text/tool cells; mid-buffer mentions; partial catalog merge; repeated
  tail rollover; and Linux descendant cleanup.
- Additional boundary reproductions found gaps those green tests miss:
  `Editor.render()` preserved an OSC 52 sequence from bracketed paste (MU-CR-002), and a
  partial catalog refresh deleted an explicitly registered official-provider model while
  retaining the bundled baseline (MU-CR-055).
- The focused process/task suite initially failed inside the managed sandbox with
  `EPERM` from Bun stdin flush. The exact task suite **passed** outside that sandbox — 9
  tests, 23 assertions — so that result is environmental rather than a product failure.
- Full `bun run ci` at `4e0f9b4` **failed**: typecheck passed; lint completed with three
  non-failing unused-code warnings; tests were 525 passed / 1 failed with 1,245
  assertions. `CheckpointHistory > undo returns the state before the last action`
  expected `r1` but received `r2`, directly exercising MU-CR-027. Purity did not run
  because the test gate failed.
- The subsequent checkpoint/profile worktree focused run still **failed** the same
  assertion — 38 passed / 1 failed, 91 assertions — so the candidate does not yet satisfy
  its own updated expectation.
- As the checkpoint rewrite continued, a later worktree snapshot was intentionally
  mid-migration and `bun run typecheck` failed with 22 removed/renamed checkpoint API
  errors across Agent and its tests. This is recorded as active implementation state, not
  a separate finding; stable revision `4e0f9b4` remains the review boundary.
- The completed checkpoint repair passes full `bun run ci`: typecheck and lint are clean,
  all 535 tests pass with 1,285 assertions, and kernel purity passes. Focused coverage now
  includes consecutive undo/undo/redo/redo, persisted refs and cursor resume, snapshot,
  restore and session-save failures, profile provider propagation, arbitrary
  argument-dependent mutating tools, and denied mutations.
- Focused read-only revalidation verified fixes for MU-CR-001, MU-CR-005, MU-CR-011, and
  MU-CR-041; MU-CR-014 and MU-CR-043 are only possibly fixed for the verification gaps
  recorded below. MU-CR-002 through MU-CR-004, MU-CR-006 through MU-CR-010,
  MU-CR-012, MU-CR-013, and MU-CR-015 through MU-CR-019 remain direct reproductions,
  code-path defects, or contract/architecture contradictions. MU-CR-020 through
  MU-CR-025 remain confirmed
  against committed M7 revision `433a5b2`. MU-CR-026 through MU-CR-037 are confirmed
  against committed M8 revision `c109c65`; the narrow ordinary-untracked-file portion of
  MU-CR-026 changed, but ignored paths still reproduce the underlying restore failure.
  MU-CR-038 through MU-CR-045 are confirmed against committed M9 revision `82d595d`.
  MU-CR-046 through MU-CR-051 are confirmed against committed M10 revision `72db569`.
  MU-CR-052 and MU-CR-054 remain confirmed at `4e0f9b4`; MU-CR-053 is verified fixed.
  MU-CR-055 remains open because the bundled baseline survives but registered
  official-provider entries do not; MU-CR-056 remains confirmed against the mapped
  `models.dev` schema. MU-CR-057 remains open because invocation-time rereading fixes
  staleness but not eager discovery-time body loading.

### Highest-priority unresolved issues

1. MU-CR-003 / MU-CR-004 — common emoji widths and editor cursor boundaries are wrong.
2. MU-CR-015 — markdown-command input can still start overlapping, untracked runs.
3. MU-CR-020 — compaction is only a one-request transform and repeats every tool turn.
4. MU-CR-021 — persisted compaction drops the intended tail and carryover on resume.
5. MU-CR-022 — empty or length-truncated summaries can silently discard history.
6. MU-CR-026 — shadow restore does not capture or restore ignored workspace files.
7. MU-CR-030 — colliding workspace keys can share shadow history.
8. MU-CR-033 — aggregate `/diff` omits newly created files.
9. MU-CR-035 — the claimed `/fork` command does not exist.
10. MU-CR-038 — background processes are pipe-backed, not the required PTY sessions.
11. MU-CR-039 — task exit is not connected to the live Agent and cannot wake a genuinely
    idle/completed run.
12. MU-CR-040 — session shutdown never calls process cleanup.
13. MU-CR-046 — a second overflow episode in one run still cannot recover.
14. MU-CR-047 / MU-CR-048 — RPC custom commands discard their run and all frontmatter
    execution controls are ignored.
15. MU-CR-049 — the documented npm/binary installation paths do not exist.
16. MU-CR-052 — resume can attach incompatible or in-flight runtime state to a transcript.
17. MU-CR-055 / MU-CR-056 — catalog refresh can drop registered models and tier pricing.

`TODO.md` marks M6, M7, and M8 complete. Its M6 claims about streaming, Esc abort, clean
Ctrl+C/SIGTERM exit, bracketed-paste splitting, kitty input, Unicode correctness,
differential rendering, and profile-independent renderer behavior conflict with the M6
findings. Its M7 claims about real accounting, one coherent compaction transition,
tail/carryover fidelity, and resume conflict with MU-CR-020 through MU-CR-025. Its M8
claims about profile-backed snapshots, persisted refs, exact/atomic undo-redo,
dirty-change preservation, aggregate diff, TUI diff rendering, and `/fork` conflict with
MU-CR-026 through MU-CR-037. Its M9 claims about REPL support, honest/incremental
head+tail output, idle wake, session-scoped cleanup, and live task cells conflict with
MU-CR-038 through MU-CR-045. The M10 status says Layers 1+3, custom commands, and binary
distribution landed, but those claims conflict with MU-CR-020 and MU-CR-046 through
MU-CR-051. The still-unchecked picker/mention work is reported only where its implemented
paths make false state claims or corrupt input, not merely because it is unfinished. The
bundled-fallback portion of the catalog merge is fixed, but the active-catalog claim still
conflicts with MU-CR-055 and its current-pricing claim conflicts with MU-CR-056. The
committed skill path now works in the interactive surface, but its
progressive-disclosure claim remains narrower than MU-CR-057.

---

## Confirmed defects

### MU-CR-001 — P1 — Verified Fixed — SIGINT and SIGTERM no longer terminate the process

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
- **Resolution evidence (2026-07-27, `8389f4a`):** `Terminal` now installs a
  signal-specific one-shot handler, restores first, removes the handler, and re-sends the
  original signal. Reviewer child-process reproductions exited 130 for SIGINT and 143 for
  SIGTERM; a fake terminal also recorded bracketed-paste/cursor restoration and raw mode
  returning to false before SIGTERM termination.

### MU-CR-002 — P1 — Open — Untrusted content can inject terminal control sequences

- **Affected:** `packages/tui/src/wrap.ts:11-28`,
  `packages/tui/src/cells.ts:65-80`, `packages/tui/src/components.ts:184-195`,
  `packages/tui/src/components.ts:276-303`
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
  approval previews, diff content, and bracketed-paste composer rendering. Assert no
  forbidden control survives.
- **Revalidation (2026-07-27, `51192bf`):** `sanitizeTerminalText` now removes C0/C1 and
  CSI/OSC/DCS/APC/PM/SOS sequences at transcript cells, selections, approvals, and diffs;
  its 21 tests pass. The live composer boundary is missing: bracketed paste inserts its
  payload into `Editor`, and `Editor.render()` sends each raw line to `wrapText`.
  Inserting `before ESC ]52;c;dGVzdA== BEL after` and rendering the editor produced output
  containing both the OSC introducer and BEL. A malicious clipboard paste can therefore
  still execute terminal controls before submission.

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

### MU-CR-005 — P1 — Verified Fixed — A split bracketed-paste terminator stalls input permanently

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
- **Resolution evidence (2026-07-27, `51192bf`):** Paste mode now retains the longest
  suffix that can prefix `ESC[201~`. Tests splitting the terminator at every boundary and
  into one-byte chunks passed, as did marker-like payload and post-paste input cases.

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

### MU-CR-011 — P1 — Verified Fixed — Concurrent permission asks overwrite each other and can deadlock

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
- **Resolution evidence (2026-07-27, `8389f4a`):** App now queues requests by ID, removes
  only the matching resolution, and advances without allowing a stale ID to close the
  visible ask. Reviewer event-order reproductions and four dedicated queue tests passed;
  interactive shutdown also settles every pending permission as deny.

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

### MU-CR-014 — P1 — Possibly Fixed — Esc never reaches the app in the real interactive loop

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
- **Revalidation (2026-07-27, `8389f4a`):** The production stdin loop now schedules a
  30 ms idle flush, dispatches the returned event, resets on new input, and cancels the
  timer during shutdown. Decoder and App unit tests pass, but there is still no actual
  stdin/PTY integration test proving a lone byte reaches and aborts a live interactive
  run; status is therefore Possibly Fixed rather than Verified Fixed.

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
- **Revalidation (2026-07-26, `72db569`):** Markdown commands add two more unguarded
  entrypoints: TUI commands call `void startRun(prompt)` and RPC commands call
  `void agent.run(prompt)`. Neither checks for an active run, so the same overlapping
  Agent state applies to command prompts as ordinary TUI submissions.
- **Revalidation (2026-07-27, `8389f4a`):** Ordinary composer submissions now retain one
  `activeRun` and call `agent.send(text)` while it exists. Markdown commands still
  register `(prompt) => void startRun(prompt)` directly, bypassing that guard and the
  tracked promise; RPC remains detached as described by MU-CR-047. The finding therefore
  remains open for the implemented command entrypoints.

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
- **Revalidation (2026-07-27, `8389f4a`):** `shutdown()` now aborts and denies all
  permission promises, and `finally` awaits the ordinary tracked `activeRun` before
  restoring the terminal. A markdown command's `void startRun(prompt)` is still untracked,
  so it can outlive shutdown and repaint after restoration. The ordinary path improved,
  but the committed production command path keeps this finding open.

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

- **Affected:** `packages/cli/src/interactive.ts:40-53`,
  `packages/cli/src/interactive.ts:99-114`,
  `packages/cli/src/interactive.ts:178-188`
- **Requirement:** Commands are shared across surfaces; `/model` must switch the active
  model. CLI help advertises `--max-turns`, `--max-cost`, and `--allow-all` without limiting
  them to headless mode.
- **Defect:** The command context's `setModel` is a no-op while the command returns
  “Model set to …”; `getModel` closes over immutable `modelRef`. The new picker overrides
  that core command, but its selection callback likewise only commits `model set to
  <label>` text: it does not change the readonly Agent model/provider or footer.
  Interactive construction also ignores `args.maxTurns`, `args.maxCostUsd`, and
  `args.allowAll`.
- **Failure scenario / impact:** Users are told a model changed when subsequent provider
  calls use the old one. Budget and permission flags accepted by the parser have no effect
  in the default interactive product.
- **Evidence:** Direct code inspection of Agent construction and both command callbacks.
  The new picker tests assert only that `App.openPicker` returns the chosen label to an
  arbitrary callback; no test observes the next provider request or footer.
- **Recommended correction:** Put mutable model selection behind a supported public Agent
  operation (or reconstruct safely between runs), update footer state, and share one
  validated option-resolution path across headless/RPC/TUI for budgets and permission
  presets. Never print success until state changed.
- **Tests to add:** `/model` followed by a provider call and footer assertion; invalid
  model leaves state unchanged; each advertised flag changes interactive Agent behavior.
- **Revalidation (2026-07-27, `8389f4a`):** Picker selection now calls
  `agent.setModel(label)` and `app.setModel(label)`, and Agent switches provider/model for
  the next turn. However the shared command context still exposes immutable
  `getModel: () => modelRef` and `setModel: () => {}`, RPC `/model` can therefore report
  success without changing state, and interactive construction still ignores
  `maxTurns`, `maxCostUsd`, and `allowAll`. Settings changes are also not persisted for
  resume. The finding remains open for these shared-surface and flag claims.

### MU-CR-019 — P1 — Open — The wired TUI still drops streaming thinking and Markdown rendering

- **Affected:** `packages/tui/src/app.ts:85-175`,
  `packages/tui/src/app.ts:182-206`,
  `packages/cli/src/interactive.ts:67-75`
- **Requirement:** M6 AC requires streaming markdown and live/running tool cells with a
  bounded output tail; architecture says stream deltas are coalesced at 30–60 fps.
- **Defect:** Text deltas and partial tool tails now reach the managed region, but
  `message_update` handles only `text_delta`; streamed thinking/reasoning deltas are
  ignored. Both streaming and finalized assistant text still use the plain `agentCell`
  rather than the implemented Markdown component, so the streaming-Markdown acceptance
  criterion remains unmet.
- **Failure scenario / impact:** Ordinary prose and tool progress are now visible, but a
  thinking-only interval still appears frozen and Markdown syntax is printed rather than
  rendered. The surface behavior changes abruptly only when finalized thinking is
  committed at `message_end`.
- **Evidence / reproduction (2026-07-27, `8389f4a`):** Direct App events produced
  `{text:true, thinking:false, tool:true}` for live bottom-region visibility. Source
  inspection confirms `text_delta` is the only update branch and both live/final text go
  through `agentCell`.
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
- **Revalidation / expanded scope (2026-07-26, `72db569`):** Layer 1 was also placed
  inside the same request-local `transformContext`. With nine old bulky tool results and
  a two-call fake run, `compaction_start(layer:1)` fired twice, while the persisted
  SessionTree contained zero messages with `evicted=true`. Tombstones therefore repeat
  on every request and disappear on resume just like Layer 2's compacted state.

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

### MU-CR-026 — P1 — Open — Shadow restore does not capture or restore ignored files

- **Affected:** `packages/profiles/coding/src/checkpoint.ts:115-147`,
  `packages/profiles/coding/src/checkpoint.test.ts:24-207`
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
- **Revalidation / resolution evidence (2026-07-26, `c109c65`):** The committed change
  adds `git clean -fd`, and the strengthened ordinary-untracked-file test now passes.
  That fixes the exact `added-later.txt` example, but not the underlying fidelity issue:
  `git add -A` excludes ignored paths and `git clean` deliberately excludes them. In a
  temporary worktree with `*.secret` ignored, a pre-existing `user.secret` overwritten
  after the snapshot remained overwritten after restore, and a newly created
  `created.secret` remained present. `diff(ref)` then returned `[]`. The finding remains
  Open because both edits are realistic results of `write`, `edit`, or `bash`.

### MU-CR-027 — P1 — Verified Fixed — CheckpointHistory skips states and cannot redo an action

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
- **Revalidation (2026-07-27, `4e0f9b4`):** Full CI now contains the direct two-entry
  assertion and fails it: undo expected `restoreTo.ref === "r1"` but received `"r2"`.
  The post-CI worktree changes `popForUndo()` to its own pre-action ref and snapshots a
  redo target, but the focused worktree run still fails that unchanged assertion (38
  passed / 1 failed). The test and candidate semantics currently disagree, and the
  transition model has not passed the gate.
- **Resolution evidence (2026-07-27):** Reversible steps now persist explicit before and
  after refs and the history exposes non-mutating peek plus explicit commit transitions.
  A test drives three distinct states through undo/undo/redo/redo and asserts every
  intermediate state. Full CI passes.

### MU-CR-028 — P1 — Verified Fixed — Checkpoint refs are not persisted and undo rewinds to an invalid node

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
- **Revalidation (2026-07-27, post-`4e0f9b4` worktree):** The candidate undo change still
  stores no `checkpointRef`, rebuilds no history on resume, and forks to the recorded
  post-assistant `entryId`. Its redo path currently restores a workspace ref without
  moving the conversation at all. This record remains open independently of the
  off-by-one workspace correction.
- **Resolution evidence (2026-07-27):** Each completed mutating turn appends a checkpoint
  session entry carrying both refs and the pre-step conversation parent. Undo and redo
  append a persisted cursor entry, and `Agent.resume()` reconstructs both done and undone
  history. Focused tests inspect the serialized entry and resume a fresh Agent before
  redoing the undone step.

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

### MU-CR-031 — P2 — Verified Fixed — SDK hard-codes coding tool names as the mutation contract

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
- **Resolution evidence (2026-07-27):** `Tool.changesState` now owns the policy as a
  boolean or argument predicate. Coding marks `write`, `edit`, and `bash`; the SDK has no
  tool-name list. A non-coding `set_remote_state` test proves dry-run and mutating
  arguments produce zero and one checkpoint respectively.

### MU-CR-032 — P1 — Verified Fixed — Profile checkpointing is dropped before the real Agent is created

- **Affected:** `packages/sdk/src/profile.ts:8-24`,
  `packages/cli/src/interactive.ts:22-39`,
  `packages/profiles/coding/src/index.ts:58-62`
- **Requirement:** M8 requires the coding profile's shadow provider to back live
  snapshotting and `/undo`, `/redo`, and `/diff`.
- **Defect:** `codingProfile()` returns `checkpointProvider`, but `optionsFromProfile()`
  copies prompt, tools, permissions, context messages, and carryover only. It never copies
  `profile.checkpointProvider`. The interactive CLI then creates its Agent from those
  converted options. The committed checkpoint implementation is therefore unreachable
  in the normal coding-profile CLI path.
- **Failure scenario / impact:** A user starts normal interactive mu, performs edits, and
  invokes `/undo`. No snapshot was ever taken and the command reports “This profile does
  not support undo.” `/redo` and `/diff` are likewise unavailable/empty despite M8 being
  marked complete.
- **Evidence / reproduction (2026-07-26, `c109c65`):** For
  `p = await codingProfile({root})` and
  `o = await optionsFromProfile(p, "fake/fake-1")`,
  `{profileHasCheckpoint: !!p.checkpointProvider, optionsHasCheckpoint:
  !!o.checkpointProvider}` evaluated to `{true, false}`.
- **Recommended correction:** Propagate the provider through `optionsFromProfile`, with an
  explicit override rule consistent with all other profile options. Propagate the
  profile-owned mutation policy as part of the same contract rather than relying on SDK
  coding-name defaults.
- **Tests to add:** Construct the Agent through the exact coding profile → options →
  interactive wiring path, execute a real mutating tool in a temporary root, and verify
  `/undo`, `/redo`, and `/diff` use that provider.
- **Revalidation (2026-07-27, post-`4e0f9b4` worktree):** A candidate change now copies
  `profile.checkpointProvider` into Agent options. It is not yet committed or covered by
  the requested exact production-route test, and the concurrent undo state-machine work
  fails full CI, so this record remains Open pending a stable revalidation.
- **Resolution evidence (2026-07-27):** `optionsFromProfile()` propagates the profile
  provider and honors an explicit per-run override. Both paths have direct tests and the
  complete checkpoint suite plus full CI pass.

### MU-CR-033 — P1 — Open — Aggregate session diff omits newly created files

- **Affected:** `packages/profiles/coding/src/checkpoint.ts:149-167`,
  `packages/sdk/src/agent.ts:216-222`
- **Requirement:** M8 AC says `/diff` shows the aggregate session diff from the first
  checkpoint to the current workspace.
- **Defect:** `git diff --numstat <ref>` does not include untracked files. Files created by
  the first mutating action remain untracked in the shadow repository until some later
  snapshot stages them, and ignored files are never staged. The aggregate diff can
  therefore report no changes immediately after a successful file-creation action.
- **Failure scenario / impact:** The agent creates `src/new.ts` and the user immediately
  invokes `/diff`. The command says “No changes yet,” concealing the session's primary
  change. Ignored created files remain invisible indefinitely.
- **Evidence / reproduction (2026-07-26, `c109c65`):** In a temporary root, snapshot
  `base.txt`, create `new.ts`, then call `diff(ref)`. The returned array was `[]`.
- **Recommended correction:** Compute the worktree comparison including untracked files
  without mutating the persistent shadow index, and include ignored paths that the
  checkpoint ownership model determines were changed by the session. Use NUL-delimited
  path handling and produce patches/counts for additions.
- **Tests to add:** Invoke diff immediately after creating ordinary, nested, binary,
  ignored, and oddly named files; mix additions with tracked modifications and deletions.

### MU-CR-034 — P2 — Open — `/diff` bypasses the required TUI diff cell

- **Affected:** `packages/cli/src/interactive.ts:43-56`,
  `packages/cli/src/interactive.ts:95-107`,
  `packages/sdk/src/commands.ts:73-81`
- **Requirement:** M8 AC explicitly requires `/diff` to show the aggregate session diff
  “in the TUI diff cell.”
- **Defect:** The CLI maps each `CheckpointDiffFile` to path/add/remove counts, discarding
  `hunks`. The command joins those counts into plain text, and `runCommand` commits it as a
  raw prefixed line. It never calls the existing `diffCell` renderer.
- **Failure scenario / impact:** Even for tracked edits that the provider detects, `/diff`
  shows only `path · +N −N`; users cannot inspect the actual patch, and the documented
  diff styling/color fallback is absent.
- **Evidence:** Direct committed-path inspection; there is no `diffCell` or `hunks`
  reference in `packages/cli/src/interactive.ts`.
- **Recommended correction:** Preserve the structured per-file patch through the command
  hook and route it to `diffCell` using the active width/color context. Keep a structured
  result for non-TUI surfaces instead of reducing it prematurely to prose.
- **Tests to add:** Interactive command integration asserting actual hunk lines, diff-cell
  rule prefix and color-depth fallback; multiple files and empty diff.

### MU-CR-035 — P1 — Open — The claimed `/fork` command does not exist

- **Affected:** `packages/sdk/src/commands.ts:12-100`,
  `packages/sdk/src/agent.ts:224-226`,
  `packages/cli/src/interactive.ts:43-80`
- **Requirement:** M8 is titled `/undo` `/redo` `/fork` `/diff`; its AC requires `/fork`
  to branch the session tree from a chosen point. `TODO.md` marks that item and AC
  complete at `c109c65`.
- **Defect:** Agent exposes a low-level `fork(entryId)` method, but the core command
  registry contains no command named `fork`, no hook for one, and the interactive command
  list cannot invoke it. No surface presents selectable branch points or accepts an entry
  ID.
- **Failure scenario / impact:** Typing `/fork` yields the registry's unknown-command
  result. The only implemented API requires an internal entry ID that ordinary CLI users
  are never shown, so the claimed user feature is absent.
- **Evidence:** Repository search at `c109c65` finds no `name: "fork"` in any command.
- **Recommended correction:** Define the command and a surface-appropriate branch-point
  selection/argument contract, validate that the target belongs to the current session,
  call Agent.fork, and persist the resulting active branch when it next changes.
- **Tests to add:** Invoke `/fork` through the interactive/core registry at multiple valid
  points; reject unknown/foreign IDs; verify old branches remain and the next message
  descends from the selected node.

### MU-CR-036 — P1 — Verified Fixed — Restore failure consumes undo history and violates atomic pairing

- **Affected:** `packages/sdk/src/agent.ts:194-213`,
  `packages/core/src/checkpoint.ts:50-63`
- **Requirement:** M8 AC claims workspace and conversation are rewound atomically and redo
  reverses undo.
- **Defect:** `undo()` pops/moves the history entry before awaiting workspace restore.
  When restore throws, the conversation remains on its old head but history says the step
  was undone (`canUndo=false`, `canRedo=true` for a one-step run). `redo()` mutates its
  history before restore in the same way. There is no rollback or transaction protocol.
- **Failure scenario / impact:** A file permission error, missing shadow object, or disk
  fault makes `/undo` throw. Retrying says nothing is available, while `/redo` is offered
  for a step that was never undone. Workspace, conversation, and history now disagree.
- **Evidence / reproduction (2026-07-26, `c109c65`):** With a one-entry history and a
  provider whose `restore()` throws `restore failed`, `agent.undo()` threw and left
  `{canUndo:false, canRedo:true}` while the active path remained unchanged.
- **Recommended correction:** Peek and validate a transition without mutating history,
  restore the workspace, fork the conversation, persist it, and only then commit the
  history cursor. If a later phase fails, restore/roll back the earlier phase or report a
  recoverable partial state without lying about the cursor.
- **Tests to add:** Throwing restore on undo and redo, invalid conversation target,
  session-store save failure, retry after each failure, and assertions across all three
  states (workspace, tree head, history cursor).
- **Revalidation (2026-07-27, post-`4e0f9b4` worktree):** The candidate catches
  `restore()` errors and moves the stack back, but it pops the undo step before taking the
  new redo snapshot; a throwing snapshot still consumes the step. An undefined snapshot
  leaves redo targeting the pre-action ref, and conversation fork/save failures remain
  non-atomic. The finding therefore remains open.
- **Resolution evidence (2026-07-27):** Undo and redo now validate and peek first, capture
  a rollback ref, restore state, save a candidate conversation tree, and only then commit
  the history cursor. Snapshot, restore, and session-save failure tests assert unchanged
  state, tree head, and history, followed by a successful retry.

### MU-CR-037 — P2 — Verified Fixed — Denied mutating calls create false checkpoint steps

- **Affected:** `packages/sdk/src/agent.ts:370-418`
- **Requirement:** M8 snapshots mutating tool batches so actual state changes are
  reversible; permission denial must not be represented as a successful mutation.
- **Defect:** `snapshotIfMutating()` runs immediately after rule evaluation, before a
  static deny is returned and before an `ask` result is known. A denied call therefore
  records a checkpoint and consumes the batch's one-snapshot flag even though its tool
  never executes.
- **Failure scenario / impact:** The user denies a requested `bash` or `write`, then invokes
  `/undo`. Mu reports that it undid the step and rewinds conversation even though no
  workspace action occurred. In mixed batches, the false checkpoint can also stand in for
  later allowed mutations without accurately labeling what happened.
- **Evidence:** Direct committed control-flow inspection: the snapshot call is at line 393,
  static deny returns at 395-398, and ask resolution occurs at 399-417.
- **Recommended correction:** Resolve permission first, then take one snapshot immediately
  before the first call that will actually execute. For parallel batches, coordinate this
  in the loop as a batch-level pre-execution operation rather than racing per-call hooks.
- **Tests to add:** Static deny and denied ask produce no checkpoint/history; mixed
  denied/allowed batches produce exactly one correctly labeled checkpoint before the
  allowed mutation; all-denied batches leave undo unavailable.
- **Resolution evidence (2026-07-27):** Snapshotting now runs only after an allow decision
  (including resolved asks). A static-deny regression test proves the state and history
  remain untouched.

### MU-CR-038 — P1 — Open — Background sessions are pipes, not PTYs

- **Affected:** `packages/profiles/coding/src/tools/tasks.ts:11-39`,
  `packages/profiles/coding/src/tasks.test.ts:83-99`
- **Requirement:** `docs/ARCHITECTURE.md` §10 and M9 explicitly require PTY-backed
  sessions so dev servers, prompts, and REPLs behave interactively.
- **Defect:** `shellSpawner()` uses `Bun.spawn` with separate pipe stdin/stdout/stderr.
  It allocates no pseudo-terminal. The acceptance test uses `cat`, which is a pipe echo
  test, not a TTY-dependent REPL. The tracker acknowledges this gap while still marking
  M9 complete.
- **Failure scenario / impact:** Programs disable color/progress UI, change buffering,
  decline interactive mode, or fail with “not a tty.” Full-screen/line-editing REPLs and
  prompts cannot be driven as the milestone requires.
- **Evidence / reproduction (2026-07-26, `82d595d`):** Starting
  `if [ -t 0 ]; then echo tty; else echo notty; fi` through `shellSpawner` produced
  `notty`.
- **Recommended correction:** Add an injected PTY backend with terminal size, merged
  ordered output, stdin, resize, exit, and process-group semantics. Keep pipes only as an
  explicitly selected noninteractive mode.
- **Tests to add:** Assert `isatty(0/1)` inside the child; drive a real TTY-sensitive REPL
  and interactive prompt; resize; ANSI output; EOF and signal behavior.

### MU-CR-039 — P1 — Open — Task exit cannot wake a genuinely idle Agent

- **Affected:** `packages/profiles/coding/src/index.ts:29-74`,
  `packages/sdk/src/profile.ts:8-24`,
  `packages/sdk/src/agent.ts:175-184`, `packages/sdk/src/agent.ts:372-379`,
  `packages/cli/src/interactive.ts:26-39`,
  `packages/sdk/src/checkpoint.test.ts:299-324`
- **Requirement:** M9 AC requires a process exit to wake an idle agent via the follow-up
  queue and surface task events.
- **Defect:** The coding profile owns `ProcessManager`, but `optionsFromProfile` and the
  CLI retain neither the manager nor event hooks, so no production path calls
  `agent.emitTaskEvent()` or `agent.followUp()` on exit. Even if a caller manually does so,
  Agent only polls those arrays before `runLoop` returns. Once an ordinary run is actually
  idle/completed, queuing data starts no new loop and emits no event. The fixture injects
  the follow-up from a `message_end` handler while the original loop is still running,
  so it does not test idle wake.
- **Failure scenario / impact:** The agent starts a build/server and answers that it will
  wait. The build exits after that response. Mu remains idle forever and the TUI never
  receives `task_exited`; the user must poll manually.
- **Evidence / reproduction (2026-07-26, `82d595d`):** No production call site for
  `emitTaskEvent` exists. The only call is the test's synchronous event-stream pump;
  ProcessManager's real-process test merely appends a string to a local array. In a
  focused run, after `stream.result()` resolved, calling both `emitTaskEvent(task_exited)`
  and `followUp("task finished")` left provider call count at 1 and emitted no task event.
- **Recommended correction:** Define a session-owned event/wake channel that survives
  between turns, wire ProcessManager when the profile/session is constructed, and have
  Agent/surface start a continuation when an exit arrives after loop completion. Avoid
  binding core to a single active stream closure.
- **Tests to add:** Let `stream.result()` fully resolve first, then resolve a fake process;
  assert a new continuation/model call and visible task event without user input. Repeat
  for the exact coding-profile/interactive path and for exits during an active turn.

### MU-CR-040 — P1 — Open — Session exit does not clean up owned processes or offer detach

- **Affected:** `packages/core/src/process.ts:182-191`,
  `packages/profiles/coding/src/index.ts:29-74`,
  `packages/cli/src/interactive.ts:127-140`,
  `packages/cli/src/headless.ts:72-104`
- **Requirement:** M9 AC requires session-scoped lifecycle: kill owned processes by
  default and provide an explicit escape hatch.
- **Defect:** `ProcessManager.killAll()` exists, but no CLI/SDK session shutdown path calls
  it. The profile manager is discarded during option conversion, leaving surfaces unable
  to clean it up. There is also no detach flag/API; `task_kill` is termination, not an
  escape hatch allowing a process to survive session exit. The acceptance test manually
  invokes `killAll()` and labels that “what a surface calls,” without testing a surface.
- **Failure scenario / impact:** Start a dev server in interactive or headless mu and exit
  with Ctrl+C, EOF, normal completion, or an exception. The process continues consuming
  ports/resources after its owning session is gone, with no task registry left to manage
  it.
- **Evidence:** Repository search at `82d595d` finds `killAll()` calls only in tests; the
  CLI `finally` restores terminal state but performs no process cleanup.
- **Recommended correction:** Make ProcessManager/session resources part of a disposable
  profile/session lifecycle, invoke cleanup in every exit/error/abort path, await
  termination with escalation, and add an explicit audited detach option.
- **Tests to add:** Spawn a long-lived child through the real CLI lifecycle and verify it
  dies on normal exit, SIGINT, error, and abort; verify an explicitly detached task alone
  survives.

### MU-CR-041 — P1 — Verified Fixed — Incremental polling loses output after tail rollover

- **Affected:** `packages/core/src/process.ts:28-76`,
  `packages/core/src/process.test.ts:54-66`
- **Requirement:** M9 requires bounded head+tail buffering and incremental
  `task_output`; the gap must be reported honestly.
- **Defect:** `readSince` uses an offset into the rendered `read()` string. Once the tail
  reaches its limit, subsequent appends replace old tail bytes rather than lengthening
  the rendered string. A prior offset is then at or beyond the new string length, so the
  method returns empty text even though fresh output arrived.
- **Failure scenario / impact:** After a chatty server fills 16 KB, every normal
  incremental `task_output` poll can report “no new output,” hiding fresh test failures,
  logs, or readiness signals.
- **Evidence / reproduction (2026-07-26, `82d595d`):** With
  `OutputBuffer(2,2)`, append `abcdef`, read since zero (offset 29), append `gh`, then read
  since 29. The second result was empty while full output ended in `gh`. The existing
  incremental test never crosses a truncation boundary.
- **Recommended correction:** Track monotonic source byte positions and retained tail
  spans separately from the presentation string. If a reader falls behind discarded
  data, return a gap marker plus all retained new tail data and advance its cursor.
- **Tests to add:** Repeated incremental reads across multiple tail rollovers, omission
  digit-width changes, readers that fall behind, and exact once-only delivery of retained
  chunks.
- **Resolution evidence (2026-07-27, `4e0f9b4`):** `OutputBuffer` now tracks a monotonic
  source position and retained-tail start independently from the rendered omission
  marker. Three rollover/gap tests and the focused process suite passed, including
  repeated rollover and a manager reader that receives the latest line. Non-ASCII byte
  correctness remains separately open as MU-CR-042.

### MU-CR-042 — P2 — Open — Output buffering corrupts split Unicode and misreports bytes

- **Affected:** `packages/profiles/coding/src/tools/tasks.ts:21-27`,
  `packages/core/src/process.ts:25-67`
- **Requirement:** M9's buffer limits and omission notices are specified in bytes; task
  output must remain valid text.
- **Defect:** Each pipe chunk is decoded with a fresh non-streaming `TextDecoder`, so a
  UTF-8 character split across reads becomes replacement characters. OutputBuffer then
  measures/slices JavaScript UTF-16 code units while naming them bytes, and can retain an
  unpaired surrogate at a head/tail boundary. `outputBytes` and omitted-byte counts are
  therefore false for non-ASCII output.
- **Failure scenario / impact:** A background compiler/test emits emoji, CJK, or any
  multibyte text at a chunk boundary. Mu corrupts its logs; truncation can leave invalid
  Unicode and misleading counts.
- **Evidence / reproduction (2026-07-26, `82d595d`):** A child wrote the first two and
  final two bytes of `😀` in separate writes; captured output was `���`. With
  `OutputBuffer(1,1)`, appending `😀` then `a` retained a lone high surrogate and reported
  3 “bytes” for five actual UTF-8 bytes.
- **Recommended correction:** Keep a persistent decoder per stream with
  `{stream:true}` and flush it at EOF. Buffer raw bytes (or track byte counts and segment
  decoded graphemes safely) so limits, gaps, and cursors use one real unit.
- **Tests to add:** Split every boundary of 2/3/4-byte UTF-8 sequences, invalid byte input,
  head/tail cuts around astral characters, and byte-accurate counts.

### MU-CR-043 — P1 — Possibly Fixed — Killing a task leaves descendant processes alive

- **Affected:** `packages/profiles/coding/src/tools/tasks.ts:12-38`,
  `packages/core/src/process.ts:169-190`
- **Requirement:** `task_kill` and session cleanup must stop the managed background task,
  including dev-server/build process trees.
- **Defect:** The spawner launches `bash -c` without an isolated process group and
  `kill()` signals only the Bash process handle. Child/grandchild processes survive. The
  manager immediately labels the task killed without verifying tree termination.
- **Failure scenario / impact:** `bash` starts a server, watcher, or pipeline. `/task_kill`
  reports success and session exit appears clean, but descendants retain ports, files,
  CPU, and credentials.
- **Evidence / reproduction (2026-07-26, `82d595d`):** Start
  `sleep 30 & child=$!; echo $child; wait`, capture the child PID, and call
  `ProcessManager.kill`. The task status became `killed` while `kill(pid, 0)` confirmed
  the child was still alive. The reproduction explicitly terminated that child afterward.
- **Recommended correction:** Spawn each task in an isolated process group/session and
  signal the group, with graceful timeout/escalation and platform-specific handling.
  Mark killed only after observed termination.
- **Tests to add:** Shell child, grandchild, pipeline, and server subprocess; assert all
  PIDs are gone after `task_kill` and session cleanup.
- **Revalidation (2026-07-27, `4e0f9b4`):** Linux tasks now launch under
  `setsid`, and `kill()` signals the negative process-group ID. Reviewer validation
  passed two real grandchild tests for both single-task and `killAll` paths. Verification
  is incomplete across the promised macOS/Linux distribution: macOS does not provide the
  external `setsid` utility by default, and the implementation has no graceful-timeout
  escalation or cross-platform backend. Status is therefore Possibly Fixed.

### MU-CR-044 — P2 — Open — TUI has no live task cells

- **Affected:** `packages/tui/src/app.ts:159-174`,
  `packages/tui/src/app.test.ts:175-181`
- **Requirement:** M9 AC requires task cells showing live tail then collapsed summary, in
  addition to the footer background count.
- **Defect:** App only increments/decrements a footer number on task start/exit.
  `task_output` is ignored by the default switch, and start/exit return no transcript
  lines. The tracker changes the requirement to “generic cell for now” while marking the
  docs AC complete, but generic tool cells do not consume asynchronous task events.
- **Failure scenario / impact:** Even if event wiring is fixed, a running build's output
  is invisible unless the model explicitly polls it; users see only `1 bg`, with no live
  tail or completion summary.
- **Evidence:** The only M9 TUI test asserts footer text. No test sends `task_output` or
  checks a task transcript cell.
- **Recommended correction:** Add session/task-keyed cell state driven by started/output/
  exited events, bound its live tail, and replace it with a collapsed completion summary
  on exit.
- **Tests to add:** Interleaved tasks, streaming output, truncation/gap, success/failure/
  killed summaries, and footer/cell consistency.

### MU-CR-045 — P2 — Open — Read-only task inspection unnecessarily requires approval

- **Affected:** `packages/profiles/coding/src/permissions.ts:8-17`,
  `packages/profiles/coding/src/tools/tasks.ts:42-72`,
  `packages/profiles/coding/src/tools/tasks.ts:97-111`
- **Requirement:** The coding permission policy allows read/search operations and asks for
  writes/exec; background task inspection should preserve that distinction.
- **Defect:** The profile adds `task_output` and `task_list` but adds no allow rules for
  them. The wildcard ask rule therefore prompts on every output poll/list even though
  both tools are marked concurrency-safe and only read session-owned state.
- **Failure scenario / impact:** Monitoring a build requires repeated manual approvals,
  undermining incremental polling and making unattended follow-up behavior fail by
  default.
- **Evidence:** Permission evaluation uses last-match wins; neither new read-only tool has
  a matching allow rule after the initial wildcard ask.
- **Recommended correction:** Explicitly allow session-local `task_output` and
  `task_list`. Keep stdin, kill, and command start behind ask rules.
- **Tests to add:** Permission evaluation for all four task tools plus background Bash,
  including project overrides and unattended mode.

### MU-CR-046 — P1 — Open — Reactive recovery is one-shot for the entire Agent lifetime

- **Affected:** `packages/sdk/src/agent.ts:138-141`,
  `packages/sdk/src/agent.ts:518-528`
- **Requirement:** M10 Layer 3 requires any provider context-too-long failure to compact
  and retry once, without creating an infinite retry loop.
- **Defect:** `recoveryAttempted` is an Agent field set after the first recovery and never
  reset at the beginning/end of `execute`. “Retry once” is therefore implemented once per
  Agent lifetime rather than once per overflow/run. All later context-too-long errors
  bypass recovery.
- **Failure scenario / impact:** A long-lived SDK/TUI session recovers from one oversized
  request. Hours later, after more context accumulates, another overflow immediately ends
  the run even though compaction could recover it.
- **Evidence / reproduction (2026-07-26, `72db569`):** A FakeProvider sequence let the
  first `agent.run()` overflow, summarize, and complete (`reason=done`). A second
  `agent.run()` on the same Agent returned `reason=error` after its first too-long result;
  total call count was 4, proving no second compaction/retry.
- **Recommended correction:** Scope the guard to the current recovery episode/request.
  Reset it after a successful provider call and at run boundaries while ensuring the same
  unchanged failure is retried at most once.
- **Tests to add:** Two separate recoverable overflows in one Agent lifetime, two
  overflows separated by successful tool turns, and a persistent failure capped at one
  retry per episode.
- **Revalidation (2026-07-27, `4e0f9b4`):** `execute()` now resets
  `recoveryAttempted`, so two separate `agent.run()` calls can each recover. The guard is
  still never reset after a successful provider/tool turn inside one execution; a second
  independent overflow later in that same multi-turn run bypasses recovery. This fixes
  the cross-run case but not the required per-episode scope, so the finding remains open.

### MU-CR-047 — P1 — Open — RPC markdown commands launch an invisible detached run

- **Affected:** `packages/cli/src/main.ts:32-81`,
  `packages/sdk/src/markdown-commands.ts:125-139`
- **Requirement:** M10 AC requires a project markdown command with arguments to work in
  RPC as well as TUI; RPC's contract is serialized Agent events plus command results.
- **Defect:** RPC registers markdown commands with
  `(prompt) => void agent.run(prompt)`. `Agent.run()` consumes its events internally; the
  returned promise is neither awaited nor observed, and its result/errors are not sent to
  RPC. The command handler immediately returns an empty `command_result`.
- **Failure scenario / impact:** An embedder sends a `/review src/a.ts` command and
  receives no assistant events or answer. Provider/auth errors become unhandled detached
  rejections, and a concurrent RPC input can overlap the hidden run.
- **Evidence:** Direct committed path inspection: only `runRpc` input operations pump an
  Agent stream to `RpcOut`; the command callback has no access to `send` and discards the
  run promise.
- **Recommended correction:** Have command expansion return a structured prompt/directive
  to `runRpc`, then execute it through the same single-flight event-pumping path as an
  input op. Await completion and report errors deterministically.
- **Tests to add:** Real registry + RPC markdown command asserting expanded prompt,
  streamed events, final result/error, shutdown waiting, and no overlap with active input.

### MU-CR-048 — P1 — Open — Markdown command model and allowed-tools frontmatter are ignored

- **Affected:** `packages/sdk/src/markdown-commands.ts:64-82`,
  `packages/sdk/src/markdown-commands.ts:125-139`,
  `packages/cli/src/interactive.ts:87-90`,
  `packages/cli/src/main.ts:56-58`
- **Requirement:** `docs/PROJECT.md` defines YAML frontmatter fields `model`,
  `allowed-tools`, and `description`; M10 requires frontmatter to work in TUI and RPC.
- **Defect:** `toCommand` correctly passes `{model, allowedTools}` to its submit callback,
  but both production callbacks accept only `prompt` and discard the options. Agent has no
  per-command tool filter or model override applied here. Tests stop at asserting the
  standalone callback receives `model`; no surface test checks behavior.
- **Failure scenario / impact:** A `/review` command intended to run a cheaper model with
  read-only tools instead uses the session model and full write/exec toolset. This defeats
  both cost intent and the command's safety boundary.
- **Evidence:** Direct code inspection of both submit callbacks; neither reads its second
  argument.
- **Recommended correction:** Carry a structured command execution request through the
  surface, validate/switch the model for that run, restrict exposed tools to the declared
  names, and restore session defaults afterward. Unknown tools/models must fail closed.
- **Tests to add:** TUI and RPC end-to-end commands verifying the provider model and exact
  tool definitions, unknown names, empty allowed list, and restoration after completion.

### MU-CR-049 — P1 — Open — Documented npm and release-binary installation paths are invalid

- **Affected:** `README.md:15-24`, `package.json:1-23`,
  `packages/sdk/package.json:1-13`, `packages/cli/package.json:1-17`
- **Requirement:** M10 AC requires `mu` to install via npm and run as compiled macOS/Linux
  binaries with install documentation.
- **Defect:** README tells users `bun install -g mu`, but package `mu` is the SDK and has
  no `bin`; the actual CLI package is named `@mu/cli`, points its bin at TypeScript source,
  and depends on unpublished `workspace:*` packages. The monorepo root is private. The
  binary download URL literally contains a Unicode ellipsis
  (`https://github.com/…/releases/...`) and cannot resolve. No release artifacts or
  publish metadata are present.
- **Failure scenario / impact:** Every advertised clean installation route fails or
  installs a package without a `mu` executable. Users may accidentally install an
  unrelated public npm package named `mu`.
- **Evidence:** Package-manifest and README inspection at `72db569`. A local compile to a
  temporary directory did produce a working `--version`/`--help` binary, but that does not
  make either documented distribution channel exist.
- **Recommended correction:** Decide the publish topology and ownership, produce
  publishable manifests without `workspace:*`, attach signed/checksummed binaries to a
  real release, replace placeholders with exact URLs, and test installation from packed
  tarballs/releases in clean containers on each target OS.
- **Tests to add:** `npm pack`/`bun pm pack` content inspection, clean global install
  invoking `mu --version`, download/checksum/execute each release artifact, and CI matrix
  for Linux/macOS architectures.

### MU-CR-050 — P2 — Open — Valid CRLF markdown frontmatter is treated as prompt text

- **Affected:** `packages/sdk/src/markdown-commands.ts:19-42`,
  `packages/sdk/src/skills.ts:16-28`
- **Requirement:** Markdown commands and skills are user-authored cross-platform files
  with YAML frontmatter.
- **Defect:** The delimiter regex and line splitting accept only LF. A normal
  Windows/checked-out CRLF file does not match, so metadata is empty and the entire
  `---\r\n...` block is sent to the model as prompt content. UTF-8 BOM files fail
  similarly.
- **Failure scenario / impact:** The same checked-in project command works on one checkout
  and silently loses description/model/tool restrictions on another. Skills using the
  shared parser similarly lose their declared name/description and expose the raw
  frontmatter as tool-loaded instructions.
- **Evidence / reproduction:** `parseFrontmatter("---\\r\\ndescription: x\\r\\n---\\r\\nbody")`
  returns empty metadata and the unstripped source as its body by direct regex analysis.
- **Recommended correction:** Normalize BOM/newline forms before parsing or use a
  constrained YAML/frontmatter parser with explicit schema validation and surfaced
  diagnostics.
- **Tests to add:** CRLF, BOM, missing closing delimiter, quoted colons/hashes, multiline
  values, malformed lists, and visible load errors.

### MU-CR-051 — P2 — Open — Layer 3 reports completion before compaction happens

- **Affected:** `packages/sdk/src/agent.ts:518-528`,
  `packages/sdk/src/agent.ts:433-499`
- **Requirement:** AgentEvent is the truthful shared surface contract; compaction events
  and `tokensFreed` drive TUI/RPC status.
- **Defect:** On a too-long error, `recoverFromError` immediately emits Layer 3
  `compaction_start` and `compaction_end(tokensFreed:0)`, then merely sets
  `compactRequested`. Actual summarization happens on the next transform and emits a
  separate Layer 2 pair. Layer 3 can therefore claim completion even if the later compact
  fails, and its freed-token count is always false.
- **Failure scenario / impact:** TUI/RPC observers see recovery finish successfully before
  any recovery work runs, then see an unrelated Layer 2 operation. Telemetry and user
  status cannot determine whether reactive recovery succeeded.
- **Evidence:** Direct committed control flow; Layer 3 events are emitted synchronously at
  lines 525-526, while `compact()` is only called later at line 468.
- **Recommended correction:** Represent reactive recovery as one operation spanning the
  actual compaction/retry, or link nested Layer 2 work with an operation ID. Emit end only
  after success/failure with measured tokens and outcome.
- **Tests to add:** Exact event ordering and counts for successful recovery, compaction
  failure, persistent too-long retry, and abort during recovery.

### MU-CR-052 — P1 — Open — Resume carries incompatible runtime state and can corrupt the selected transcript

- **Affected:** `packages/cli/src/interactive.ts:151-180`,
  `packages/sdk/src/agent.ts:127-203`
- **Requirement:** M10 includes a `/resume` picker; selecting a saved session must make
  that session the active conversation.
- **Defect:** The picker now loads a tree and `Agent.resume()` swaps `tree` and session
  ID, but it does not reset or reconstruct session-scoped state: usage totals,
  `lastContextPercent`, checkpoint history, recovery/compaction flags, queued
  steering/follow-ups/external events, or model/thinking settings. The async picker
  callback is detached and is allowed while a run is active; the active provider result
  then appends to whichever tree was swapped in.
- **Failure scenario / impact:** Resuming a cheaper/older session can retain cost and
  budget state from the abandoned session. More seriously, choosing resume during a
  delayed run can attach that run's assistant answer to the selected session without its
  user prompt, producing an orphan/misattributed transcript.
- **Evidence / reproduction (2026-07-27, `8389f4a`):** After an old session accumulated
  `$0.0001`, resuming a target tree kept `$0.0001` and the next turn raised it to
  `$0.0002`. In a delayed-run reproduction, resuming a target containing only
  `TARGET HISTORY` before the active result arrived produced
  `[TARGET HISTORY user, ACTIVE ANSWER assistant]`.
- **Recommended correction:** Permit resume only between runs and make it an atomic
  session-state transition. Reconstruct or reset every session-scoped field from
  persisted entries/settings/checkpoints, update footer and command closures, and report
  success only after the complete transition. Prefer constructing a fresh Agent from the
  selected session when state cannot be safely rebuilt in place.
- **Tests to add:** Persist two distinct transcripts, choose one through the real
  interactive command, assert active session ID/history and the next provider context;
  cover current, missing, corrupt, and load-failure selections.

### MU-CR-053 — P1 — Verified Fixed — Mid-buffer file mention completion corrupts unsent input

- **Affected:** `packages/tui/src/app.ts:293-306`,
  `packages/tui/src/app.ts:355-401`,
  `packages/tui/src/components.ts:12-71`
- **Requirement:** The M10 `@` popup is composer completion; selecting a file must replace
  only the active `@query` and preserve text before and after the cursor.
- **Defect:** On `@`, `mentionStart` is set to `editor.text.length - 1`, not the cursor's
  absolute offset. Filtering then slices from that false location. Completion discards
  everything from `mentionStart` through the end and calls `setText`, which moves the
  cursor to the buffer end. It is correct only when the mention is typed at the very end.
- **Failure scenario / impact:** Editing an earlier part of a prompt and choosing a path
  destroys or splices the unsent suffix. Multiline prompts have the same issue whenever
  the cursor is not at the overall end.
- **Evidence / reproduction (2026-07-26 worktree):** Set the editor to `before  after`,
  move the cursor after `before `, type `@s`, then select `chosen.ts`. The mention callback
  received queries `["", "r"]`, and the resulting buffer was
  `before @s aftchosen.ts ` rather than `before chosen.ts  after`.
- **Recommended correction:** Make the editor expose a grapheme-safe absolute selection
  range or replace-range primitive. Record the `@` offset at insertion, derive the query
  only from that offset to the live cursor, replace exactly that range, preserve the
  suffix, and place the cursor after the inserted path.
- **Tests to add:** Mentions at start/end/middle, multiline buffers, suffix preservation,
  cursor position, backspace across the opening `@`, paste during an open popup, and
  Unicode before/in the query.
- **Resolution evidence (2026-07-27, `4e0f9b4`):** Editor now exposes its absolute cursor
  offset and a range-splice operation. The mention anchor is recorded at insertion, the
  query ends at the live cursor, and completion preserves the suffix. The original
  reproduction now yields `before chosen.ts  after`; three focused start/end/middle
  tests passed. Grapheme-safe cursor semantics remain separately open as MU-CR-004.

### MU-CR-054 — P2 — Open — File mention filtering performs an unbounded synchronous tree scan

- **Affected:** `packages/cli/src/interactive.ts:134-165`,
  `packages/tui/src/app.ts:387-401`
- **Requirement:** Composer input must stay responsive; the implementation itself claims
  its listing is bounded so a huge tree cannot stall a keystroke.
- **Defect:** Every opening/filter keystroke synchronously calls `readdirSync` and
  `statSync` recursively on the TUI input loop. The 50-item bound limits matches, not
  visited entries: a sparse or unmatched query traverses every non-hidden entry through
  depth three. Each entry incurs a synchronous stat, and there is no visit/time bound,
  cache, cancellation, or ignore-file support.
- **Failure scenario / impact:** Typing after `@` in a large workspace blocks key
  decoding, painting, streaming output, and abort handling while the filesystem is
  scanned again for every character. Slow/network filesystems amplify the freeze.
- **Evidence:** Direct worktree control-flow inspection. `refreshMentions()` invokes the
  callback inline; `mentionCandidates()` performs the complete synchronous walk before
  returning, and `out.length` remains zero for an unmatched query regardless of tree size.
- **Recommended correction:** Build/cache an asynchronously discovered candidate index
  with an explicit visit/time/result budget, respect project ignore rules, debounce
  queries, and discard stale asynchronous results. Never do recursive filesystem I/O in
  the input handler.
- **Tests to add:** A large tree with zero matches, slow/throwing entries, rapid query
  replacement/cancellation, ignore rules, and an event-loop responsiveness bound.

### MU-CR-055 — P1 — Open — A partial catalog refresh deletes active models

- **Affected:** `packages/ai/src/catalog.ts:84-116`,
  `packages/ai/src/catalog.ts:148-152`,
  `packages/cli/src/main.ts:30-35`
- **Requirement:** The tracker says the bundled catalog remains an offline fallback and
  malformed or failed refreshes never partially replace the active catalog. Model
  discovery must not make an otherwise valid CLI invocation lose its requested model.
- **Defect:** Refresh now preserves the bundled baseline, but it rebuilds official
  providers from `bundledModels` and retains current entries only for non-discovered
  providers. Any explicitly registered Anthropic/OpenAI/Google model that is not in the
  partial remote response is still removed from the active catalog. The original
  wholesale bundled deletion and default-order change are fixed, but the tracker promise
  says a partial response must not partially replace the *active* catalog.
- **Failure scenario / impact:** An embedder registers a newer official-provider model
  that is absent from a staged response. Refresh silently removes it, and a subsequent
  `--model`/SDK lookup fails even though it was active and valid immediately beforehand.
- **Evidence / reproduction (2026-07-26 worktree):** Starting from seven bundled models
  and default `anthropic/claude-opus-5`, refreshing a valid payload containing only
  `google/gemini-only` produced a one-model catalog, removed Opus, and made Gemini the
  default. A live refresh changed the default from Opus 5 to
  `anthropic/claude-sonnet-4-6`.
- **Recommended correction:** Overlay validated remote metadata onto the complete active
  catalog by stable provider/model key; reserve replacement/reset for a separate explicit
  operation. Preserve a deliberate default independent of response ordering. Never
  remove a bundled or explicitly registered model merely because a refresh omitted it.
- **Tests to add:** One-provider and one-model payloads, missing provider/model keys,
  upstream reordering, explicit bundled model after refresh, registered official-provider
  additions, and stable default before/after success/failure.
- **Revalidation (2026-07-27, `4e0f9b4`):** The original Google-only reproduction now
  retains bundled Anthropic/OpenAI entries and keeps bundled order stable. A second
  reproduction registered `anthropic/custom-active`, refreshed the same Google-only
  payload, and observed `{after:false, bundled:true}`. Merge the remote overlay onto the
  complete current catalog (with explicit reset semantics where needed), not only onto
  `bundledModels`. Tiered pricing remains separately open as MU-CR-056.

### MU-CR-056 — P2 — Open — Dynamic catalog pricing discards context-tier rates

- **Affected:** `packages/ai/src/catalog.ts:52-81`,
  `packages/ai/src/types.ts:93-111`,
  `packages/ai/src/cost.ts:3-10`
- **Requirement:** M1 requires usage cost to be computed from catalog pricing, and the
  M10 `/cost` acceptance criterion requires correct live cost including cache pricing.
  The tracker says refresh maps current pricing into `ModelInfo`.
- **Defect:** `models.dev` supplies context-dependent pricing through fields such as
  `cost.tiers` and `cost.context_over_200k`. The mapper drops those fields, `ModelPricing`
  cannot represent them, and `computeCostUsd` always applies one flat base rate. Missing
  input/output prices are also converted to zero rather than making the model's cost
  unknown.
- **Failure scenario / impact:** Long-context runs on affected OpenAI/Google models are
  reported at the lower base rate, while compatible models without complete pricing can
  report `$0`. Budget halts and `/cost` therefore understate spend.
- **Evidence:** The live catalog exposed context-tier pricing on eight compatible OpenAI
  models and six compatible Google models during review; two compatible Google models
  lacked base input/output pricing. The focused mapper test covers only flat pricing.
- **Recommended correction:** Extend the pricing type/calculator to preserve and select
  provider catalog tiers using the applicable request/context measure. Treat absent or
  unsupported pricing as unknown and surface that state instead of zero.
- **Tests to add:** Below/at/above each context threshold, cache read/write rates inside
  tiers, missing prices, cumulative multi-turn totals crossing a tier, and `/cost` plus
  budget behavior for unknown pricing.

### MU-CR-057 — P2 — Open — Skill bodies are eagerly cached instead of loaded on demand

- **Affected:** `packages/sdk/src/skills.ts:14-48`,
  `packages/sdk/src/skills.ts:71-111`
- **Requirement:** The implementation defines skills as progressive disclosure: names
  and descriptions stay in context, while the full `SKILL.md` body is loaded only when
  the model calls the skill tool.
- **Defect:** `discoverSkills` calls `loadSkill` for every directory, and `loadSkill`
  reads and stores the complete body. The tool now re-reads the chosen file at invocation,
  which fixes stale execution, but discovery still performs and retains the eager,
  unbounded body read for every installed skill. The “progressive disclosure” listing
  test checks only that prompt text omits bodies, so it cannot detect startup I/O/memory.
- **Failure scenario / impact:** Starting a surface must read every installed skill body
  even if none is used, and a large skill set can impose unbounded startup I/O/memory.
  Invocation then reads the same file a second time.
- **Evidence / reproduction:** The 2026-07-26 reproduction returned stale `OLD BODY`.
  At `4e0f9b4` it now returns the edited body, but direct control-flow inspection still
  shows every candidate going through full `readFile`/`parseFrontmatter` during
  `discoverSkills` before any skill is selected.
- **Recommended correction:** Discover and retain validated metadata plus a file
  reference, then read/parse the selected body inside tool execution with an explicit
  byte limit and visible error handling. Decide whether metadata is snapshotted or
  refreshed, but make the body behavior match the on-demand contract.
- **Tests to add:** Mutate/delete the file between discovery and tool call, prove
  unselected bodies are never read, enforce maximum size, and cover read/parse errors at
  invocation time.

---

## Questions, risks, and incomplete work

- The inline renderer currently clears and redraws the entire managed region rather than
  performing a line-level differential update. Because the corresponding M6 tracker item
  remains unchecked and this worktree is actively changing, this is tracked as incomplete
  work rather than a defect for now.
- The current ANSI parser only understands a subset of SGR state (for example, exact
  `ESC[0m` reset). Selective resets and OSC hyperlinks need an explicit safe policy before
  streaming markdown is considered complete.
- Component and fake-agent tests now exist, but M6's requested golden-line coverage for
  every component is still incomplete; this remains tracked as unchecked work rather than
  a separate defect.
