import { describe, expect, test } from "bun:test";
import { connectionLadder } from "./ladder.ts";
import { PreAuthLimiter } from "./rate-limit.ts";

describe("pre-auth rate limiting", () => {
  test("caps handshake attempts per source", () => {
    let clock = 0;
    const limiter = new PreAuthLimiter({ perSource: 3, windowMs: 1000, now: () => clock });

    expect(limiter.admit("10.0.0.5").ok).toBe(true);
    expect(limiter.admit("10.0.0.5").ok).toBe(true);
    expect(limiter.admit("10.0.0.5").ok).toBe(true);
    const refused = limiter.admit("10.0.0.5");
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toBe("too many handshake attempts");

    // Another source is unaffected: this is a per-source cap, not a global one.
    expect(limiter.admit("10.0.0.6").ok).toBe(true);

    // And the window slides.
    clock += 1001;
    expect(limiter.admit("10.0.0.5").ok).toBe(true);
  });

  test("caps attempts against one token however many sources they come from", () => {
    const limiter = new PreAuthLimiter({ perToken: 2 });
    expect(limiter.admitToken("t")).toBe(true);
    expect(limiter.admitToken("t")).toBe(true);
    expect(limiter.admitToken("t")).toBe(false);
    expect(limiter.admitToken("other")).toBe(true);
  });

  test("a device that authenticates stops counting against the cap", () => {
    const limiter = new PreAuthLimiter({ perSource: 2 });
    limiter.admit("10.0.0.5");
    limiter.admit("10.0.0.5");
    expect(limiter.admit("10.0.0.5").ok).toBe(false);

    limiter.forget("10.0.0.5");
    expect(limiter.admit("10.0.0.5").ok).toBe(true);
  });
});

describe("connection ladder", () => {
  test("falls back in order: mDNS, last known, tunnel, relay", () => {
    const rungs = connectionLadder({
      discovered: [{ address: "192.168.1.20", port: 51820 }],
      lastKnown: { address: "192.168.1.99", port: 51820 },
      tunnel: { address: "workstation.tailnet.ts.net", port: 51820 },
      relay: { address: "relay.example", port: 443 },
    });
    expect(rungs.map((rung) => rung.kind)).toEqual(["mdns", "last-known", "tunnel", "relay"]);
  });

  test("omits rungs that do not exist rather than leaving holes", () => {
    expect(connectionLadder({ lastKnown: { address: "10.0.0.2", port: 1 } })).toEqual([
      { kind: "last-known", address: "10.0.0.2", port: 1 },
    ]);
    expect(connectionLadder({})).toEqual([]);
  });

  test("the same address reached two ways is tried once", () => {
    const rungs = connectionLadder({
      discovered: [{ address: "192.168.1.20", port: 51820 }],
      lastKnown: { address: "192.168.1.20", port: 51820 },
    });
    expect(rungs).toEqual([{ kind: "mdns", address: "192.168.1.20", port: 51820 }]);
  });

  test("several discovered instances all stay, in the order they were seen", () => {
    const rungs = connectionLadder({
      discovered: [
        { address: "192.168.1.20", port: 51820 },
        { address: "192.168.1.21", port: 51821 },
      ],
    });
    expect(rungs.map((rung) => rung.address)).toEqual(["192.168.1.20", "192.168.1.21"]);
  });
});
