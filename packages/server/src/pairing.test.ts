import { describe, expect, test } from "bun:test";
import { generateKeyPair, toBase64Url } from "./noise/primitives.ts";
import {
  decodePairingUrl,
  encodePairingUrl,
  fingerprint,
  qrLines,
  qrParameters,
  versionInformation,
} from "./pairing.ts";

// --- an independent QR reader, so the encoder is proven rather than eyeballed --

function matrixFrom(lines: string[]): boolean[][] {
  const quiet = 2;
  const body = lines.slice(quiet, lines.length - quiet);
  return body.map((line) => {
    const inner = line.slice(quiet * 2, line.length - quiet * 2);
    const row: boolean[] = [];
    for (let index = 0; index < inner.length; index += 2) {
      row.push(inner.slice(index, index + 2) === "  ");
    }
    return row;
  });
}

const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

function reserved(size: number, version: number): boolean[][] {
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (row: number, column: number) => {
    if (row >= 0 && row < size && column >= 0 && column < size) {
      (map[row] as boolean[])[column] = true;
    }
  };
  for (const [row, column] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) mark(row + dy, column + dx);
  }
  for (let index = 0; index < size; index++) {
    mark(6, index);
    mark(index, 6);
  }
  const centres = ALIGNMENT[version] ?? [];
  for (const row of centres) {
    for (const column of centres) {
      if ((row === 6 && column === 6) || (row === 6 && column === size - 7)) continue;
      if (row === size - 7 && column === 6) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(row + dy, column + dx);
    }
  }
  for (let index = 0; index <= 8; index++) {
    mark(8, index);
    mark(index, 8);
  }
  for (let index = 0; index <= 7; index++) {
    mark(8, size - 1 - index);
    mark(size - 1 - index, 8);
  }
  if (version >= 7) {
    for (let index = 0; index < 18; index++) {
      const a = Math.floor(index / 3);
      const b = (index % 3) + size - 11;
      mark(b, a);
      mark(a, b);
    }
  }
  return map;
}

// Galois field arithmetic, used only to check that what the encoder produced is
// a valid Reed-Solomon codeword.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index++) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index++) EXP[index] = EXP[index - 255] as number;
}
const multiply = (a: number, b: number) =>
  a === 0 || b === 0 ? 0 : (EXP[((LOG[a] as number) + (LOG[b] as number)) % 255] as number);

function syndromes(block: number[], count: number): number[] {
  return Array.from({ length: count }, (_, index) =>
    block.reduce(
      (accumulator, codeword) => multiply(accumulator, EXP[index] as number) ^ codeword,
      0,
    ),
  );
}

interface ReadQr {
  version: number;
  size: number;
  format: number;
  text: string;
  syndromesZero: boolean;
}

function readQr(lines: string[]): ReadQr {
  const matrix = matrixFrom(lines);
  const size = matrix.length;
  const version = (size - 17) / 4;
  const { blocks, ecPerBlock, dataCodewords } = qrParameters(version);
  const map = reserved(size, version);

  const bits: number[] = [];
  let upward = true;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const offset of [0, 1]) {
        const x = column - offset;
        if ((map[row] as boolean[])[x]) continue;
        const dark = (matrix[row] as boolean[])[x] ? 1 : 0;
        // Mask 0 is what the encoder applies; undo it to recover the payload.
        bits.push((row + x) % 2 === 0 ? dark ^ 1 : dark);
      }
    }
    upward = !upward;
  }

  const codewords: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset++)
      byte = (byte << 1) | (bits[index + offset] as number);
    codewords.push(byte);
  }

  const data = codewords.slice(0, dataCodewords);
  const ecc = codewords.slice(dataCodewords, dataCodewords + blocks * ecPerBlock);
  // Blocks are not always the same length; the longer ones come last and the
  // interleave skips the short ones on its final pass.
  const shortCount = Math.floor(dataCodewords / blocks);
  const longBlocks = dataCodewords % blocks;
  const sizes = Array.from(
    { length: blocks },
    (_, index) => shortCount + (index >= blocks - longBlocks ? 1 : 0),
  );
  const dataBlocks: number[][] = sizes.map(() => []);
  let cursor = 0;
  for (let index = 0; index < Math.max(...sizes); index++) {
    for (let block = 0; block < blocks; block++) {
      if (index >= (sizes[block] as number)) continue;
      (dataBlocks[block] as number[]).push(data[cursor++] as number);
    }
  }
  let syndromesZero = true;
  const raw: number[] = [];
  for (let block = 0; block < blocks; block++) {
    const dataBlock = dataBlocks[block] as number[];
    const ecBlock = Array.from({ length: ecPerBlock }, (_, k) => ecc[k * blocks + block] as number);
    raw.push(...dataBlock);
    if (syndromes([...dataBlock, ...ecBlock], ecPerBlock).some((value) => value !== 0)) {
      syndromesZero = false;
    }
  }

  const stream = raw.map((byte) => byte.toString(2).padStart(8, "0")).join("");
  const length = Number.parseInt(stream.slice(4, 12), 2);
  const bytes = Array.from({ length }, (_, index) =>
    Number.parseInt(stream.slice(12 + index * 8, 20 + index * 8), 2),
  );

  let format = 0;
  for (let index = 0; index <= 5; index++) {
    if ((matrix[index] as boolean[])[8]) format |= 1 << index;
  }
  if ((matrix[7] as boolean[])[8]) format |= 1 << 6;
  if ((matrix[8] as boolean[])[8]) format |= 1 << 7;
  if ((matrix[8] as boolean[])[7]) format |= 1 << 8;
  for (let index = 9; index <= 14; index++) {
    if ((matrix[8] as boolean[])[14 - index]) format |= 1 << index;
  }

  return {
    version,
    size,
    format,
    syndromesZero,
    text: new TextDecoder().decode(Uint8Array.from(bytes)),
  };
}

