import { type Origin, PROTOCOL_VERSION } from "@mu/protocol";
import type { DeviceStore } from "./devices.ts";
import { NoiseResponder } from "./noise/handshake.ts";
import type { CipherState } from "./noise/state.ts";
import type { SecureChannel } from "./server.ts";

// Authenticated but version-bearing: a mismatch has to be refusable before any
// frame is exchanged, so the version is in the prologue rather than only in
// `hello`. Tampering with it fails the handshake instead of downgrading it.
export function prologue(version = PROTOCOL_VERSION): Uint8Array {
  return new TextEncoder().encode(`mu-remote/${version}`);
}

// The payload a pairing client sends in message A. An already-enrolled device
// sends an empty payload and is authenticated by its key alone.
export interface PairingPayload {
  token?: string;
  deviceName?: string;
}

export interface SealedChannelOptions {
  devices: DeviceStore;
  // Reports why a connection was refused. Deliberately not sent to the peer:
  // an unauthenticated caller learns only that it failed.
  onRefused?: (reason: string) => void;
  onAuthenticated?: (deviceId: string) => void;
  protocolVersion?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// One connection's crypto. Everything an unauthenticated peer can reach is in
// `advance` — kept small enough to audit in one sitting (SECURITY.md §6).
export class SealedChannel implements SecureChannel {
  private responder: NoiseResponder;
  private send: CipherState | undefined;
  private receive: CipherState | undefined;
  private authenticated: Origin | undefined;

  constructor(private readonly options: SealedChannelOptions) {
    this.responder = new NoiseResponder(
      options.devices.hostKeys,
      prologue(options.protocolVersion),
    );
  }

  get origin(): Origin | undefined {
    return this.authenticated;
  }

  advance(message: Uint8Array): Uint8Array | undefined {
    const { devices } = this.options;
    const read = this.responder.readMessageA(message);

    let device = devices.find(read.remoteStatic);
    if (!device) {
      // Not enrolled: the only way in is a token from a QR someone was
      // physically present for, and it is consumed here.
      const payload = parsePayload(read.payload);
      const redeemed = payload.token
        ? devices.redeemPairingToken(payload.token)
        : { ok: false as const, reason: "unpaired key" };
      if (!redeemed.ok) {
        this.options.onRefused?.(redeemed.reason);
        throw new Error(redeemed.reason);
      }
      device = devices.enroll(read.remoteStatic, payload.deviceName ?? "paired device");
    }

    const written = this.responder.writeMessageB();
    this.send = written.result.send;
    this.receive = written.result.receive;
    this.authenticated = { kind: "remote", deviceId: device.id, deviceName: device.name };
    devices.touch(device.id);
    this.options.onAuthenticated?.(device.id);
    return written.message;
  }

  seal(plaintext: string): Uint8Array {
    if (!this.send) throw new Error("channel is not established");
    return this.send.encryptWithAd(new Uint8Array(0), encoder.encode(plaintext));
  }

  open(ciphertext: Uint8Array): string {
    if (!this.receive) throw new Error("channel is not established");
    return decoder.decode(this.receive.decryptWithAd(new Uint8Array(0), ciphertext));
  }
}

function parsePayload(payload: Uint8Array): PairingPayload {
  if (payload.length === 0) return {};
  try {
    const parsed = JSON.parse(decoder.decode(payload)) as PairingPayload;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function encodePairingPayload(payload: PairingPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}
