// One event stream, shaped per listener. The kernel keeps emitting at full
// fidelity; what a subscriber costs is a property of who is listening (RD5).
export interface SubscriberPolicy {
  updates: "full" | "coalesced" | "none";
  // coalesced only; clamped to [MIN_UPDATE_HZ, MAX_UPDATE_HZ]
  updateHz?: number;
  maxInlineBytes?: number;
  taskOutput?: boolean;
  images?: "inline" | "stub";
}

export const DEFAULT_UPDATE_HZ = 8;
export const MIN_UPDATE_HZ = 1;
export const MAX_UPDATE_HZ = 30;
export const DEFAULT_MAX_INLINE_BYTES = 16_384;

export interface ResolvedPolicy {
  updates: "full" | "coalesced" | "none";
  updateHz: number;
  maxInlineBytes: number;
  taskOutput: boolean;
  images: "inline" | "stub";
}

export function resolvePolicy(policy: SubscriberPolicy): ResolvedPolicy {
  return {
    updates: policy.updates,
    updateHz: Math.min(
      MAX_UPDATE_HZ,
      Math.max(MIN_UPDATE_HZ, policy.updateHz ?? DEFAULT_UPDATE_HZ),
    ),
    maxInlineBytes: Math.max(0, policy.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES),
    taskOutput: policy.taskOutput ?? false,
    images: policy.images ?? "stub",
  };
}

// What a local surface reading over a Unix socket asks for: byte-identical to
// what the Agent emits.
export const FULL_FIDELITY: SubscriberPolicy = {
  updates: "full",
  maxInlineBytes: Number.MAX_SAFE_INTEGER,
  taskOutput: true,
  images: "inline",
};
