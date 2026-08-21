export type ArtifactKind = "screenshot" | "observation" | "download" | "log" | "receipt";

export interface RetentionLimits {
  maxCount: number;
  maxBytes: number;
  maxAgeMs: number;
}

const DAY = 24 * 60 * 60 * 1000;

// BD22. Chosen conservatively: a browser task touches authenticated pages, so the
// trail it leaves behind is a second copy of that data and needs a ceiling in every
// dimension. Receipts are the accountability record and are kept longest.
export const ARTIFACT_RETENTION: Readonly<Record<ArtifactKind, RetentionLimits>> = {
  screenshot: { maxCount: 20, maxBytes: 20 * 1024 * 1024, maxAgeMs: 7 * DAY },
  observation: { maxCount: 50, maxBytes: 10 * 1024 * 1024, maxAgeMs: 7 * DAY },
  download: { maxCount: 100, maxBytes: 2 * 1024 * 1024, maxAgeMs: 7 * DAY },
  log: { maxCount: 10, maxBytes: 20 * 1024 * 1024, maxAgeMs: 14 * DAY },
  receipt: { maxCount: 500, maxBytes: 25 * 1024 * 1024, maxAgeMs: 180 * DAY },
} as const;

export interface ArtifactEntry {
  name: string;
  bytes: number;
  createdAt: number;
}

export interface RetentionPlan {
  keep: ArtifactEntry[];
  evict: ArtifactEntry[];
}

export function planRetention(
  entries: readonly ArtifactEntry[],
  limits: RetentionLimits,
  now: number,
): RetentionPlan {
  const ordered = [...entries].sort((left, right) => left.createdAt - right.createdAt);
  const newest = ordered.at(-1);
  const keep: ArtifactEntry[] = [];
  const evict: ArtifactEntry[] = [];
  for (const entry of ordered) {
    if (now - entry.createdAt > limits.maxAgeMs) evict.push(entry);
    else keep.push(entry);
  }
  // The newest artifact is never evicted for count or size: a write that vanished
  // would hand its caller a path to nothing. Age still expires it.
  const floor = keep.length > 0 && keep.at(-1) === newest ? 1 : 0;
  let bytes = keep.reduce((total, entry) => total + entry.bytes, 0);
  while (keep.length > floor && (keep.length > limits.maxCount || bytes > limits.maxBytes)) {
    const oldest = keep.shift();
    if (oldest === undefined) break;
    bytes -= oldest.bytes;
    evict.push(oldest);
  }
  return { keep, evict };
}
