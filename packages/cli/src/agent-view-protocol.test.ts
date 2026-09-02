import { describe, expect, test } from "bun:test";
import { builtinProviderConfigs } from "mu";
import {
  MANAGED_ENVIRONMENT_KEYS,
  parseAgentViewRequest,
  parseAgentViewResponse,
} from "./agent-view-protocol.ts";

describe("agent-view protocol", () => {
  test("requires a matching versioned hello", () => {
    expect(
      parseAgentViewRequest(
        JSON.stringify({ type: "hello", id: "1", version: 1, scope: "project", cwd: "/work" }),
      ),
    ).toMatchObject({ type: "hello", version: 1 });
    expect(() =>
      parseAgentViewRequest(
        JSON.stringify({ type: "hello", id: "1", version: 2, scope: "project", cwd: "/work" }),
      ),
    ).toThrow();
  });

  test("rejects unknown operations and unbounded dispatch environment", () => {
    expect(() =>
      parseAgentViewRequest(JSON.stringify({ type: "delete_everything", id: "1" })),
    ).toThrow();
    expect(() =>
      parseAgentViewRequest(
        JSON.stringify({
          type: "dispatch",
          id: "1",
          prompt: "work",
          cwd: "/work",
          profile: "coding",
          environment: Object.fromEntries(
            Array.from({ length: 65 }, (_, index) => [`KEY_${index}`, "value"]),
          ),
        }),
      ),
    ).toThrow("too many entries");
    expect(() =>
      parseAgentViewRequest(
        JSON.stringify({
          type: "dispatch",
          id: "1",
          prompt: "work",
          cwd: "/work",
          profile: "coding",
          environment: { HOME: "/do/not/forward" },
        }),
      ),
    ).toThrow("do not accept");
  });

  test("accepts a strict supervisor shutdown operation", () => {
    expect(parseAgentViewRequest(JSON.stringify({ type: "shutdown", id: "stop" }))).toEqual({
      type: "shutdown",
      id: "stop",
    });
    expect(() =>
      parseAgentViewRequest(JSON.stringify({ type: "shutdown", id: "stop", force: true })),
    ).toThrow();
  });

  test("allows every canonical built-in provider credential in the ephemeral handoff", () => {
    const providerKeys = [...builtinProviderConfigs.values()].flatMap((provider) => provider.env);
    expect(providerKeys.length).toBeGreaterThan(0);
    expect(providerKeys.every((key) => MANAGED_ENVIRONMENT_KEYS.includes(key))).toBe(true);
  });

  test("allows namespaced custom-profile environment without exposing process identity", () => {
    expect(
      parseAgentViewRequest(
        JSON.stringify({
          type: "dispatch",
          id: "profile-env",
          prompt: "work",
          cwd: "/work",
          profile: "custom",
          environment: { MU_PROFILE_FIXTURE_VALUE: "custom-value" },
        }),
      ),
    ).toMatchObject({ environment: { MU_PROFILE_FIXTURE_VALUE: "custom-value" } });
    expect(() =>
      parseAgentViewRequest(
        JSON.stringify({
          type: "dispatch",
          id: "bad-profile-env",
          prompt: "work",
          cwd: "/work",
          profile: "custom",
          environment: { MU_PROFILE_bad: "not-canonical" },
        }),
      ),
    ).toThrow("do not accept");
  });

  test("validates supervisor output before a client adopts it", () => {
    expect(parseAgentViewResponse(JSON.stringify({ type: "hello", version: 1, pid: 42 }))).toEqual({
      type: "hello",
      version: 1,
      pid: 42,
    });
    expect(() =>
      parseAgentViewResponse(JSON.stringify({ type: "record", record: { sessionId: "only" } })),
    ).toThrow();
    expect(() =>
      parseAgentViewResponse(
        JSON.stringify({
          type: "event",
          sessionId: "s1",
          event: { type: "task_started", taskId: 42, command: "bun test", background: true },
        }),
      ),
    ).toThrow();
  });

  test("accepts native web search activity from a managed worker", () => {
    const response = {
      type: "event",
      sessionId: "s1",
      event: {
        type: "web_search_end",
        search: {
          type: "webSearch",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "mu agent" },
        },
      },
    } as const;

    expect(parseAgentViewResponse(JSON.stringify(response))).toEqual(response);
  });
});
