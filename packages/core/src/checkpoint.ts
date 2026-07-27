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
  // Restores only the named resources when the provider can do so safely.
  // Undo uses this to preserve unrelated state changed after a turn.
  restoreResources?(ref: string, resources: string[]): Promise<void>;
  // Difference between two references (or from a reference to now).
  diff(fromRef: string, toRef?: string): Promise<CheckpointDiffFile[]>;
}

// Pairs conversation rewind with state restore. Undo is only trustworthy when
// the two move together — that is the whole point of this type existing.
export interface CheckpointEntry {
  id: string;
  beforeEntryId: string | null;
  beforeRef: string;
  afterRef: string;
  // Exact state captured immediately before an undo. Redo prefers this over
  // the original afterRef so changes made outside the agent are recoverable.
  redoRef?: string;
  label?: string;
}

export class CheckpointHistory {
  private done: CheckpointEntry[] = [];
  private undone: CheckpointEntry[] = [];

  record(entry: CheckpointEntry): void {
    this.done.push(entry);
    this.undone = [];
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  peekUndo(): CheckpointEntry | undefined {
    return this.done[this.done.length - 1];
  }

  commitUndo(expected: CheckpointEntry, redoRef?: string): void {
    if (this.peekUndo()?.id !== expected.id)
      throw new Error("Checkpoint history changed during undo");
    this.done.pop();
    this.undone.push({ ...expected, ...(redoRef ? { redoRef } : {}) });
  }

  peekRedo(): CheckpointEntry | undefined {
    return this.undone[this.undone.length - 1];
  }

  commitRedo(expected: CheckpointEntry): void {
    if (this.peekRedo()?.id !== expected.id)
      throw new Error("Checkpoint history changed during redo");
    this.undone.pop();
    const { redoRef: _redoRef, ...done } = expected;
    this.done.push(done);
  }

  restore(done: CheckpointEntry[], undone: CheckpointEntry[] = []): void {
    this.done = [...done];
    this.undone = [...undone];
  }

  state(): { done: CheckpointEntry[]; undone: CheckpointEntry[] } {
    return { done: [...this.done], undone: [...this.undone] };
  }

  all(): CheckpointEntry[] {
    return [...this.done];
  }

  first(): CheckpointEntry | undefined {
    return this.done[0];
  }

  last(): CheckpointEntry | undefined {
    return this.done[this.done.length - 1];
  }
}
