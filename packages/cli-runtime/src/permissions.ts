import type { PermissionMode, PermissionRule, Profile } from "mu";

export function permissionModeFor(
  profile: Profile,
  requested?: string,
): PermissionMode | undefined {
  const modes = profile.permissionModes ?? [];
  if (modes.length === 0) {
    if (requested) {
      throw new Error(`Profile "${profile.name}" does not define permission modes.`);
    }
    return undefined;
  }

  const id = requested ?? profile.defaultPermissionMode ?? modes[0]?.id;
  const mode = modes.find((candidate) => candidate.id === id);
  if (mode) return mode;

  throw new Error(
    `Unknown permission mode "${id}" for profile "${profile.name}". Available modes: ${modes
      .map((candidate) => candidate.id)
      .join(", ")}.`,
  );
}

export function rulesForPermissionMode(
  base: PermissionRule[] | undefined,
  mode: PermissionMode | undefined,
): PermissionRule[] {
  return [...(base ?? []), ...(mode?.rules ?? [])];
}

// Shift+Tab. Wraps to the first mode after the last; undefined `current` (or
// one no longer in the list) starts from the first. A single mode has
// nothing to cycle to.
export function nextPermissionMode(
  modes: readonly PermissionMode[],
  current: PermissionMode | undefined,
): PermissionMode | undefined {
  if (modes.length < 2) return undefined;
  const currentIndex = modes.findIndex((mode) => mode.id === current?.id);
  return modes[(currentIndex + 1) % modes.length];
}
