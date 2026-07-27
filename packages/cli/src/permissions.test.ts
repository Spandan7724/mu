import { describe, expect, test } from "bun:test";
import type { Profile } from "mu";
import { permissionModeFor, rulesForPermissionMode } from "./permissions.ts";

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