describe("pairing url", () => {
  test("round-trips the host key, token and address", () => {
    const host = generateKeyPair();
    const invite = { hostKey: host.publicKey, token: "one-time", address: "192.168.1.20:51820" };
    const url = encodePairingUrl(invite);

    expect(url.startsWith("mu://pair?")).toBe(true);
    expect(url).toContain(`h=${toBase64Url(host.publicKey)}`);
    expect(decodePairingUrl(url)).toEqual(invite);
  });

  test("anything that is not a well-formed invite is refused", () => {
    expect(decodePairingUrl("https://example.com")).toBeUndefined();
    expect(decodePairingUrl("mu://pair?t=x&a=y")).toBeUndefined();
    // A host key that is not 32 bytes cannot be a Noise static key.
    expect(decodePairingUrl("mu://pair?h=AAAA&t=x&a=y")).toBeUndefined();
  });

  test("the fingerprint is a stable, readable rendering of the key", () => {
    const key = new Uint8Array(32).fill(0xab);
    expect(fingerprint(key)).toBe("ABAB ABAB ABAB ABAB");
    expect(fingerprint(key)).toBe(fingerprint(key));
  });
});

describe("pairing QR", () => {
  test("a short payload reads back from the smallest symbol that fits it", () => {
    const read = readQr(qrLines("mu://pair?h=a&t=b&a=c"));
    expect(read.version).toBe(2);
    expect(read.size).toBe(25);
    expect(read.syndromesZero).toBe(true);
    expect(read.text).toBe("mu://pair?h=a&t=b&a=c");
  });

  test("a real pairing url reads back byte for byte", () => {
    const host = generateKeyPair();
    const url = encodePairingUrl({
      hostKey: host.publicKey,
      token: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA",
      address: "192.168.1.20:51820",
    });
    const read = readQr(qrLines(url));

    expect(read.version).toBe(6);
    expect(qrParameters(6)).toEqual({
      size: 41,
      blocks: 2,
      ecPerBlock: 18,
      dataCodewords: 136,
    });
    expect(read.syndromesZero).toBe(true);
    expect(read.text).toBe(url);
  });

  test("version information matches the standard's table from version 7 up", () => {
    expect(versionInformation(7)).toBe(0x07c94);
    expect(versionInformation(9)).toBe(0x09a99);
    expect(versionInformation(10)).toBe(0x0a4d3);
    expect(versionInformation(40)).toBe(0x28c69);
  });

  test("the format information says level L, mask 0", () => {
    const read = readQr(qrLines("mu://pair?h=a&t=b&a=c"));
    expect(read.format.toString(2).padStart(15, "0")).toBe("111011111000100");
  });

  test("the symbol carries a quiet zone and renders as fixed-width blocks", () => {
    const lines = qrLines("mu://pair?h=a&t=b&a=c");
    const width = lines[0]?.length ?? 0;
    expect(lines.every((line) => line.length === width)).toBe(true);
    expect(lines[0]).toBe("█".repeat(width));
    expect(lines.length).toBe(25 + 4);
  });

  test("payloads of many lengths all read back, so version selection is sound", () => {
    const versions = new Set<number>();
    for (const length of [1, 16, 40, 80, 120, 200]) {
      const text = `mu://pair?a=${"x".repeat(length)}`;
      const read = readQr(qrLines(text));
      versions.add(read.version);
      expect({ length, ok: read.syndromesZero }).toEqual({ length, ok: true });
      expect(read.text).toBe(text);
    }
    // The payloads really did span several symbol sizes.
    expect([...versions]).toEqual([1, 2, 3, 5, 6, 9]);
  });
});
