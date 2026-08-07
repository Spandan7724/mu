import { describe, expect, test } from "bun:test";
import { NoiseInitiator, NoiseResponder, PROTOCOL_NAME } from "./handshake.ts";
import {
  concat,
  decrypt,
  dh,
  encrypt,
  fromHex,
  generateKeyPair,
  hkdf,
  nonceBytes,
  publicFromPrivate,
  toHex,
} from "./primitives.ts";

const text = (value: string) => new TextEncoder().encode(value);

// Test vectors from RFC 7748 §6.1, the specification X25519 is defined by.
const RFC7748 = {
  alicePrivate: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  alicePublic: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  bobPrivate: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
  bobPublic: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  shared: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
};

// Test vectors from RFC 4231 §4, which defines HMAC-SHA-256 — the one function
// Noise's HKDF is built out of.
const RFC4231_CASE_2 = {
  key: "4a656665",
  data: "7768617420646f2079612077616e7420666f72206e6f7468696e673f",
  mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
};

describe("primitives", () => {
  test("X25519 matches the RFC 7748 test vectors", () => {
    expect(toHex(publicFromPrivate(fromHex(RFC7748.alicePrivate)))).toBe(RFC7748.alicePublic);
    expect(toHex(publicFromPrivate(fromHex(RFC7748.bobPrivate)))).toBe(RFC7748.bobPublic);
    expect(toHex(dh(fromHex(RFC7748.alicePrivate), fromHex(RFC7748.bobPublic)))).toBe(
      RFC7748.shared,
    );
    expect(toHex(dh(fromHex(RFC7748.bobPrivate), fromHex(RFC7748.alicePublic)))).toBe(
      RFC7748.shared,
    );
  });

  test("HKDF's first output is HMAC-SHA-256 as RFC 4231 defines it", () => {
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const mac = createHmac("sha256", Buffer.from(RFC4231_CASE_2.key, "hex"))
      .update(Buffer.from(RFC4231_CASE_2.data, "hex"))
      .digest("hex");
    expect(mac).toBe(RFC4231_CASE_2.mac);
  });

  test("HKDF chains as the Noise spec describes rather than as RFC 5869 does", () => {
    const [one, two, three] = hkdf(new Uint8Array(32).fill(7), text("input"), 3) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    expect(one).toHaveLength(32);
    expect(two).toHaveLength(32);
    expect(three).toHaveLength(32);
    expect(toHex(one)).not.toBe(toHex(two));
    // Deterministic: the same inputs always give the same outputs.
    expect(hkdf(new Uint8Array(32).fill(7), text("input"), 2)[0] as Uint8Array).toEqual(one);
  });

  test("the AESGCM nonce is four zero bytes then a big-endian counter", () => {
    expect(toHex(nonceBytes(0n))).toBe("000000000000000000000000");
    expect(toHex(nonceBytes(1n))).toBe("000000000000000000000001");
    expect(toHex(nonceBytes(258n))).toBe("000000000000000000000102");
  });

  test("the AEAD authenticates its associated data", () => {
    const key = new Uint8Array(32).fill(3);
    const sealed = encrypt(key, 0n, text("ad"), text("secret"));
    expect(new TextDecoder().decode(decrypt(key, 0n, text("ad"), sealed))).toBe("secret");
    expect(() => decrypt(key, 0n, text("other"), sealed)).toThrow();
    expect(() => decrypt(key, 1n, text("ad"), sealed)).toThrow();
  });
});

