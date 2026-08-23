// B8: a crashed browser or a dropped bridge is not the same as cancellation — the
// runtime did not choose to stop, the browser did. This proves the failure surfaces as
// a typed, classified error; the runtime lands somewhere describable (`reconnecting`,
// never a silent hang); reconnecting mints a genuinely new connection identity; and a
// reference minted before the crash is rejected rather than quietly resolving against
// whatever now happens to sit at the same tab id.
import { describe, expect, test } from "bun:test";
import { isBrowserDriverError } from "../contracts/driver.ts";
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

describe.each([
  "browser-crashed",
  "connection-lost",
] as const)("a %s failure is typed, classified, and recoverable", (code) => {
  test("the failure surfaces as a typed error, reconnecting mints new identity, and the stale ref is refused", async () => {
    const { driver, factory } = attachedFactory();
    const runtime = new BrowserRuntime({
      factory,
      connection: "extension",
      browser: "chrome",
      dataRoot: "/unused",
    });
    const followUps: string[] = [];
    runtime.attach({ emit: () => {}, followUp: (message) => followUps.push(message) });

    await runtime.connect(signal());
    const before = await runtime.use((d) => d.observe({}, signal()), signal());
    const beforeConnectionId = runtime.status().connectionId;
    const [beforeElement] = before.elements;
    if (beforeElement === undefined) throw new Error("the landing page has no elements");
    const staleRef = {
      ref: beforeElement.ref,
      revision: beforeElement.revision,
      tabId: beforeElement.tabId,
    };

    driver.simulateConnectionLoss(code);
    let caught: unknown;
    try {
      await runtime.use((d) => d.observe({}, signal()), signal());
    } catch (error) {
      caught = error;
    }

    // A typed failure the caller can branch on, not a generic Error or a hang.
    expect(isBrowserDriverError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe(code);
    // Landed somewhere the session can describe, and it told the model to reconnect.
    expect(runtime.status().phase).toBe("reconnecting");
    expect(followUps.join(" ")).toContain("connection was lost");

    const reconnected = await runtime.reconnect(signal());
    expect(runtime.status().phase).toBe("ready");
    const afterConnectionId = runtime.status().connectionId;
    expect(afterConnectionId).toBeDefined();
    // Reconnecting is new identity, not the same connection picked back up.
    expect(afterConnectionId).not.toBe(beforeConnectionId);

    // A reference minted before the crash names a tab that no longer exists on the
    // reconnected driver — it must be refused, never silently misdirected onto
    // whatever tab now happens to be first.
    const outcome = await reconnected.act({ kind: "click", target: staleRef }, signal());
    expect(outcome.status).toBe("stale");

    // The reconnected driver is fully usable: a fresh observation mints fresh refs.
    const after = await runtime.use((d) => d.observe({}, signal()), signal());
    const [afterElement] = after.elements;
    expect(afterElement).toBeDefined();
    expect(afterElement?.tabId).not.toBe(staleRef.tabId);
  });
});

describe("a crash while a driver ref is already in flight never leaves the runtime unable to describe itself", () => {
  test("act() itself throwing browser-crashed still lands the runtime in reconnecting", async () => {
    const { driver, factory } = attachedFactory();
    const runtime = new BrowserRuntime({
      factory,
      connection: "extension",
      browser: "chrome",
      dataRoot: "/unused",
    });
    await runtime.connect(signal());
    driver.failNext("browser-crashed", "the tab process died");
    let caught: unknown;
    try {
      await runtime.use((d) => d.act({ kind: "scroll", deltaX: 0, deltaY: 1 }, signal()), signal());
    } catch (error) {
      caught = error;
    }
    expect(isBrowserDriverError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("browser-crashed");
    expect(runtime.status().phase).toBe("reconnecting");
    expect(runtime.status().message).toContain("tab process died");
  });
});
