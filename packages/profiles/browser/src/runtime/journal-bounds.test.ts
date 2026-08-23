// B8: a long session must not grow the runtime journal without bound. The existing
// suite proves the cap holds across one short lifecycle; this proves it holds under
// sustained flapping, and that what gets dropped is specifically the oldest entries —
// never a stall that stops recording, and never unbounded growth.
import { describe, expect, test } from "bun:test";
import type { BrowserDriverFactory } from "../drivers/factory.ts";
import { createFakeBrowserDriver } from "../drivers/fake/driver.ts";
import { BrowserRuntime } from "./runtime.ts";

const signal = () => new AbortController().signal;

function attachedFactory() {
  const driver = createFakeBrowserDriver();
  const factory: BrowserDriverFactory = async () => ({
    driver,
    ownership: "attached",
    description: "fake",
    dispose: async () => {},
  });
  return { driver, factory };
}

describe("the runtime journal stays bounded across a flapping long session", () => {
  test("hundreds of transitions never exceed the cap, and the earliest entries are the ones evicted", async () => {
    let clock = 0;
    const now = () => ++clock;
    const { driver, factory } = attachedFactory();
    const runtime = new BrowserRuntime({
      factory,
      connection: "extension",
      browser: "chrome",
      dataRoot: "/unused",
      now,
    });
    await runtime.connect(signal());
    const firstEntry = runtime.journal[0];
    expect(firstEntry).toBeDefined();

    for (let i = 0; i < 40; i++) {
      driver.simulateConnectionLoss();
      await expect(runtime.use((d) => d.observe({}, signal()), signal())).rejects.toThrow();
      expect(runtime.status().phase).toBe("reconnecting");
      // The cap is enforced on every push, not just checked at the end of a run.
      expect(runtime.journal.length).toBeLessThanOrEqual(50);
      await runtime.reconnect(signal());
      expect(runtime.status().phase).toBe("ready");
      expect(runtime.journal.length).toBeLessThanOrEqual(50);
    }

    // 40 loops record at least 80 transitions (bridge-lost + reconnected each), plus
    // the initial connect — comfortably more than the 50-entry cap.
    expect(runtime.journal.length).toBe(50);
    expect(runtime.journal.some((entry) => entry.at === firstEntry?.at)).toBe(false);
    // What remains is still coherent: a recent tail ending on the phase we left it in.
    expect(runtime.journal.at(-1)?.phase).toBe("ready");
    expect(runtime.journal.some((entry) => entry.phase === "reconnecting")).toBe(true);
    // Recording never silently stopped: timestamps in what remains keep advancing.
    const ats = runtime.journal.map((entry) => entry.at);
    for (let i = 1; i < ats.length; i++) {
      expect(ats[i]).toBeGreaterThan(ats[i - 1] as number);
    }
  });
});
