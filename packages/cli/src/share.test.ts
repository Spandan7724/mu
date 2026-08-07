import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { decodeServerFrame, PROTOCOL_VERSION, type ServerFrame } from "@mu/protocol";
import {
  DeviceStore,
  decodePairingUrl,
  generateKeyPair,
  NoiseInitiator,
  prologue,
  SessionHost,
} from "@mu/server";
import { Agent } from "mu";
import { parseArgs } from "./args.ts";
import {
  exposureWarning,
  pairingBlock,
  type Sharing,
  shareAddress,
  startSharing,
} from "./share.ts";

const open: Sharing[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((sharing) => sharing.stop().catch(() => {})));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (chunk: string) => out.push(chunk), stderr: (chunk: string) => err.push(chunk) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

async function hostAndDevices() {
  const dir = await mkdtemp(join(tmpdir(), "mu-share-"));
  directories.push(dir);
  let host: SessionHost | undefined;
  const agent = new Agent({
    provider: new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]),
    model: fakeModel,
    onPermission: (request: PermissionRequest) =>
      host ? host.onPermission(request) : Promise.resolve<"allow" | "deny">("deny"),
  });
  host = new SessionHost({ agent, workspace: { name: "app", root: "/home/x/app" } });
  return { agent, host, devicesPath: join(dir, "devices.json") };
}

describe("mu share arguments", () => {
  test("the subcommand and the flag are the same thing", () => {
    expect(parseArgs(["share"])).toMatchObject({ mode: "tui", share: true });
    expect(parseArgs(["--share"])).toMatchObject({ mode: "tui", share: true });
  });

  test("without it, nothing is shared", () => {
    expect(parseArgs([]).share).toBe(false);
  });

  test("a specific interface can be named, and requires a value", () => {
    expect(parseArgs(["share", "--interface", "10.0.0.5"]).shareInterface).toBe("10.0.0.5");
    expect(parseArgs(["--interface"]).errors).toEqual(["--interface requires an address"]);
  });
});

describe("what mu share prints", () => {
  test("the warning names the address and what it means", () => {
    const warning = exposureWarning("192.168.1.20").join("\n");
    expect(warning).toContain("exposes this session to your local network");
    expect(warning).toContain("192.168.1.20");
    expect(warning).toContain("only a device");
    expect(warning).toContain("open shell");
  });

  test("the pairing block carries a scannable code, the url and the fingerprint", () => {
    const key = new Uint8Array(32).fill(0x2b);
    const url = "mu://pair?h=abc&t=def&a=192.168.1.20:51820";
    const block = pairingBlock(url, key, "192.168.1.20:51820");
    const text = block.join("\n");

    expect(text).toContain(url);
    expect(text).toContain("2B2B 2B2B 2B2B 2B2B");
    expect(text).toContain("Listening on 192.168.1.20:51820");
    expect(text).toContain("single-use and expires in 60 seconds");
    // The QR itself: square, and drawn in full-width blocks.
    const qr = block.filter((line) => line.includes("█"));
    expect(qr.length).toBeGreaterThan(20);
    expect(new Set(qr.map((line) => line.length)).size).toBe(1);
  });

  test("a named interface wins over the discovered one", () => {
    expect(shareAddress("10.1.2.3")).toBe("10.1.2.3");
  });
});

