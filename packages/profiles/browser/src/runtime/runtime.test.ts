import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@mu/core";
import { BrowserDriverError } from "../contracts/driver.ts";
import type { BrowserDriverFactory, BrowserDriverHandle } from "../drivers/factory.ts";
import { createFakeBrowserDriver } from "../drivers/fake/driver.ts";
import {
  claimProfile,
  OWNERSHIP_FILE,
  persistentProfileDir,
  persistentProfileFactory,
} from "../drivers/persistent.ts";
import { BrowserRuntime } from "./runtime.ts";
import { canTransition, nextPhase } from "./state.ts";

const signal = () => new AbortController().signal;

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-browser-runtime-"));
}

function attachedFactory(overrides: Partial<BrowserDriverHandle> = {}): {
  factory: BrowserDriverFactory;
  disposed: () => number;
} {
  let disposals = 0;
  const factory: BrowserDriverFactory = async () => ({
    driver: createFakeBrowserDriver(),
    description: "a deterministic fake chrome",
    dispose: async () => {
      disposals += 1;
    },
    ...overrides,
  });
  return { factory, disposed: () => disposals };
}

describe("the state machine follows ARCHITECTURE section 7", () => {
  test("only ready accepts an action, and every documented edge exists", () => {
    expect(nextPhase("disconnected", "connect")).toBe("connecting");
    expect(nextPhase("connecting", "approved")).toBe("ready");
    expect(nextPhase("connecting", "rejected")).toBe("disconnected");
    expect(nextPhase("connecting", "failed")).toBe("failed");
    expect(nextPhase("ready", "takeover")).toBe("takeover");
    expect(nextPhase("ready", "bridge-lost")).toBe("reconnecting");
    expect(nextPhase("takeover", "resumed")).toBe("ready");
    expect(nextPhase("reconnecting", "reconnected")).toBe("ready");
    expect(nextPhase("reconnecting", "timed-out")).toBe("failed");
    expect(nextPhase("ready", "shutdown")).toBe("closing");
    expect(nextPhase("closing", "closed")).toBe("disconnected");
  });

  test("an undocumented edge is refused rather than invented", () => {
    expect(canTransition("disconnected", "acted")).toBe(false);
    expect(canTransition("takeover", "acted")).toBe(false);
    expect(canTransition("closing", "connect")).toBe(false);
  });
});

