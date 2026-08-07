import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// Noise_IK_25519_AESGCM_SHA256 (RD20). Every constant below is from the Noise
// specification; none of it is a choice made here.
export const DHLEN = 32;
export const HASHLEN = 32;
export const TAGLEN = 16;

// SPKI/PKCS8 prefixes for X25519. node:crypto has no raw import, and a fixed
// DER header is the standard way round it.
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: new Uint8Array(pair.publicKey.export({ type: "spki", format: "der" }).subarray(12)),
    privateKey: new Uint8Array(
      pair.privateKey.export({ type: "pkcs8", format: "der" }).subarray(16),
    ),
  };
}

export function publicFromPrivate(privateKey: Uint8Array): Uint8Array {
  const secret = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKey)]),
    format: "der",
    type: "pkcs8",
  });
  return new Uint8Array(
    createPublicKey(secret as never)
      .export({ type: "spki", format: "der" })
      .subarray(12),
  );
}

export function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return new Uint8Array(
    diffieHellman({
      privateKey: createPrivateKey({
        key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKey)]),
        format: "der",
        type: "pkcs8",
      }),
      publicKey: createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey)]),
        format: "der",
        type: "spki",
      }),
    }),
  );
}

export function hash(...parts: Uint8Array[]): Uint8Array {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return new Uint8Array(digest.digest());
}

export function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data).digest());
}

// HKDF as the Noise spec defines it: chained HMACs, not the RFC 5869 wrapper.
export function hkdf(chainingKey: Uint8Array, input: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const temp = hmac(chainingKey, input);
  const one = hmac(temp, Uint8Array.of(1));
  const two = hmac(temp, concat(one, Uint8Array.of(2)));
  if (outputs === 2) return [one, two];
  return [one, two, hmac(temp, concat(two, Uint8Array.of(3)))];
}

// 4 zero bytes followed by the counter big-endian. ChaChaPoly would put the
// same counter little-endian; getting this wrong is silent and catastrophic,
// which is why it lives in exactly one place.
export function nonceBytes(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, counter, false);
  return nonce;
}

export function encrypt(
  key: Uint8Array,
  counter: bigint,
  associatedData: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  const cipher = createCipheriv("aes-256-gcm", key, nonceBytes(counter));
  cipher.setAAD(associatedData);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return concat(new Uint8Array(body), new Uint8Array(cipher.getAuthTag()));
}

export function decrypt(
  key: Uint8Array,
  counter: bigint,
  associatedData: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  if (ciphertext.length < TAGLEN) throw new Error("ciphertext is too short to carry a tag");
  const body = ciphertext.subarray(0, ciphertext.length - TAGLEN);
  const tag = ciphertext.subarray(ciphertext.length - TAGLEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonceBytes(counter));
  decipher.setAAD(associatedData);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function random(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}
