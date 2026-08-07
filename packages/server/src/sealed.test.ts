import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { decodeServerFrame, encodeFrame, type Op, type ServerFrame } from "@mu/protocol";
import { Agent } from "mu";
import { DeviceStore } from "./devices.ts";
import { NoiseInitiator } from "./noise/handshake.ts";
import { generateKeyPair, type KeyPair } from "./noise/primitives.ts";
import type { CipherState } from "./noise/state.ts";
import { decodePairingUrl, encodePairingUrl } from "./pairing.ts";
import { encodePairingPayload, prologue, SealedChannel } from "./sealed-channel.ts";
import { type RunningServer, serve } from "./server.ts";
import { SessionHost } from "./session-host.ts";

const running: RunningServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function storeIn(): Promise<{ devices: DeviceStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "mu-devices-"));
  directories.push(dir);
  const path = join(dir, "devices.json");
  const devices = new DeviceStore({ path });
  await devices.load();
  return { devices, path };
}

async function start(devices: DeviceStore, provider = new FakeProvider([])) {
  let host: SessionHost | undefined;
  const agent = new Agent({
    provider,
    model: fakeModel,
    onPermission: (request: PermissionRequest) =>
      host ? host.onPermission(request) : Promise.resolve<"allow" | "deny">("deny"),
  });
  host = new SessionHost({ agent, workspace: { name: "app", root: "/home/x/app" } });
  const refusals: string[] = [];
  const server = serve({
    host,
    hostName: "workstation",
    version: "0.0.4",
    channel: () => new SealedChannel({ devices, onRefused: (reason) => refusals.push(reason) }),
  });
  running.push(server);
  return { agent, host, server, refusals };
}

// A client that speaks the same sealed wire the app will: Noise IK over the
// socket, then sealed frames. Nothing about it is a shortcut for tests.
async function connectSealed(
  server: RunningServer,
  keys: KeyPair,
  hostKey: Uint8Array,
  payload?: Uint8Array,
) {
  const socket = new WebSocket(server.url);
  socket.binaryType = "arraybuffer";
  const inbound: (ArrayBuffer | string)[] = [];
  const frames: ServerFrame[] = [];
  let transport: { send: CipherState; receive: CipherState } | undefined;

  const accept = (data: ArrayBuffer | string) => {
    const open = transport as { receive: CipherState };
    const line = new TextDecoder().decode(
      open.receive.decryptWithAd(new Uint8Array(0), new Uint8Array(data as ArrayBuffer)),
    );
    const decoded = decodeServerFrame(line);
    if (!decoded.ok) throw new Error(`unparseable: ${line}`);
    frames.push(decoded.value);
  };
  socket.addEventListener("message", (event) => {
    const data = event.data as ArrayBuffer | string;
    // Frames sent between the handshake reply and finish() being awaited are
    // held in order and opened once the transport keys exist.
    if (!transport) inbound.push(data);
    else accept(data);
  });
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("connect failed")));
  });

  const initiator = new NoiseInitiator(keys, hostKey, prologue());
  socket.send(initiator.writeMessageA(payload));

  const until = async <T>(pick: () => T | undefined, label: string): Promise<T> => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const found = pick();
      if (found !== undefined) return found;
      await Bun.sleep(5);
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  return {
    socket,
    frames,
    closed,
    until,
    // Resolves once the handshake completes, or rejects if the host refused.
    finish: async () => {
      const reply = await until(() => inbound.shift(), "handshake reply");
      const { result } = initiator.readMessageB(new Uint8Array(reply as ArrayBuffer));
      transport = { send: result.send, receive: result.receive };
      while (inbound.length > 0) accept(inbound.shift() as ArrayBuffer);
      return result;
    },
    send: (frame: unknown) => {
      if (!transport) throw new Error("not established");
      socket.send(
        transport.send.encryptWithAd(
          new Uint8Array(0),
          new TextEncoder().encode(encodeFrame(frame as never)),
        ),
      );
    },
    op: (id: string, op: Op) => ({ t: "op" as const, id, op }),
  };
}