describe("sharing over the LAN", () => {
  test("binds a specific interface on an ephemeral port and pairs a phone", async () => {
    const { host, agent, devicesPath } = await hostAndDevices();
    const sink = io();

    const sharing = await startSharing(
      {
        host,
        hostName: "workstation",
        version: "0.0.4",
        protocol: PROTOCOL_VERSION,
        bindAddress: "127.0.0.1",
        devicesPath,
        // The advertisement is exercised in the mdns tests; a real multicast
        // join is not what this one is about.
        advertise: false,
      },
      sink.io,
    );
    open.push(sharing);

    // Never 0.0.0.0, and never a fixed port.
    expect(sharing.server.hostname).toBe("127.0.0.1");
    expect(sharing.server.port).toBeGreaterThan(0);
    expect(sink.stderr()).toContain("exposes this session to your local network");

    const invite = decodePairingUrl(sharing.url);
    expect(invite?.address).toBe(`127.0.0.1:${sharing.server.port}`);

    // A phone scans the code and completes the handshake over the LAN socket.
    const phone = generateKeyPair();
    const socket = new WebSocket(`ws://${invite?.address}`);
    socket.binaryType = "arraybuffer";
    const inbound: ArrayBuffer[] = [];
    socket.addEventListener("message", (event) => inbound.push(event.data as ArrayBuffer));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("connect failed")));
    });

    const initiator = new NoiseInitiator(phone, invite?.hostKey as Uint8Array, prologue());
    socket.send(
      initiator.writeMessageA(
        new TextEncoder().encode(JSON.stringify({ token: invite?.token, deviceName: "pixel" })),
      ),
    );
    for (let attempt = 0; attempt < 200 && inbound.length === 0; attempt++) await Bun.sleep(5);
    const { result } = initiator.readMessageB(new Uint8Array(inbound.shift() as ArrayBuffer));

    for (let attempt = 0; attempt < 200 && inbound.length === 0; attempt++) await Bun.sleep(5);
    const frames: ServerFrame[] = inbound.splice(0).map((data) => {
      const line = new TextDecoder().decode(
        result.receive.decryptWithAd(new Uint8Array(0), new Uint8Array(data)),
      );
      const decoded = decodeServerFrame(line);
      if (!decoded.ok) throw new Error(line);
      return decoded.value;
    });
    const hello = frames.find((frame) => frame.t === "hello");
    expect(hello?.t === "hello" && hello.protocol).toBe(PROTOCOL_VERSION);
    expect(hello?.t === "hello" && hello.host.name).toBe("workstation");

    // The device is now enrolled machine-wide, so any mu on this box takes it.
    await sharing.devices.flush();
    const elsewhere = new DeviceStore({ path: devicesPath });
    await elsewhere.load();
    expect(elsewhere.list().map((device) => device.name)).toEqual(["pixel"]);
    expect(elsewhere.hostPublicKey).toEqual(sharing.devices.hostPublicKey);
    expect(agent.sessionId).toBeDefined();
    socket.close();
  }, 20_000);

  test("a revocation from another process drops the connection this one holds", async () => {
    const { host, devicesPath } = await hostAndDevices();
    const sink = io();
    const sharing = await startSharing(
      {
        host,
        hostName: "workstation",
        version: "0.0.4",
        protocol: PROTOCOL_VERSION,
        bindAddress: "127.0.0.1",
        devicesPath,
        advertise: false,
      },
      sink.io,
    );
    open.push(sharing);

    const phone = generateKeyPair();
    const enrolled = sharing.devices.enroll(phone.publicKey, "pixel");
    await sharing.devices.flush();

    const socket = new WebSocket(`ws://127.0.0.1:${sharing.server.port}`);
    socket.binaryType = "arraybuffer";
    const inbound: ArrayBuffer[] = [];
    let closed = false;
    socket.addEventListener("message", (event) => inbound.push(event.data as ArrayBuffer));
    socket.addEventListener("close", () => {
      closed = true;
    });
    await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
    const initiator = new NoiseInitiator(phone, sharing.devices.hostPublicKey, prologue());
    socket.send(initiator.writeMessageA());
    for (let attempt = 0; attempt < 200 && inbound.length === 0; attempt++) await Bun.sleep(5);
    initiator.readMessageB(new Uint8Array(inbound.shift() as ArrayBuffer));

    // Another process revokes it; this one is watching the store.
    const other = new DeviceStore({ path: devicesPath });
    await other.load();
    await other.revoke(enrolled.id);

    for (let attempt = 0; attempt < 300 && !closed; attempt++) await Bun.sleep(10);
    expect(closed).toBe(true);
    socket.close();
  }, 20_000);
});
