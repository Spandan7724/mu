// Checkpointing interface. Deliberately domain-free: a coding profile backs
// this with a shadow repository, a computer-use profile might snapshot screen
// state, an automation profile external API state. The kernel only pairs a
// snapshot reference with a session entry.

export interface CheckpointDiffFile {
  path: string;
  added: number;
  removed: number;
  hunks: string[];
}

export interface CheckpointProvider {
  // Captures current state and returns an opaque reference, or undefined when
  // there was nothing to capture.
  snapshot(label?: string): Promise<string | undefined>;
  // Restores state to a previous reference.
  restore(ref: string): Promise<void>;
  // Difference between two references (or from a reference to now).
  diff(fromRef: string, toRef?: string): Promise<CheckpointDiffFile[]>;
}

// Pairs conversation rewind with state restore. Undo is only trustworthy when
// the two move together — that is the whole point of this type existing.
export interface CheckpointEntry {
  entryId: string;
  ref: string;
  label?: string;
}

export class CheckpointHistory {
  private entries: CheckpointEntry[] = [];
  private undone: CheckpointEntry[] = [];

  record(entry: CheckpointEntry): void {
    this.entries.push(entry);
    // A fresh action invalidates the redo stack, as in any editor.
    this.undone = [];
  }

  get canUndo(): boolean {
    return this.entries.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  // Returns the checkpoint to restore *to* — the state before the last action.
  popForUndo(): { restoreTo: CheckpointEntry; undone: CheckpointEntry } | undefined {
    const last = this.entries.pop();
    if (!last) return undefined;
    this.undone.push(last);
    const previous = this.entries[this.entries.length - 1];
    return { restoreTo: previous ?? last, undone: last };
  }

  popForRedo(): CheckpointEntry | undefined {
    const entry = this.undone.pop();
    if (!entry) return undefined;
    this.entries.push(entry);
    return entry;
  }

  all(): CheckpointEntry[] {
    return [...this.entries];
  }

  first(): CheckpointEntry | undefined {
    return this.entries[0];
  }

  last(): CheckpointEntry | undefined {
    return this.entries[this.entries.length - 1];
  }
}
