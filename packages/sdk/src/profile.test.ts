import { describe, expect, test } from "bun:test";
import type { CheckpointProvider, Profile } from "@mu/core";
import { optionsFromProfile } from "./profile.ts";

function provider(name: string): CheckpointProvider & { name: string } {
  return {
    name,
    snapshot: async () => "ref",
    restore: async () => {},
    diff: async () => [],
  };
}

function profile(checkpointProvider: CheckpointProvider): Profile {
  return {
    name: "test",
    toolset: [],
    promptFor: () => [{ text: "test" }],
    permissionDefaults: [],
    checkpointProvider,
  };
}

describe("optionsFromProfile", () => {
  test("propagates the profile checkpoint provider", async () => {
    const checkpointProvider = provider("profile");
    const options = await optionsFromProfile(profile(checkpointProvider), "fake/model");

    expect(options.checkpointProvider).toBe(checkpointProvider);
  });

  test("an explicit checkpoint provider overrides the profile", async () => {
    const profileProvider = provider("profile");
    const override = provider("override");
    const options = await optionsFromProfile(profile(profileProvider), "fake/model", {
      checkpointProvider: override,
    });

    expect(options.checkpointProvider).toBe(override);
  });
});