describe("device store", () => {
  test("writes 0600 with an atomic rename, and reloads what it wrote", async () => {
    const { devices, path } = await storeIn();
    const phone = generateKeyPair();
    const enrolled = devices.enroll(phone.publicKey, "pixel");
    await devices.flush();

    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    const reopened = new DeviceStore({ path });
    await reopened.load();
    expect(reopened.list().map((device) => device.id)).toEqual([enrolled.id]);
    expect(reopened.find(phone.publicKey)?.name).toBe("pixel");
    // The machine's own static key survives, so pairing is machine-scoped.
    expect(reopened.hostPublicKey).toEqual(devices.hostPublicKey);
    expect(reopened.hostId).toBe(devices.hostId);
  });

  test("a pairing token is one-time and expires after sixty seconds", async () => {
    let clock = 1_000_000;
    const dir = await mkdtemp(join(tmpdir(), "mu-devices-"));
    directories.push(dir);
    const devices = new DeviceStore({ path: join(dir, "devices.json"), now: () => clock });
    await devices.load();

    const token = devices.issuePairingToken();
    expect(devices.redeemPairingToken(token)).toEqual({ ok: true });
    expect(devices.redeemPairingToken(token)).toEqual({
      ok: false,
      reason: "pairing token already used",
    });

    const second = devices.issuePairingToken();
    clock += 60_001;
    expect(devices.redeemPairingToken(second)).toEqual({
      ok: false,
      reason: "pairing token expired",
    });
    expect(devices.redeemPairingToken("never issued")).toEqual({
      ok: false,
      reason: "unknown pairing token",
    });
  });

  test("revoking removes the device and lists what remains", async () => {
    const { devices } = await storeIn();
    const a = devices.enroll(generateKeyPair().publicKey, "phone");
    const b = devices.enroll(generateKeyPair().publicKey, "tablet");
    devices.touch(a.id);
    await devices.flush();

    expect(devices.list().map((device) => device.name)).toEqual(["phone", "tablet"]);
    expect(devices.list()[0]?.lastSeenAt).toBeDefined();
    expect((await devices.revoke(a.id))?.id).toBe(a.id);
    expect(devices.list().map((device) => device.id)).toEqual([b.id]);
    expect(await devices.revoke("d_nope")).toBeUndefined();
  });

  test("a corrupt file is replaced rather than left blocking every connection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mu-devices-"));
    directories.push(dir);
    const path = join(dir, "devices.json");
    await Bun.write(path, "{ not json");

    const devices = new DeviceStore({ path });
    await devices.load();
    expect(devices.list()).toEqual([]);
    expect(devices.hostPublicKey).toHaveLength(32);
  });
});

