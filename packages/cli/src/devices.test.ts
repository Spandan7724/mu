import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore, generateKeyPair } from "@mu/server";
import { parseArgs } from "./args.ts";
import { formatDevices, formatLastSeen, runDevices } from "./devices.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function storeIn() {
  const dir = await mkdtemp(join(tmpdir(), "mu-devices-cli-"));
  directories.push(dir);
  const path = join(dir, "devices.json");
  const store = new DeviceStore({ path });
  await store.load();
  return { store, path };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (chunk: string) => out.push(chunk), stderr: (chunk: string) => err.push(chunk) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

const NOW = Date.parse("2026-08-07T12:00:00.000Z");

describe("mu devices arguments", () => {
  test("bare, list and revoke all parse", () => {
    expect(parseArgs(["devices"])).toMatchObject({ mode: "devices", devicesAction: "list" });
    expect(parseArgs(["devices", "list"])).toMatchObject({
      mode: "devices",
      devicesAction: "list",
    });
    expect(parseArgs(["devices", "revoke", "d_1"])).toMatchObject({
      mode: "devices",
      devicesAction: "revoke",
      deviceId: "d_1",
    });
  });

  test("a revoke with no id, or an unknown subcommand, is a usage error", () => {
    expect(parseArgs(["devices", "revoke"]).errors).toEqual([
      "devices revoke requires a device id",
    ]);
    expect(parseArgs(["devices", "wat"]).errors).toEqual([
      'devices expects "list" or "revoke <id>"',
    ]);
  });
});

describe("mu devices list", () => {
  test("lists each device with its fingerprint, enrolment date and last-seen", async () => {
    const { store, path } = await storeIn();
    const phone = store.enroll(generateKeyPair().publicKey, "pixel");
    store.touch(phone.id);
    store.enroll(generateKeyPair().publicKey, "ipad");
    await store.flush();

    const sink = io();
    const code = await runDevices(parseArgs(["devices"]), sink.io, { path, now: () => NOW });

    expect(code).toBe(0);
    const text = sink.stdout();
    expect(text).toContain(`pixel  ${phone.id}`);
    expect(text).toContain("ipad");
    expect(text).toContain("enrolled ");
    expect(text).toContain("last seen just now");
    expect(text).toContain("never connected");
    // The fingerprint is shown so it can be checked against the phone.
    expect(text).toMatch(/[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}/);
  });

  test("says so plainly when nothing is paired, and points at what to run", async () => {
    const { path } = await storeIn();
    const sink = io();

    expect(await runDevices(parseArgs(["devices"]), sink.io, { path })).toBe(0);
    expect(sink.stdout()).toContain("No paired devices.");
    expect(sink.stdout()).toContain("mu share");
  });

  test("last-seen reads in the units the answer is actually in", () => {
    expect(formatLastSeen(undefined, NOW)).toBe("never connected");
    expect(formatLastSeen(new Date(NOW - 30_000).toISOString(), NOW)).toBe("last seen just now");
    expect(formatLastSeen(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("last seen 5m ago");
    expect(formatLastSeen(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe(
      "last seen 3h ago",
    );
    expect(formatLastSeen(new Date(NOW - 4 * 86_400_000).toISOString(), NOW)).toBe(
      "last seen 4d ago",
    );
  });

  test("the empty listing is not padded with blank rows", () => {
    expect(formatDevices([], NOW).filter((line) => line.length > 0)).toHaveLength(2);
  });
});

describe("mu devices revoke", () => {
  test("removes the device and says which one went", async () => {
    const { store, path } = await storeIn();
    const phone = store.enroll(generateKeyPair().publicKey, "pixel");
    const tablet = store.enroll(generateKeyPair().publicKey, "ipad");
    await store.flush();

    const sink = io();
    const code = await runDevices(parseArgs(["devices", "revoke", phone.id]), sink.io, { path });

    expect(code).toBe(0);
    expect(sink.stdout()).toContain(`Revoked pixel (${phone.id}).`);
    expect(sink.stdout()).toContain("dropped by the mu instance serving it");

    const reopened = new DeviceStore({ path });
    await reopened.load();
    expect(reopened.list().map((device) => device.id)).toEqual([tablet.id]);
  });

  test("an unknown id is a usage error, not a silent success", async () => {
    const { path } = await storeIn();
    const sink = io();

    expect(await runDevices(parseArgs(["devices", "revoke", "d_nope"]), sink.io, { path })).toBe(2);
    expect(sink.stderr()).toContain("no paired device with id d_nope");
    expect(sink.stdout()).toBe("");
  });

  test("a revoke in another process reaches the instance holding the socket", async () => {
    const { store, path } = await storeIn();
    const phone = store.enroll(generateKeyPair().publicKey, "pixel");
    await store.flush();

    // The serving instance has the file open and watches it.
    const serving = new DeviceStore({ path });
    await serving.load();
    const revoked: string[] = [];
    const stop = serving.watch((ids) => revoked.push(...ids));

    try {
      await runDevices(parseArgs(["devices", "revoke", phone.id]), io().io, { path });
      for (let attempt = 0; attempt < 100 && revoked.length === 0; attempt++) {
        await Bun.sleep(10);
      }
      expect(revoked).toEqual([phone.id]);
      // And the serving instance's own view is now current.
      expect(serving.list()).toEqual([]);
    } finally {
      stop();
    }
  });
});
