import { generateKeyPair, type KeyPair } from "./primitives.ts";
import type { CipherState } from "./state.ts";
import { concat, DHLEN, dh, EMPTY, SymmetricState, TAGLEN } from "./state.ts";

export const PROTOCOL_NAME = "Noise_IK_25519_AESGCM_SHA256";

export interface HandshakeResult {
  send: CipherState;
  receive: CipherState;
  // The peer's static public key: who this connection actually is.
  remoteStatic: Uint8Array;
  handshakeHash: Uint8Array;
}

// Noise_IK:
//   <- s
//   ...
//   -> e, es, s, ss
//   <- e, ee, se
//
// The initiator already knows the responder's static key — it came off a QR the
// user was physically present for, which is what pins the host and blocks MITM
// (SECURITY.md §4). Implemented from the specification; nothing here is
// improvised.
export class NoiseInitiator {
  private readonly symmetric: SymmetricState;
  private readonly ephemeral: KeyPair;
  private done = false;

  constructor(
    private readonly staticKeys: KeyPair,
    private readonly remoteStatic: Uint8Array,
    prologue: Uint8Array = EMPTY,
    ephemeral: KeyPair = generateKeyPair(),
  ) {
    this.ephemeral = ephemeral;
    this.symmetric = new SymmetricState(PROTOCOL_NAME);
    this.symmetric.mixHash(prologue);
    this.symmetric.mixHash(remoteStatic);
  }

  // -> e, es, s, ss
  writeMessageA(payload: Uint8Array = EMPTY): Uint8Array {
    this.symmetric.mixHash(this.ephemeral.publicKey);
    this.symmetric.mixKey(dh(this.ephemeral.privateKey, this.remoteStatic));
    const encryptedStatic = this.symmetric.encryptAndHash(this.staticKeys.publicKey);
    this.symmetric.mixKey(dh(this.staticKeys.privateKey, this.remoteStatic));
    return concat(
      this.ephemeral.publicKey,
      encryptedStatic,
      this.symmetric.encryptAndHash(payload),
    );
  }

  // <- e, ee, se
  readMessageB(message: Uint8Array): { payload: Uint8Array; result: HandshakeResult } {
    if (this.done) throw new Error("noise: handshake already complete");
    if (message.length < DHLEN + TAGLEN) throw new Error("noise: message B is too short");
    const remoteEphemeral = message.subarray(0, DHLEN);
    this.symmetric.mixHash(remoteEphemeral);
    this.symmetric.mixKey(dh(this.ephemeral.privateKey, remoteEphemeral));
    this.symmetric.mixKey(dh(this.staticKeys.privateKey, remoteEphemeral));
    const payload = this.symmetric.decryptAndHash(message.subarray(DHLEN));
    const [send, receive] = this.symmetric.split();
    this.done = true;
    return {
      payload,
      result: {
        send,
        receive,
        remoteStatic: this.remoteStatic,
        handshakeHash: this.symmetric.handshakeHash,
      },
    };
  }
}

export class NoiseResponder {
  private readonly symmetric: SymmetricState;
  private readonly ephemeral: KeyPair;
  private peerStatic: Uint8Array | undefined;
  private peerEphemeral: Uint8Array | undefined;

  constructor(
    private readonly staticKeys: KeyPair,
    prologue: Uint8Array = EMPTY,
    ephemeral: KeyPair = generateKeyPair(),
  ) {
    this.ephemeral = ephemeral;
    this.symmetric = new SymmetricState(PROTOCOL_NAME);
    this.symmetric.mixHash(prologue);
    this.symmetric.mixHash(staticKeys.publicKey);
  }

  // -> e, es, s, ss
  readMessageA(message: Uint8Array): { remoteStatic: Uint8Array; payload: Uint8Array } {
    if (message.length < DHLEN + DHLEN + TAGLEN + TAGLEN) {
      throw new Error("noise: message A is too short");
    }
    const remoteEphemeral = message.subarray(0, DHLEN);
    this.symmetric.mixHash(remoteEphemeral);
    this.symmetric.mixKey(dh(this.staticKeys.privateKey, remoteEphemeral));
    const encryptedStatic = message.subarray(DHLEN, DHLEN + DHLEN + TAGLEN);
    const remoteStatic = this.symmetric.decryptAndHash(encryptedStatic);
    this.symmetric.mixKey(dh(this.staticKeys.privateKey, remoteStatic));
    const payload = this.symmetric.decryptAndHash(message.subarray(DHLEN + DHLEN + TAGLEN));
    this.peerStatic = remoteStatic;
    this.peerEphemeral = remoteEphemeral;
    return { remoteStatic, payload };
  }

  // <- e, ee, se
  writeMessageB(payload: Uint8Array = EMPTY): { message: Uint8Array; result: HandshakeResult } {
    if (!this.peerStatic || !this.peerEphemeral) throw new Error("noise: message A not read");
    this.symmetric.mixHash(this.ephemeral.publicKey);
    this.symmetric.mixKey(dh(this.ephemeral.privateKey, this.peerEphemeral));
    this.symmetric.mixKey(dh(this.ephemeral.privateKey, this.peerStatic));
    const message = concat(this.ephemeral.publicKey, this.symmetric.encryptAndHash(payload));
    const [receive, send] = this.symmetric.split();
    return {
      message,
      result: {
        send,
        receive,
        remoteStatic: this.peerStatic,
        handshakeHash: this.symmetric.handshakeHash,
      },
    };
  }
}