describe("connection lifecycle", () => {
  test("a runtime starts disconnected and connects lazily", async () => {
    const { factory } = attachedFactory();
    const runtime = new BrowserRuntime({
      factory,
      connection: "persistent",
      browser: "chrome",
      dataRoot: "/unused",
    });
    expect(runtime.status().phase).toBe("disconnected");
    await runtime.connect(signal());
    expect(runtime.status().phase).toBe("ready");
    expect(runtime.status().connectionId).toBeDefined();
  });

  test("concurrent callers share one connection attempt", async () => {
    let calls = 0;
    const factory: BrowserDriverFactory = async () => {
      calls += 1;
      return {
        driver: createFakeBrowserDriver(),
        description: "fake",
        dispose: async () => {},
      };
    };
    const runtime = new BrowserRuntime({
      factory,
      connection: "persistent",
      browser: "chrome",
      dataRoot: "/unused",
    });
    await Promise.all([
      runtime.connect(signal()),
      runtime.connect(signal()),
      runtime.connect(signal()),
    ]);
    expect(calls).toBe(1);
  });

  test("a failed connection is reported, not swallowed, and stays reusable", async () => {
    let attempt = 0;
    const factory: BrowserDriverFactory = async () => {
      attempt += 1;
      if (attempt === 1) throw new BrowserDriverError("protocol-mismatch", "update the bridge");
      return {
        driver: createFakeBrowserDriver(),
        description: "fake",
        dispose: async () => {},
      };
    };
    const runtime = new BrowserRuntime({
      factory,
      connection: "persistent",
      browser: "chrome",
      dataRoot: "/unused",
    });
    await expect(runtime.connect(signal())).rejects.toThrow("update the bridge");
    expect(runtime.status().phase).toBe("failed");
    expect(runtime.status().message).toBe("update the bridge");
    await runtime.connect(signal());
    expect(runtime.status().phase).toBe("ready");
  });

  test("cancelling the connection leaves the runtime disconnected rather than failed", async () => {
    const controller = new AbortController();
    const factory: BrowserDriverFactory = async (_options, driverSignal) => {
      controller.abort();
      if (driverSignal.aborted) throw new BrowserDriverError("aborted", "cancelled");
      throw new Error("unreachable");
    };
    const runtime = new BrowserRuntime({
      factory,
      connection: "persistent",
      browser: "chrome",
      dataRoot: "/unused",
    });
    await expect(runtime.connect(controller.signal)).rejects.toThrow("cancelled");
    expect(runtime.status().phase).toBe("disconnected");
  });

  test("a lost connection moves to reconnecting and tells the session", async () => {
    const driver = createFakeBrowserDriver();
    const factory: BrowserDriverFactory = async () => ({
      driver,
      description: "fake",
      dispose: async () => {},
    });
    const runtime = new BrowserRuntime({
      factory,
      connection: "persistent",
      browser: "chrome",
      dataRoot: "/unused",
    });
    const followUps: string[] = [];
    runtime.attach({ emit: () => {}, followUp: (message) => followUps.push(message) });
    await runtime.connect(signal());
    driver.simulateConnectionLoss();
    await expect(runtime.use((d) => d.observe({}, signal()), signal())).rejects.toThrow();
    expect(runtime.status().phase).toBe("reconnecting");
    expect(followUps.join(" ")).toContain("connection was lost");
  });

  test("takeover blocks model actions and resuming re-observes at a new revision", async () => {
    const { factory } = attachedFactory();
    const runtime = new BrowserRuntime({
      factory,
      connection: "persistent",
      browser: "chrome",
      dataRoot: "/unused",
    });
    const driver = await runtime.connect(signal());
    const before = await driver.observe({}, signal());
    await runtime.takeover("login", "Sign in, then /resume-browser.");
    expect(runtime.status().phase).toBe("takeover");
    await expect(runtime.use(async () => "nope", signal())).rejects.toThrow(
      "the browser is takeover",
    );
    const after = await runtime.resume(signal());
    expect(runtime.status().phase).toBe("ready");
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  test("state changes reach subscribers and a bounded journal", async () => {
    const { factory } = attachedFactory();
    const runtime = new BrowserRuntime({
      factory,
      connection: "persistent",
      browser: "chrome",
      dataRoot: "/unused",
    });
    const phases: string[] = [];
    runtime.subscribe((state) => phases.push(state.phase));
    await runtime.connect(signal());
    await runtime.shutdown();
    expect(phases).toEqual(["connecting", "ready", "closing", "disconnected"]);
    expect(runtime.journal.length).toBeLessThanOrEqual(50);
    expect(runtime.journal.at(-1)?.message).toContain("closed the browser Mu owns");
  });
});

describe("shutdown semantics close and dispose the Mu-owned browser", () => {
  test("the browser handle is disposed once", async () => {
    const { factory, disposed } = attachedFactory();
    const runtime = new BrowserRuntime({
      factory,
      connection: "persistent",
      browser: "chrome",
      dataRoot: "/unused",
    });
    await runtime.connect(signal());
    await runtime.shutdown();
    expect(disposed()).toBe(1);
    expect(runtime.status().phase).toBe("disconnected");
  });

  test("an owned browser is closed and awaited before the profile lock is released", async () => {
    const root = await tempRoot();
    try {
      const order: string[] = [];
      const factory = persistentProfileFactory({
        launch: async () => ({
          driver: createFakeBrowserDriver({ mode: "persistent" }),
          close: async () => {
            order.push("closed the browser");
          },
        }),
      });
      const runtime = new BrowserRuntime({
        factory,
        connection: "persistent",
        browser: "chromium",
        dataRoot: root,
        userDataDir: "work",
      });
      await runtime.connect(signal());
      const directory = persistentProfileDir(root, "work");
      expect(await readFile(join(directory, OWNERSHIP_FILE), "utf8")).toContain(
        `"pid": ${process.pid}`,
      );
      await runtime.shutdown();
      order.push("released the lock");
      expect(order).toEqual(["closed the browser", "released the lock"]);
      await expect(readFile(join(directory, OWNERSHIP_FILE), "utf8")).rejects.toThrow();
      expect(runtime.journal.at(-1)?.message).toContain("closed the browser Mu owns");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("shutdown without a connection is a no-op rather than a failure", async () => {
    const { factory } = attachedFactory();
    const runtime = new BrowserRuntime({
      factory,
      connection: "persistent",
      browser: "chrome",
      dataRoot: "/unused",
    });
    await runtime.shutdown();
    expect(runtime.status().phase).toBe("disconnected");
  });
});

describe("the persistent-profile factory owns its directory exclusively", () => {
  test("a profile name never escapes the browser data root (BD7)", () => {
    const root = "/tmp/mu-browser-data";
    expect(persistentProfileDir(root, "work")).toBe(join(root, "profiles", "work"));
    for (const outside of ["..", "../../.config/google-chrome", "/home/someone/.config"]) {
      expect(() => persistentProfileDir(root, outside)).toThrow("not a Mu-owned browser profile");
    }
  });

  test("a second live writer gets an actionable error instead of a corrupted profile", async () => {
    const root = await tempRoot();
    try {
      const directory = persistentProfileDir(root, "default");
      await claimProfile(
        directory,
        { pid: 424_242, startedAt: "2026-08-20T10:00:00.000Z", host: "elsewhere" },
        () => true,
      );
      const factory = persistentProfileFactory({
        launch: async () => {
          throw new Error("the browser must never be launched behind a live owner");
        },
        isAlive: () => true,
      });
      await expect(factory({ browser: "chromium", dataRoot: root }, signal())).rejects.toThrow(
        "already owns",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stale record from a dead process is reclaimed", async () => {
    const root = await tempRoot();
    try {
      const directory = persistentProfileDir(root, "default");
      await claimProfile(
        directory,
        { pid: 424_242, startedAt: "2026-08-20T10:00:00.000Z", host: "elsewhere" },
        () => true,
      );
      const factory = persistentProfileFactory({
        launch: async () => ({
          driver: createFakeBrowserDriver({ mode: "persistent" }),
          close: async () => {},
        }),
        isAlive: () => false,
      });
      const handle = await factory({ browser: "chromium", dataRoot: root }, signal());
      await handle.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("connection status reaches the user as an ordinary event", () => {
  function harness() {
    const events: AgentEvent[] = [];
    const { factory } = attachedFactory();
    const runtime = new BrowserRuntime({
      factory,
      connection: "persistent",
      browser: "chrome",
      dataRoot: "/unused",
    });
    runtime.attach({ emit: (event) => events.push(event), followUp: () => {} });
    return { runtime, events };
  }

  test("attaching publishes the current state without waiting for a transition", () => {
    const { events } = harness();
    const status = events.filter((e) => e.type === "profile_resource_status");
    expect(status.length).toBe(1);
    expect(status[0]).toMatchObject({ resourceId: "browser", state: "disconnected" });
  });

  test("every transition publishes a new status", async () => {
    const { runtime, events } = harness();
    await runtime.connect(signal());
    const states = events
      .filter((e) => e.type === "profile_resource_status")
      .map((e) => (e as { state: string }).state);
    expect(states[0]).toBe("disconnected");
    expect(states).toContain("ready");
  });

  // No browser vocabulary may reach the kernel event: the domain lives in the values.
  test("the event carries no browser-specific field", () => {
    const { events } = harness();
    const status = events.find((e) => e.type === "profile_resource_status");
    expect(Object.keys(status ?? {}).sort()).toEqual(
      ["resourceId", "state", "summary", "type"].sort(),
    );
  });
});
