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
