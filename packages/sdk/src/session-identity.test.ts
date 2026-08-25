import { describe, expect, test } from "bun:test";
import type { Profile } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";
import { MemorySessionStore, SessionTree } from "./index.ts";
import { optionsFromProfile } from "./profile.ts";

function profile(name: string, environment: Record<string, string>): Profile {
  return {
    name,
    toolset: [],
    promptFor: () => [{ id: "identity", text: "be useful" }],
    permissionDefaults: [],
    environment: () => environment,
  };
}

const provider = () => new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);

describe("session header identity", () => {
  test("the header records the profile that was actually selected", async () => {
    const options = await optionsFromProfile(profile("browser", { connection: "persistent" }), "x");
    const agent = new Agent({ ...options, provider: provider(), model: fakeModel, tools: [] });

    expect(agent.sessionProfile).toBe("browser");
    expect(agent.session.header?.profile).toBe("browser");
    expect(agent.session.header?.environment).toEqual({ connection: "persistent" });
  });

  test("an Agent with no profile is marked as having none, not as a profile named default", () => {
    const agent = new Agent();
    expect(agent.sessionProfile).toBe("default");
    expect(agent.sessionEnvironment).toEqual({});
  });

  test("identity and environment survive newSession", async () => {
    const options = await optionsFromProfile(profile("browser", { connection: "persistent" }), "x");
    const agent = new Agent({ ...options, provider: provider(), model: fakeModel, tools: [] });
    const first = agent.sessionId;

    agent.newSession();

    expect(agent.sessionId).not.toBe(first);
    expect(agent.session.header?.profile).toBe("browser");
    expect(agent.session.header?.environment).toEqual({ connection: "persistent" });
  });

  test("identity and environment round-trip through a persisted session", async () => {
    const store = new MemorySessionStore();
    const options = await optionsFromProfile(
      profile("browser", { connection: "persistent", "browser.family": "chrome" }),
      "x",
    );
    const source = new Agent({
      ...options,
      provider: provider(),
      model: fakeModel,
      tools: [],
      session: store,
    });
    await source.run("hello");
    await source.shutdown();

    const reader = new Agent({ session: store });
    const tree = await store.load(source.sessionId);
    if (!tree) throw new Error("session was not persisted");
    reader.resume(tree);

    expect(reader.session.header?.profile).toBe("browser");
    expect(reader.session.header?.environment).toEqual({
      connection: "persistent",
      "browser.family": "chrome",
    });
  });

  test("an out-of-contract environment fails at construction, not at save time", () => {
    expect(
      () => new Agent({ sessionEnvironment: { "bad key": "v" } as Record<string, string> }),
    ).toThrow("Invalid session environment key");
    expect(() => new Agent({ sessionProfile: "" })).toThrow("non-empty string");
  });

  test("an oversized environment value is clamped so the header still loads", () => {
    const agent = new Agent({ sessionEnvironment: { note: "x".repeat(9_000) } });
    expect(agent.session.header?.environment.note?.length).toBe(4_096);
    expect(SessionTree.fromJsonl(agent.session.toJsonl()).header?.environment).toEqual(
      agent.sessionEnvironment,
    );
  });
});
