import type { PermissionMode, PermissionModeTone, PermissionRule } from "@mu/core";
import type { Origin } from "@mu/protocol";

// How much a mode opens the gate. A remote origin may move down this scale and
// never up (RD8).
const TONE_RANK: Record<PermissionModeTone | "default", number> = {
  restrictive: 0,
  default: 1,
  permissive: 2,
  unrestricted: 3,
};

export function toneRank(mode: PermissionMode | undefined): number {
  return TONE_RANK[mode?.tone ?? "default"];
}

function isBlanketAllow(rule: PermissionRule): boolean {
  return rule.permission === "*" && rule.pattern === "*" && rule.action === "allow";
}

// The remote-origin overlay. It strips blanket allows — which is what
// `--allow-all` and an unrestricted mode both reduce to — and then layers any
// host-supplied overlay after the configured rules, where last match wins. The
// result can only be the same or stricter, never looser.
export function narrowForRemote(
  rules: readonly PermissionRule[],
  overlay: readonly PermissionRule[] = [],
): PermissionRule[] {
  return [...rules.filter((rule) => !isBlanketAllow(rule)), ...overlay];
}

export function rulesForOrigin(
  origin: Origin,
  rules: readonly PermissionRule[],
  overlay?: readonly PermissionRule[],
): PermissionRule[] {
  return origin.kind === "remote" ? narrowForRemote(rules, overlay) : [...rules];
}

// A remote origin may select a mode at or stricter than the active one, and
// never an unrestricted one whatever the active mode is.
export function canSelectMode(
  origin: Origin,
  active: PermissionMode | undefined,
  requested: PermissionMode,
): boolean {
  if (origin.kind === "local") return true;
  if (requested.tone === "unrestricted") return false;
  return toneRank(requested) <= toneRank(active);
}
