import type { AgentMessage, SessionTree } from "@mu/core";

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
