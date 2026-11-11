import {
  type AgentMessage,
  type CompactionResult,
  type CompactionTrigger,
  estimateTokens,
  type SessionTree,
  type TreeEntry,
} from "@mu/core";

export interface EntryReplacement {
  entryId: string;
  message: AgentMessage;
}

// The messages a cleanup pass rewrote, keyed by the session entry each came
// from. Undefined unless every rewritten message maps to an entry: only a
// transition that replays exactly after resume may be recorded.
export function mappedReplacements(
  tree: SessionTree,
  before: AgentMessage[],
  after: AgentMessage[],
): EntryReplacement[] | undefined {
  const replacements: EntryReplacement[] = [];
  for (let index = 0; index < after.length; index++) {
    const message = after[index] as AgentMessage;
    const prior = before[index];
    if (message === prior) continue;
    const entryId = prior ? tree.entryIdForMessage(prior) : undefined;
    if (!entryId) return undefined;
    replacements.push({ entryId, message });
  }
  return replacements;
}

export interface CompactionBoundaryOptions {
  // The session entry a model-visible message came from.
  entryIdOf: (message: AgentMessage) => string | undefined;
  // Cleanup replacements made before summarizing that the tree does not hold yet.
  earlier?: EntryReplacement[];
  // The boundary records how many tool results the whole operation cleared.
  recordCleared?: boolean;
  summaryTimestamp?: number | undefined;
  trigger: CompactionTrigger;
  contextTokensBefore: number;
  contextTokensAfter: number;
  model: string;
  compactorModel: string;
}

// Writes a finished summarization into `tree`: its replacements, then the
// boundary. Throws before appending anything when the tail, a protected message
// or a replacement cannot be tied to an entry, so the caller keeps the full context.
export function appendCompactionBoundary(
  tree: SessionTree,
  result: CompactionResult,
  options: CompactionBoundaryOptions,
): { boundary: TreeEntry; replacements: EntryReplacement[] } {
  const replacements = [...(options.earlier ?? [])];
  for (const { original, message } of result.replacements ?? []) {
    const entryId = options.entryIdOf(original);
    if (!entryId) throw new Error("Compaction observation could not be mapped to the session");
    replacements.push({ entryId, message });
  }
  const preservedEntryIds = (result.preservedMessages ?? []).map((message) => {
    const entryId = options.entryIdOf(message);
    if (!entryId) throw new Error("Protected context could not be mapped to the session");
    return entryId;
  });
  const firstKept = result.keptMessages[0];
  let firstKeptEntryId: string | null = null;
  if (firstKept) {
    const source =
      result.replacements?.find((replacement) => replacement.message === firstKept)?.original ??
      firstKept;
    const mapped = options.entryIdOf(source);
    if (!mapped) throw new Error("Compaction tail could not be mapped to the session");
    firstKeptEntryId = mapped;
  }

  const windowNumber = tree.activePath().filter((entry) => entry.type === "compaction").length + 1;
  if (replacements.length > 0) tree.append({ type: "microcompaction", replacements });
  const boundary = tree.append({
    type: "compaction",
    summary: result.summary,
    ...(result.carryover !== undefined ? { carryover: result.carryover } : {}),
    firstKeptEntryId,
    preservedEntryIds,
    ...(options.summaryTimestamp !== undefined ? { timestamp: options.summaryTimestamp } : {}),
    trigger: options.trigger,
    contextTokensBefore: options.contextTokensBefore,
    contextTokensAfter: options.contextTokensAfter,
    model: options.model,
    compactorModel: options.compactorModel,
    windowNumber,
    strategy: "summary-tail",
    keptTokens: estimateTokens(result.keptMessages),
    ...(options.recordCleared ? { toolResultsCleared: replacements.length } : {}),
    usage: result.usage,
  });
  return { boundary, replacements };
}
