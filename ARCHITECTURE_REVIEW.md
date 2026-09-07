# Mu: recoverable working context

## Conclusion

Mu's largest architectural ceiling for sustained coding work is that **durable evidence
is not addressable by the agent once it leaves the working transcript**. The context
window is effectively its usable memory. The session journal is an audit/export store,
but has no supported model-facing retrieval interface.

This is a judgment about the implementation's long-task ceiling, not a claim that one
change dominates every coding benchmark. A stronger model, better prompts, and faster
tools can improve Mu today. They cannot reconstruct an observation that is absent from
their inputs and unavailable through their tools.

## Evidence and alternatives considered

- `packages/core/src/loop.ts`: `runLoop` already supports repeated reasoning/tool turns,
  steering between batches, follow-ups, request-local context transforms, persistent
  context preparation, budgets, and recovery hooks. A graph executor or explicit planner
  would not by itself fix missing evidence. Its repetition detector only compares call
  arguments (and incorrectly assumes identical results); useful to improve, but narrower.
- `packages/core/src/session.ts`: `activePath()` retains original message entries;
  `messagesAt()` substitutes microcompaction replacements and summary/tail boundaries.
  The distinction is intentional and valuable. `Agent.executeRun` seeds requests from
  `messagesAt()`, not the original journal.
- `packages/core/src/microcompaction.ts`: successful old tool results are replaced with
  a marker instructing the model to rerun the tool. There is no reproducibility contract
  on `Tool`, and even a read is time-dependent. An old file version, one-shot diagnostic,
  or completed investigation is not equivalent to a new tool execution.
- `packages/core/src/compaction.ts`: `serializeCompactionMessages` limits each tool
  result to its first 2,000 characters. Thus information can disappear before the
  summarizer sees it. `SUMMARY_PROMPT` explicitly says omitted information is lost;
  successive compactions update a previous summary rather than revisit original evidence.
- `packages/profiles/coding/src/index.ts`: carryover preserves read/modified filenames
  and todos, not the observations, reasoning evidence, or user corrections behind them.
- `packages/sdk/src/subagents.ts`: the parent receives the child's final text; its
  intermediate messages are saved in `ToolResult.details.messages`, which is explicitly
  renderer/session-only (`packages/core/src/tools.ts`). The same information boundary
  therefore affects delegation before compaction even occurs.
- `packages/sdk/src/commands.ts` and `transcript-markdown.ts`: users can export history,
  and SDK callers can inspect the tree. These are real escape hatches, but the stock
  model-facing tools provide no bounded, branch-aware session retrieval. Reading a CLI
  JSONL file through bash is an incidental workaround: it requires discovering internal
  storage, does not work with the default SDK memory store, and exposes inactive branches.
- `packages/sdk/src/agent.ts` / `file-store.ts`: persistence happens at complete turn
  boundaries, so a crash during effects is not transactionally recoverable. This matters
  for reliability; solving exactly-once arbitrary shell effects requires a different
  execution contract. It does not explain evidence loss in successful uninterrupted runs.
- `packages/core/src/loop.ts` / `sdk/src/subagents.ts`: synchronous child calls create a
  batch barrier; children share tool closures and receive separate remaining-budget
  snapshots. File-state sharing and budget overshoot are concrete concurrency weaknesses.
  They affect particular parallel workloads; the memory ceiling affects serial and
  delegated work as accumulated context grows.
- `packages/core/src/events.ts`: ordinary tools already have permission and observable
  start/update/end paths. Retrieval can reuse those contracts without another event bus.

## Design (completed before implementation)

Keep the existing loop, append-only session tree, and summary/recent-tail compaction.
Make the active context a recoverable working set backed by the original branch journal.

1. Add SDK-owned `history_search` and `history_read` tools. Search returns bounded literal
   matches with stable message references and match-centered excerpts. Read returns a
   bounded character range, provenance, and a continuation offset. Search pagination uses
   stable record references. Neither operation invokes a provider or repeats a source tool.
2. Resolve every reference against the current active branch, including reads. Undo/fork,
   resume, and new-session operations must change the accessible history immediately.
   No global store search, filesystem dependency, embedding service, or session migration.
3. Include original user/assistant text, tool arguments/results, and the recorded visible
   messages of completed managed subagents. Exclude hidden thinking, arbitrary renderer
   details, image payloads, and history-tool traffic. Historical evidence is labelled as
   such; it is not a fresh observation or an instruction to execute old requests.
