import { resolve } from "node:path";
import type { CheckpointDiffFile } from "@mu/core";
import type { ShadowCheckpointProvider } from "./checkpoint.ts";
import type { FileState } from "./state.ts";

// Diff lines kept across one command's files; past it, files keep their counts only.
const MAX_KEPT_DIFF_LINES = 2_000;

export interface ChangedFile extends CheckpointDiffFile {
  // The diff was too large to keep in the session; counts remain.
  hunksOmitted?: true;
}

// Measures what one shell command changed in the workspace, from checkpoint
// snapshots taken around it.
export interface CommandChanges {
  before(signal: AbortSignal): Promise<string | undefined>;
  // `byAgent` is false for commands the user ran; those never count as the
  // agent's own changes.
  after(before: string, byAgent: boolean): Promise<ChangedFile[]>;
}

export function commandChanges(
  root: string,
  checkpoints: ShadowCheckpointProvider,
  state: FileState,
): CommandChanges {
  return {
    before: (signal) => checkpoints.snapshot("before command", signal),
    after: async (before, byAgent) => {
      const after = await checkpoints.snapshot("after command");
      if (!after) return [];
      const files = await checkpoints.diff(before, after);
      if (byAgent) {
        await Promise.all(
          files.map(async (file) => {
            const absolute = resolve(root, file.path);
            const previous = state.hasRead(absolute)
              ? await checkpoints.fileAt(before, file.path)
              : undefined;
            state.markChanged(absolute, previous);
          }),
        );
      }
      return boundDiffs(files);
    },
  };
}

function boundDiffs(files: CheckpointDiffFile[]): ChangedFile[] {
  let kept = 0;
  return files.map((file) => {
    if (kept + file.hunks.length > MAX_KEPT_DIFF_LINES) {
      return { ...file, hunks: [], hunksOmitted: true };
    }
    kept += file.hunks.length;
    return file;
  });
}

const LISTED_FILES = 20;

// One line for the model naming what the command changed.
export function changedFilesNote(files: ChangedFile[]): string {
  const listed = files
    .slice(0, LISTED_FILES)
    .map((file) => `${file.path} (+${file.added} -${file.removed})`);
  const more = files.length > LISTED_FILES ? `, and ${files.length - LISTED_FILES} more` : "";
  return `[changed ${files.length} file${files.length === 1 ? "" : "s"}: ${listed.join(", ")}${more}]`;
}