describe("pairing over a sealed connection", () => {
  test("QR to handshake to enrolment, and the token is consumed", async () => {
    const { devices } = await storeIn();
    const { server, agent } = await start(devices);

    const url = encodePairingUrl({
      hostKey: devices.hostPublicKey,
      token: devices.issuePairingToken(),
      address: `${server.hostname}:${server.port}`,
    });
    const invite = decodePairingUrl(url);
    expect(invite).toBeDefined();

    const phone = generateKeyPair();
    const client = await connectSealed(
      server,
      phone,
      invite?.hostKey as Uint8Array,
      encodePairingPayload({ token: invite?.token as string, deviceName: "pixel" }),
    );
    await client.finish();

    const hello = await client.until(
      () => client.frames.find((frame) => frame.t === "hello"),
      "hello",
    );
    expect(hello.t === "hello" && hello.host.name).toBe("workstation");
    await devices.flush();
    expect(devices.list().map((device) => device.name)).toEqual(["pixel"]);

    // Sealed frames carry real work in both directions.
    client.send(client.op("1", { k: "input", text: "go" }));
    const reply = await client.until(
      () => client.frames.find((frame) => frame.t === "reply" && frame.id === "1"),
      "reply",
    );
    expect(reply.t === "reply" && reply.ok).toBe(true);
    expect(agent.session.messagesAt().length).toBeGreaterThan(0);

    // A second use of the same token gets nowhere.
    const impostor = generateKeyPair();
    const second = await connectSealed(
      server,
      impostor,
      devices.hostPublicKey,
      encodePairingPayload({ token: invite?.token as string, deviceName: "thief" }),
    );
    await second.closed;
    expect(second.frames).toEqual([]);
    await devices.flush();
    expect(devices.list().map((device) => device.name)).toEqual(["pixel"]);
  });

  test("an enrolled device reconnects on its key alone, with no token", async () => {
    const { devices } = await storeIn();
    const phone = generateKeyPair();
    devices.enroll(phone.publicKey, "pixel");
    await devices.flush();
    const { server } = await start(devices);

    const client = await connectSealed(server, phone, devices.hostPublicKey);
    await client.finish();

    expect(
      (await client.until(() => client.frames.find((frame) => frame.t === "hello"), "hello")).t,
    ).toBe("hello");
  });

  test("an unpaired key is rejected: no event, no op, no enrolment", async () => {
    const { devices } = await storeIn();
    const { server, refusals, agent } = await start(devices);

    const stranger = generateKeyPair();
    const client = await connectSealed(server, stranger, devices.hostPublicKey);
    await client.closed;

    expect(client.frames).toEqual([]);
    expect(refusals).toEqual(["unpaired key"]);
    await devices.flush();
    expect(devices.list()).toEqual([]);
    expect(agent.session.messagesAt()).toEqual([]);
  });

  test("a client pinned to a different host key never establishes", async () => {
    const { devices } = await storeIn();
    const phone = generateKeyPair();
    devices.enroll(phone.publicKey, "pixel");
    await devices.flush();
    const { server } = await start(devices);

    // The QR said one key; the machine answering has another.
    const impostorKey = generateKeyPair().publicKey;
    const client = await connectSealed(server, phone, impostorKey);
    await client.closed;

    expect(client.frames).toEqual([]);
  });

  test("a replayed handshake cannot drive the session it was recorded from", async () => {
    const { devices } = await storeIn();
    const phone = generateKeyPair();
    devices.enroll(phone.publicKey, "pixel");
    await devices.flush();
    const { server, agent } = await start(devices);

    const initiator = new NoiseInitiator(phone, devices.hostPublicKey, prologue());
    const recorded = initiator.writeMessageA();

    const first = new WebSocket(server.url);
    first.binaryType = "arraybuffer";
    const firstReply = new Promise<ArrayBuffer>((resolve) => {
      first.addEventListener("message", (event) => resolve(event.data as ArrayBuffer));
    });
    await new Promise<void>((resolve) => first.addEventListener("open", () => resolve()));
    first.send(recorded);
    const established = initiator.readMessageB(new Uint8Array(await firstReply));

    // Replay the exact bytes on a new connection. The host answers, because
    // message A alone is not a proof of liveness — but its fresh ephemeral
    // makes this a different session that the recording cannot reach into.
    const second = new WebSocket(server.url);
    second.binaryType = "arraybuffer";
    const received: ArrayBuffer[] = [];
    let closeCode = 0;
    second.addEventListener("message", (event) => received.push(event.data as ArrayBuffer));
    second.addEventListener("close", (event) => {
      closeCode = event.code;
    });
    await new Promise<void>((resolve) => second.addEventListener("open", () => resolve()));
    second.send(recorded);
    await Bun.sleep(40);
    expect(received.length).toBeGreaterThan(0);

    // Whatever the host said is unreadable to the attacker: it holds no private
    // key matching the static it replayed.
    expect(() =>
      established.result.receive.decryptWithAd(
        new Uint8Array(0),
        new Uint8Array(received[1] as ArrayBuffer),
      ),
    ).toThrow();

    // And a frame recorded from the real session lands no op on the replayed
    // one; the host drops the connection instead.
    const sealed = established.result.send.encryptWithAd(
      new Uint8Array(0),
      new TextEncoder().encode(
        encodeFrame({ t: "op", id: "1", op: { k: "input", text: "replayed" } }),
      ),
    );
    second.send(sealed);
    await Bun.sleep(60);

    expect(closeCode).toBe(1008);
    expect(agent.session.messagesAt()).toEqual([]);
    first.close();
  });

  test("revoking a device drops its live connection, not just future ones", async () => {
    const { devices } = await storeIn();
    const phone = generateKeyPair();
    const enrolled = devices.enroll(phone.publicKey, "pixel");
    await devices.flush();
    const { server } = await start(devices);

    const client = await connectSealed(server, phone, devices.hostPublicKey);
    await client.finish();
    await client.until(() => client.frames.find((frame) => frame.t === "hello"), "hello");

    await devices.revoke(enrolled.id);
    server.disconnect(
      "revoked",
      (origin) => origin.kind === "remote" && origin.deviceId === enrolled.id,
    );

    const bye = await client.until(() => client.frames.find((frame) => frame.t === "bye"), "bye");
    expect(bye).toEqual({ t: "bye", reason: "revoked" });

    // And the key no longer opens a new one.
    const again = await connectSealed(server, phone, devices.hostPublicKey);
    await again.closed;
    expect(again.frames).toEqual([]);
  });
});
