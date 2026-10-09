export type Ref = string;

export interface RefMeta {
  role: string;
  name: string;
  editable?: "text" | "rich" | "secret" | "otp";
  form?: { post: boolean; submit?: boolean; submitLabel?: string };
  dialogTitle?: string;
  // A link to another page (http or https), not a script or in-page anchor.
  link?: boolean;
}

function normalize(ref: Ref): Ref {
  return ref
    .trim()
    .replace(/^\[?ref=/, "")
    .replace(/\]$/, "");
}

export interface RefTarget {
  frameId: string;
  backendNodeId: number;
}

// Stable per document: a node keeps its ref while its backendNodeId lives,
// and refs are never reused within a document.
export class RefTable {
  private document: string | undefined;
  private readonly byKey = new Map<string, Ref>();
  private readonly byRef = new Map<Ref, RefTarget>();
  private readonly labels = new Map<Ref, string>();
  private readonly metas = new Map<Ref, RefMeta>();
  private readonly frameNumbers = new Map<string, number>();
  private readonly counters = new Map<string, number>();
  private mainFrameId: string | undefined;

  get documentId(): string | undefined {
    return this.document;
  }

  // Returns true when the document changed and the table was reset.
  beginDocument(documentId: string, mainFrameId: string): boolean {
    if (this.document === documentId) return false;
    const reset = this.document !== undefined;
    this.document = documentId;
    this.mainFrameId = mainFrameId;
    this.byKey.clear();
    this.byRef.clear();
    this.labels.clear();
    this.metas.clear();
    this.frameNumbers.clear();
    this.counters.clear();
    return reset;
  }

  private frameNumber(frameId: string): number {
    if (frameId === this.mainFrameId) return 0;
    let number = this.frameNumbers.get(frameId);
    if (number === undefined) {
      number = this.frameNumbers.size + 1;
      this.frameNumbers.set(frameId, number);
    }
    return number;
  }

  refFor(frameId: string, backendNodeId: number): Ref {
    const key = `${frameId}:${backendNodeId}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const frame = this.frameNumber(frameId);
    const next = (this.counters.get(frameId) ?? 0) + 1;
    this.counters.set(frameId, next);
    const ref = frame === 0 ? `e${next}` : `f${frame}e${next}`;
    this.byKey.set(key, ref);
    this.byRef.set(ref, { frameId, backendNodeId });
    return ref;
  }

  // Human-readable target for outcome lines, e.g. `button "Send"`.
  setLabel(ref: Ref, label: string): void {
    this.labels.set(ref, label);
  }

  setMeta(ref: Ref, meta: RefMeta): void {
    this.metas.set(ref, meta);
  }

  meta(ref: Ref): RefMeta | undefined {
    return this.metas.get(normalize(ref));
  }

  label(ref: Ref): string {
    const label = this.labels.get(ref);
    return label ? `${label} [${ref}]` : ref;
  }

  refOf(frameId: string, backendNodeId: number): Ref | undefined {
    return this.byKey.get(`${frameId}:${backendNodeId}`);
  }

  resolve(ref: Ref): RefTarget | undefined {
    return this.byRef.get(normalize(ref));
  }

  has(ref: Ref): boolean {
    return this.byRef.has(normalize(ref));
  }
}