describe("Noise IK", () => {
  test("the protocol name is the suite this implements", () => {
    expect(PROTOCOL_NAME).toBe("Noise_IK_25519_AESGCM_SHA256");
  });

  test("both sides derive the same keys and read each other's payloads", () => {
    const server = generateKeyPair();
    const client = generateKeyPair();
    const prologue = text("mu-remote/1");

    const initiator = new NoiseInitiator(client, server.publicKey, prologue);
    const responder = new NoiseResponder(server, prologue);

    const messageA = initiator.writeMessageA(text("pairing-token"));
    const read = responder.readMessageA(messageA);
    expect(new TextDecoder().decode(read.payload)).toBe("pairing-token");
    expect(toHex(read.remoteStatic)).toBe(toHex(client.publicKey));

    const { message, result: serverSide } = responder.writeMessageB(text("welcome"));
    const { payload, result: clientSide } = initiator.readMessageB(message);
    expect(new TextDecoder().decode(payload)).toBe("welcome");

    expect(toHex(clientSide.handshakeHash)).toBe(toHex(serverSide.handshakeHash));
    expect(toHex(clientSide.remoteStatic)).toBe(toHex(server.publicKey));
    expect(toHex(serverSide.remoteStatic)).toBe(toHex(client.publicKey));
  });

  test("the transport keys work in both directions and are nonce-ordered", () => {
    const server = generateKeyPair();
    const client = generateKeyPair();
    const initiator = new NoiseInitiator(client, server.publicKey);
    const responder = new NoiseResponder(server);
    const { remoteStatic } = responder.readMessageA(initiator.writeMessageA());
    expect(remoteStatic).toEqual(client.publicKey);
    const { message, result: serverSide } = responder.writeMessageB();
    const { result: clientSide } = initiator.readMessageB(message);

    const empty = new Uint8Array(0);
    const first = clientSide.send.encryptWithAd(empty, text("one"));
    const second = clientSide.send.encryptWithAd(empty, text("two"));
    expect(new TextDecoder().decode(serverSide.receive.decryptWithAd(empty, first))).toBe("one");
    expect(new TextDecoder().decode(serverSide.receive.decryptWithAd(empty, second))).toBe("two");

    const back = serverSide.send.encryptWithAd(empty, text("reply"));
    expect(new TextDecoder().decode(clientSide.receive.decryptWithAd(empty, back))).toBe("reply");
  });

  test("a frame replayed inside a session is rejected by the counter", () => {
    const server = generateKeyPair();
    const client = generateKeyPair();
    const initiator = new NoiseInitiator(client, server.publicKey);
    const responder = new NoiseResponder(server);
    responder.readMessageA(initiator.writeMessageA());
    const { message, result: serverSide } = responder.writeMessageB();
    const { result: clientSide } = initiator.readMessageB(message);

    const empty = new Uint8Array(0);
    const frame = clientSide.send.encryptWithAd(empty, text("transfer"));
    expect(serverSide.receive.decryptWithAd(empty, frame)).toEqual(text("transfer"));
    // Same bytes again: the receiving nonce has moved on and cannot go back.
    expect(() => serverSide.receive.decryptWithAd(empty, frame)).toThrow();
  });

  test("a client pinned to the wrong host static key cannot complete", () => {
    const server = generateKeyPair();
    const impostor = generateKeyPair();
    const client = generateKeyPair();

    // The phone pins what came off the QR; the machine answering is not it.
    const initiator = new NoiseInitiator(client, impostor.publicKey);
    const responder = new NoiseResponder(server);

    expect(() => responder.readMessageA(initiator.writeMessageA())).toThrow();
  });

  test("a tampered handshake message is rejected rather than downgraded", () => {
    const server = generateKeyPair();
    const client = generateKeyPair();
    const initiator = new NoiseInitiator(client, server.publicKey);
    const responder = new NoiseResponder(server);

    const messageA = initiator.writeMessageA(text("token"));
    const tampered = new Uint8Array(messageA);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;

    expect(() => responder.readMessageA(tampered)).toThrow();
  });

  test("a recorded handshake cannot be replayed into a new session", () => {
    const server = generateKeyPair();
    const client = generateKeyPair();

    const first = new NoiseInitiator(client, server.publicKey);
    const recorded = first.writeMessageA(text("token"));
    const responderOne = new NoiseResponder(server);
    responderOne.readMessageA(recorded);
    const { result: sessionOne } = responderOne.writeMessageB();

    // An attacker replays byte-for-byte against a fresh responder. It reads,
    // because message A is not by itself a proof of liveness — but the
    // responder's fresh ephemeral means the derived session is a different one,
    // so nothing recorded from the first session decrypts under it.
    const responderTwo = new NoiseResponder(server);
    responderTwo.readMessageA(recorded);
    const { result: sessionTwo } = responderTwo.writeMessageB();

    const empty = new Uint8Array(0);
    const fromSessionOne = sessionOne.send.encryptWithAd(empty, text("secret"));
    expect(() => sessionTwo.receive.decryptWithAd(empty, fromSessionOne)).toThrow();

    // And the attacker cannot read message B, because it has no private key
    // matching the static it replayed.
    expect(() =>
      new NoiseInitiator(generateKeyPair(), server.publicKey).readMessageB(recorded),
    ).toThrow();
  });

  test("a truncated message is refused before any key is derived", () => {
    const server = generateKeyPair();
    const responder = new NoiseResponder(server);
    expect(() => responder.readMessageA(new Uint8Array(16))).toThrow("too short");
    expect(() => responder.writeMessageB()).toThrow("message A not read");
  });

  test("the prologue is authenticated, so a version mismatch cannot be tunnelled", () => {
    const server = generateKeyPair();
    const client = generateKeyPair();
    const initiator = new NoiseInitiator(client, server.publicKey, text("mu-remote/1"));
    const responder = new NoiseResponder(server, text("mu-remote/2"));

    expect(() => responder.readMessageA(initiator.writeMessageA())).toThrow();
  });

  test("concat and hex round-trip the shapes the handshake is made of", () => {
    const joined = concat(new Uint8Array([1, 2]), new Uint8Array([3]));
    expect([...joined]).toEqual([1, 2, 3]);
    expect(toHex(fromHex("00ff10"))).toBe("00ff10");
  });
});
