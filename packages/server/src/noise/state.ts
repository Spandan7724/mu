import { concat, DHLEN, decrypt, dh, encrypt, HASHLEN, hash, hkdf, TAGLEN } from "./primitives.ts";

const EMPTY = new Uint8Array(0);
// The spec's maximum nonce; reaching it means rekey or die, never wrap.
const MAX_NONCE = 2n ** 64n - 1n;

// CipherState from the Noise specification, §5.1.
export class CipherState {
  private key: Uint8Array | undefined;
  private nonce = 0n;

  initializeKey(key: Uint8Array | undefined): void {
    this.key = key;
    this.nonce = 0n;
  }

  get hasKey(): boolean {
    return this.key !== undefined;
  }

  encryptWithAd(associatedData: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext;
    if (this.nonce >= MAX_NONCE) throw new Error("noise: nonce exhausted");
    const out = encrypt(this.key, this.nonce, associatedData, plaintext);
    this.nonce += 1n;
    return out;
  }

  decryptWithAd(associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext;
    if (this.nonce >= MAX_NONCE) throw new Error("noise: nonce exhausted");
    const out = decrypt(this.key, this.nonce, associatedData, ciphertext);
    this.nonce += 1n;
    return out;
  }
}

// SymmetricState from the Noise specification, §5.2.
export class SymmetricState {
  readonly cipher = new CipherState();
  chainingKey: Uint8Array;
  handshakeHash: Uint8Array;

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    this.handshakeHash = name.length <= HASHLEN ? padded(name) : hash(name);
    this.chainingKey = this.handshakeHash;
  }

  mixKey(input: Uint8Array): void {
    const [chainingKey, temp] = hkdf(this.chainingKey, input, 2) as [Uint8Array, Uint8Array];
    this.chainingKey = chainingKey;
    this.cipher.initializeKey(temp.subarray(0, 32));
  }

  mixHash(data: Uint8Array): void {
    this.handshakeHash = hash(this.handshakeHash, data);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.handshakeHash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.handshakeHash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.chainingKey, EMPTY, 2) as [Uint8Array, Uint8Array];
    const send = new CipherState();
    const receive = new CipherState();
    send.initializeKey(first.subarray(0, 32));
    receive.initializeKey(second.subarray(0, 32));
    return [send, receive];
  }
}

function padded(name: Uint8Array): Uint8Array {
  const out = new Uint8Array(HASHLEN);
  out.set(name);
  return out;
}

export { concat, DHLEN, dh, EMPTY, TAGLEN };
