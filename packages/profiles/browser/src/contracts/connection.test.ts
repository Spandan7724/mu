import { describe, expect, test } from "bun:test";
import { sampleConnectionState } from "../testing/samples.ts";
import {
  acceptsModelActions,
  type BrowserConnectionState,
  browserConnectionStateSchema,
  connectionSummary,
  connectOptionsInputSchema,
  connectOptionsSchema,
} from "./connection.ts";

describe("connection state", () => {
  test("accepts the sample state and keeps its parsed shape assignable", () => {
    const parsed: BrowserConnectionState = browserConnectionStateSchema.parse(
      sampleConnectionState(),
    );
    expect(parsed.phase).toBe("ready");
  });

  test("only ready accepts model-authored actions", () => {
    expect(acceptsModelActions("ready")).toBe(true);
    for (const phase of [
      "disconnected",
      "connecting",
      "takeover",
      "reconnecting",
      "closing",
      "failed",
    ] as const) {
      expect(acceptsModelActions(phase)).toBe(false);
    }
  });

  test("rejects an unknown phase and an unknown extra field", () => {
    expect(
      browserConnectionStateSchema.safeParse(sampleConnectionState({ phase: "paused" as never }))
        .success,
    ).toBe(false);
    expect(
      browserConnectionStateSchema.safeParse({ ...sampleConnectionState(), cookies: "a=b" })
        .success,
    ).toBe(false);
  });

  test("rejects a websocket endpoint smuggled in as a connection id", () => {
    const state = sampleConnectionState({ connectionId: "ws://127.0.0.1:9222/devtools/abc" });
    expect(browserConnectionStateSchema.safeParse(state).success).toBe(false);
  });

  test("summarises without inventing detail", () => {
    expect(connectionSummary(sampleConnectionState())).toBe("chrome (persistent) ready tab tab-1");
  });
});

describe("connect options", () => {
  test("rejects removed extension configuration", () => {
    expect(
      connectOptionsInputSchema.safeParse({
        mode: "persistent",
        browser: "chromium",
        extensionToken: "mu_ext_1",
      }).success,
    ).toBe(false);
    expect(connectOptionsSchema.safeParse({ mode: "extension", browser: "edge" }).success).toBe(
      false,
    );
  });

  test("accepts a visible or headless persistent profile", () => {
    expect(connectOptionsSchema.safeParse({ mode: "persistent", browser: "edge" }).success).toBe(
      true,
    );
    expect(
      connectOptionsSchema.safeParse({
        mode: "persistent",
        browser: "chromium",
        userDataDir: "/home/user/.mu/browser/profiles/default",
        headless: true,
      }).success,
    ).toBe(true);
  });
});
