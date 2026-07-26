# mu — working conventions

## Start here
- Read `docs/PROJECT.md` (master context) and `TODO.md` (progress tracker) before doing
  anything. Both are gitignored (local-only) but always present on disk.
- Docs map: `docs/ARCHITECTURE.md` (subsystems), `docs/CONTRACTS.md` (types + invariants
  checklist), `docs/MILESTONES.md` (M0–M10 + acceptance criteria), `docs/STYLES.md`
  (TUI visual spec), `docs/DECISIONS.md` (settled decisions — don't relitigate).
- Reference codebases live at `../pi`, `../opencode`, `../codex`, `../claude_code`;
  `docs/PROJECT.md` maps which files to read per subsystem.

## Git
- Commit after each major task/step. **Local only — never push.**
- Commit messages: one concise line. No detailed bodies or bullet lists.
- **Never add Claude as co-author** — no `Co-Authored-By` trailer, ever, on any commit.

## Code style
- No excessive comments. Comment only what the code cannot say (constraints, non-obvious
  invariants). Never narrate what a line does or why a change is correct.
- Strict TypeScript, Bun runtime, Biome for lint/format.
- No new dependencies without adding an entry to `docs/DECISIONS.md`.
- Kernel purity: no cwd/git/file-path/domain concepts in `@mu/core` or `@mu/ai`
  (domain logic belongs in profiles).

## Process
- Work milestone-by-milestone from `TODO.md`; verify against the milestone's acceptance
  criteria in `docs/MILESTONES.md` before marking done.
- Update `TODO.md` (statuses + "Current status" block + working notes) before ending a
  session.
- Review changes against the invariants checklist at the bottom of `docs/CONTRACTS.md`.