4. Give evicted text outputs an exact `history_read` reference. Without retrieval enabled,
   preserve the existing fallback. Full compaction can drop these references because the
   searchable original journal remains available independently of the summary.
5. Bind tools to their owning Agent, not a borrowed extension closure. Enable them in the
   public factory and CLI; retain explicit opt-in (`history: true`) for the bare Agent.
   Children get their own tools and history, never the parent's bound readers. The parent
   can inspect a completed child's recorded evidence through that child's result entry.
6. Use existing permissions, argument validation, tool events, usage/context accounting,
   and persistence. Respect per-run tool allowlists and caller-provided tool names.

This changes the model's memory contract, not the fundamental reasoning algorithm.
The current package boundaries are adequate; replacing the kernel would be unnecessary.

## Evaluation plan

Exercise the real Agent loop and compaction path with an adaptive deterministic provider
that can only answer from its actual requests and tool results. Place an unpredictable
diagnostic beyond the summarizer's 2,000-character limit, compact, resume, and ask for the
original value after the observation source has changed. Compare retrieval disabled/enabled,
exact recovery, source reruns, extra model turns, and returned context size. Verify pagination,
branch isolation, child isolation, permissions, cancellation, and persisted provenance.

This measures whether Mu retains access to evidence, not whether an LLM chooses good
queries or writes better code. Real-provider coding-task success remains a separate
evaluation; no synthetic pass rate will be presented as that result.

## Implemented result and measured limits

Implemented in `packages/sdk/src/history.ts`, bound by `Agent` and enabled in both the
factory and shared CLI runtime. The core change is an optional eviction-recovery callback;
the tree schema, provider transports, and loop scheduling are unchanged. Normal tool
events expose queries, source references, retrieved text and errors to every surface.

Run `bun scripts/history-recall-benchmark.ts` to reproduce the controlled comparison.
Each trial generates an unpredictable original value, captures a ~10,000-character
observation through a real tool call, compacts it through Mu, reloads the serialized
session, and asks for the original value after the observation source changes. The
deterministic policy sees only actual provider requests and returned tool results. It
gets no reference ID, offset, or expected answer from the evaluator. The compactor's
2,000-character tool-input bound excludes the answer before the scripted summary.

| Measurement (24 generated trials per mode) | Existing summary-only context | Recoverable history |
|---|---:|---:|
| Exact historical value recovered | 0/24 | 24/24 |
| Source tool reruns | 24 | 0 |
| Model calls per recovery attempt | 2 | 3 |
| Retrieved context per attempt | 0 | 5,132 characters / ~1,467 estimated tokens |

The extra request is the search → read → answer sequence. These are repeated generated
instances of one controlled failure scenario, not 24 independent coding tasks. Timing
uses an in-process fake provider and is not a latency estimate for production models.
`history-recovery.test.ts` additionally exercises an actual FileSessionStore round trip.

`bun run ci` passed: **1,217 tests, 0 failures**, TypeScript checking, Biome checking and
kernel purity. Biome reports existing informational suggestions in preview files; these
do not fail its check. The sandboxed run could not run local socket/MCP tests; the approved
run outside the sandbox passed the complete suite. The 14 added tests cover the comparison,
bounded paging, literal matching, original evidence after both compaction layers, persisted
automatic-eviction references, forks/new sessions, completed-child evidence, malformed
details, child isolation, permissions, allowlists, overrides, and cancellation.

Remaining limits:

- Search is a linear literal scan of the active branch, with cooperative yielding. It
  needs useful lexical cues; it does not proactively recover an unknown forgotten fact.
  A future retrieval index can replace the scan without changing source references.
- History tools consume schema/context tokens and retrieval consumes model turns. The
  added capability does not establish a net coding-task accuracy or cost improvement
  on real providers. That requires matched long-task evaluations with model-chosen queries.
- The journal only contains what was recorded. Coding-tool truncation before persistence,
  omitted image payload retrieval, and unfinished/crashed child work are not solved.
- Retrieval restores evidence, not authority or current filesystem state. It neither
  replays effects nor changes read-before-edit state. Summary preservation still matters;
  search supplements it rather than making every summary omission harmless.
- Branch isolation is session-history scoping, not an OS security boundary. The coding
  agent retains its separately authorized filesystem and shell access.

The reversal condition for this prioritization is workload evidence that sustained tasks
rarely lose relevant context, or that failures are dominated by model reasoning while all
necessary evidence remains visible. In that case better inference/prompting or targeted
execution fixes should take precedence over more memory machinery.
