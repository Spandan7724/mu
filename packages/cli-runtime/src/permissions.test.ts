import { describe, expect, test } from "bun:test";
import type { Profile } from "mu";
import { nextPermissionMode, permissionModeFor, rulesForPermissionMode } from "./permissions.ts";

const profile: Profile = {
  name: "test",
  toolset: [],
  promptFor: () => [],
  permissionDefaults: [{ permission: "*", pattern: "*", action: "ask" }],
  defaultPermissionMode: "safe",
  permissionModes: [
    {
      id: "safe",
      label: "safe",
      description: "ask",
      rules: [],
    },
    {
      id: "open",
      label: "open",
      description: "allow",
      rules: [{ permission: "*", pattern: "*", action: "allow" }],
    },
  ],
};

describe("permission modes", () => {
  test("selects the profile default or an explicit mode", () => {
    expect(permissionModeFor(profile)?.id).toBe("safe");
    expect(permissionModeFor(profile, "open")?.id).toBe("open");
  });

  test("mode rules are final overrides", () => {
    expect(
      rulesForPermissionMode(profile.permissionDefaults, permissionModeFor(profile, "open")),
    ).toEqual([
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  });

  test("unknown modes report the available choices", () => {
    expect(() => permissionModeFor(profile, "missing")).toThrow("safe, open");
  });
});

describe("nextPermissionMode (Shift+Tab)", () => {
  const modes = profile.permissionModes ?? [];
  const yolo = { id: "yolo", label: "yolo", description: "no asks", rules: [] };
  const three = [...modes, yolo];

  test("advances to the next mode in order", () => {
    expect(nextPermissionMode(modes, modes[0])?.id).toBe("open");
  });

  test("wraps from the last mode back to the first", () => {
    expect(nextPermissionMode(three, yolo)?.id).toBe("safe");
  });

  test("starts from the first mode when nothing is active yet", () => {
    expect(nextPermissionMode(modes, undefined)?.id).toBe("safe");
  });

  test("starts from the first mode when the current one is unrecognized", () => {
    const unknown = { id: "stale", label: "stale", description: "", rules: [] };
    expect(nextPermissionMode(modes, unknown)?.id).toBe("safe");
  });

  test("a single mode has nothing to cycle to", () => {
    expect(nextPermissionMode([modes[0] as (typeof modes)[number]], modes[0])).toBeUndefined();
  });

  test("zero modes is a no-op", () => {
    expect(nextPermissionMode([], undefined)).toBeUndefined();
  });
});
