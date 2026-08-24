import { describe, expect, test } from "bun:test";
import { serializeTransportWrites } from "./client.ts";

describe("MCP stdio writes", () => {
  test("serializes backpressured writes, including cancellation bursts", async () => {
    let active = 0;
    let peak = 0;
    const started: unknown[] = [];
    let releaseFirst = () => {};
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transport = serializeTransportWrites({
      async send(message: unknown) {
        active += 1;
        peak = Math.max(peak, active);
        started.push(message);
        if (started.length === 1) await firstWrite;
        await Promise.resolve();
        active -= 1;
      },
    });

    const writes = Array.from({ length: 20 }, (_, index) =>
      transport.send({ method: index === 0 ? "tools/call" : "notifications/cancelled", index }),
    );
    await Promise.resolve();
    expect(started).toHaveLength(1);

    releaseFirst();
    await Promise.all(writes);

    expect(peak).toBe(1);
    expect(started).toHaveLength(20);
  });

  test("a failed write does not poison later writes", async () => {
    const sent: number[] = [];
    const transport = serializeTransportWrites({
      async send(message: unknown) {
        const value = message as number;
        sent.push(value);
        if (value === 1) throw new Error("closed");
      },
    });

    await expect(transport.send(1)).rejects.toThrow("closed");
    await expect(transport.send(2)).resolves.toBeUndefined();
    expect(sent).toEqual([1, 2]);
  });
});
