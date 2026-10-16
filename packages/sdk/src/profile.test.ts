import { describe, expect, test } from "bun:test";
import type { CheckpointProvider, Profile, ProfileRuntime } from "@mu/core";
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

  test("propagates profile identity and environment into session options", async () => {
    const source: Profile = {
      ...profile(provider("profile")),
      name: "custom",
      environment: async () => ({ workspace: "/custom", instance: "one" }),
    };
    const options = await optionsFromProfile(source, "fake/model");

    expect(options.sessionProfile).toBe("custom");
    expect(options.sessionEnvironment).toEqual({ workspace: "/custom", instance: "one" });
  });

  test("a profile's reason for having no checkpoints yields to a supplied provider", async () => {
    const { checkpointProvider: _, ...base } = profile(provider("profile"));
    const off: Profile = { ...base, checkpointUnavailable: "off here" };
    expect((await optionsFromProfile(off, "fake/model")).checkpointUnavailable).toBe("off here");

    const override = provider("override");
    const options = await optionsFromProfile(off, "fake/model", { checkpointProvider: override });
    expect(options.checkpointProvider).toBe(override);
    expect(options.checkpointUnavailable).toBeUndefined();
  });

  test("a profile's partial-checkpoint notice travels with its own provider only", async () => {
    const partial: Profile = { ...profile(provider("profile")), checkpointNotice: "partial here" };
    expect((await optionsFromProfile(partial, "fake/model")).checkpointNotice).toBe("partial here");
    const options = await optionsFromProfile(partial, "fake/model", {
      checkpointProvider: provider("override"),
    });
    expect(options.checkpointNotice).toBeUndefined();
  });

  test("an explicit checkpoint provider overrides the profile", async () => {
    const profileProvider = provider("profile");
    const override = provider("override");
    const options = await optionsFromProfile(profile(profileProvider), "fake/model", {
      checkpointProvider: override,
    });

    expect(options.checkpointProvider).toBe(override);
  });

  test("propagates the profile runtime and honors an explicit override", async () => {
    const profileRuntime: ProfileRuntime = { attach: () => {} };
    const override: ProfileRuntime = { attach: () => {} };
    const source = { ...profile(provider("profile")), runtime: profileRuntime };

    expect((await optionsFromProfile(source, "fake/model")).runtime).toBe(profileRuntime);
    expect((await optionsFromProfile(source, "fake/model", { runtime: override })).runtime).toBe(
      override,
    );
  });

  test("propagates the profile context refresh hook", async () => {
    const refreshContext = () => [];
    const source = { ...profile(provider("profile")), refreshContext };
    expect((await optionsFromProfile(source, "fake/model")).refreshContext).toBe(refreshContext);
  });
});
