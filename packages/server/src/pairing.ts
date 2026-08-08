import { fromBase64Url, toBase64Url } from "./noise/primitives.ts";

export interface PairingInvite {
  // The host's Noise static public key. Pinning this is what blocks MITM: the
  // QR is the pinning (SECURITY.md §4).
  hostKey: Uint8Array;
  // One-time, 60-second, consumed on first use.
  token: string;
  address: string;
}

// mu://pair?h=<host static public key>&t=<one-time token>&a=<address>
export function encodePairingUrl(invite: PairingInvite): string {
  const params = new URLSearchParams({
    h: toBase64Url(invite.hostKey),
    t: invite.token,
    a: invite.address,
  });
  return `mu://pair?${params.toString()}`;
}

export function decodePairingUrl(url: string): PairingInvite | undefined {
  if (!url.startsWith("mu://pair?")) return undefined;
  const params = new URLSearchParams(url.slice("mu://pair?".length));
  const hostKey = params.get("h");
  const token = params.get("t");
  const address = params.get("a");
  if (!hostKey || !token || !address) return undefined;
  const decoded = fromBase64Url(hostKey);
  if (decoded.length !== 32) return undefined;
  return { hostKey: decoded, token, address };
}

// A human-checkable rendering of a key, grouped so it can be read aloud or
// compared at a glance. Shown next to the QR and on the phone's confirmation.
export function fingerprint(key: Uint8Array): string {
  const hex = Buffer.from(key).toString("hex").slice(0, 16).toUpperCase();
  return (hex.match(/.{1,4}/g) ?? []).join(" ");
}

const QR_HALVES = ["█", "▀", "▄", " "] as const;

// A QR renderer small enough to keep mu dependency-free. Version is chosen from
// the payload length; only byte mode and error-correction level L are needed,
// because the payload is short and the screen is right in front of you.
export function qrLines(text: string): string[] {
  const matrix = qrMatrix(text);
  const size = matrix.length;
  const quiet = 2;
  const modules = size + quiet * 2;
  const lines: string[] = [];

  // A terminal cell is roughly twice as tall as it is wide. Packing two QR
  // rows into the upper and lower halves of one glyph keeps each module
  // square while halving both the printed width and height.
  const darkAt = (row: number, column: number): boolean => {
    const y = row - quiet;
    const x = column - quiet;
    return y >= 0 && y < size && x >= 0 && x < size
      ? ((matrix[y] as boolean[])[x] ?? false)
      : false;
  };

  for (let row = 0; row < modules; row += 2) {
    let line = "";
    for (let column = 0; column < modules; column++) {
      const top = darkAt(row, column) ? 2 : 0;
      const bottom = darkAt(row + 1, column) ? 1 : 0;
      line += QR_HALVES[top + bottom];
    }
    lines.push(line);
  }
  return lines;
}

// --- QR encoding (ISO/IEC 18004), byte mode, EC level L ---------------------

const EC_CODEWORDS_L = [
  0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30,
  26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
];
const BLOCKS_L = [
  0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 12, 13,
  14, 16, 17, 17, 18, 20, 21, 22, 24, 25,
];
const ALIGNMENT: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
];

function totalCodewords(version: number): number {
  const size = version * 4 + 17;
  let modules = size * size;
  modules -= 3 * 8 * 8; // finders + separators
  modules -= version >= 7 ? 67 : 31; // format + version info
  modules -= (size - 16) * 2; // timing patterns
  const centres = ALIGNMENT[version] ?? [];
  if (centres.length > 0) {
    const count = centres.length;
    modules -= (count * count - 3) * 25;
    modules += (count - 2) * 2 * 5; // overlaps with timing
  }
  return Math.floor(modules / 8);
}

// Exposed so a reader can be written against the same block geometry without
// duplicating the standard's tables.
export function qrParameters(version: number): {
  size: number;
  blocks: number;
  ecPerBlock: number;
  dataCodewords: number;
} {
  const blocks = BLOCKS_L[version] ?? 1;
  const ecPerBlock = EC_CODEWORDS_L[version] ?? 7;
  return {
    size: version * 4 + 17,
    blocks,
    ecPerBlock,
    dataCodewords: totalCodewords(version) - blocks * ecPerBlock,
  };
}

function capacity(version: number): number {
  const blocks = BLOCKS_L[version] ?? 1;
  const ec = EC_CODEWORDS_L[version] ?? 7;
  const data = totalCodewords(version) - blocks * ec;
  const headerBits = 4 + (version < 10 ? 8 : 16);
  return data - Math.ceil(headerBits / 8);
}

function pickVersion(length: number): number {
  for (let version = 1; version <= 20; version++) {
    if (capacity(version) >= length) return version;
  }
  throw new Error("payload is too long for this QR encoder");
}

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

function multiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[((LOG[a] as number) + (LOG[b] as number)) % 255] as number;
}

function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let index = 0; index < degree; index++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let position = 0; position < poly.length; position++) {
      next[position] = (next[position] as number) ^ multiply(poly[position] as number, 1);
      next[position + 1] =
        (next[position + 1] as number) ^ multiply(poly[position] as number, EXP[index] as number);
    }
    poly = next;
  }
  return poly;
}

function errorCorrection(data: number[], count: number): number[] {
  const generator = generatorPolynomial(count);
  const remainder = new Array<number>(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number);
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < count; index++) {
      remainder[index] =
        (remainder[index] as number) ^ multiply(generator[index + 1] as number, factor);
    }
  }
  return remainder;
}

function encodeData(text: string, version: number): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let index = width - 1; index >= 0; index--) bits.push((value >> index) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const blocks = BLOCKS_L[version] ?? 1;
  const ec = EC_CODEWORDS_L[version] ?? 7;
  const dataCodewords = totalCodewords(version) - blocks * ec;
  const capacityBits = dataCodewords * 8;
  for (let index = 0; index < 4 && bits.length < capacityBits; index++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset++)
      byte = (byte << 1) | (bits[index + offset] as number);
    codewords.push(byte);
  }
  const padding = [0xec, 0x11];
  let cursor = 0;
  while (codewords.length < dataCodewords) {
    codewords.push(padding[cursor % 2] as number);
    cursor++;
  }

  // Interleave data and error-correction blocks, as the standard requires.
  const shortCount = Math.floor(dataCodewords / blocks);
  const longBlocks = dataCodewords % blocks;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let index = 0; index < blocks; index++) {
    const size = shortCount + (index >= blocks - longBlocks ? 1 : 0);
    const block = codewords.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(errorCorrection(block, ec));
  }
  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let index = 0; index < longest; index++) {
    for (const block of dataBlocks) {
      if (index < block.length) out.push(block[index] as number);
    }
  }
  for (let index = 0; index < ec; index++) {
    for (const block of ecBlocks) out.push(block[index] as number);
  }
  return out;
}

// BCH(18,6) over the version number, generator 0x1F25 — from the standard.
export function versionInformation(version: number): number {
  let remainder = version;
  for (let index = 0; index < 12; index++) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return ((version << 12) | remainder) >>> 0;
}

function qrMatrix(text: string): boolean[][] {
  const version = pickVersion(new TextEncoder().encode(text).length);
  const size = version * 4 + 17;
  const modules: (boolean | undefined)[][] = Array.from({ length: size }, () =>
    new Array<boolean | undefined>(size).fill(undefined),
  );

  const place = (row: number, column: number, dark: boolean) => {
    (modules[row] as (boolean | undefined)[])[column] = dark;
  };

  const finder = (row: number, column: number) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const y = row + dy;
        const x = column + dx;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inner = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
        const ring = dy === 0 || dy === 6 || dx === 0 || dx === 6;
        const core = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
        place(y, x, inner && (ring || core));
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let index = 8; index < size - 8; index++) {
    place(6, index, index % 2 === 0);
    place(index, 6, index % 2 === 0);
  }

  const centres = ALIGNMENT[version] ?? [];
  for (const row of centres) {
    for (const column of centres) {
      if ((row === 6 && column === 6) || (row === 6 && column === size - 7)) continue;
      if (row === size - 7 && column === 6) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dy), Math.abs(dx));
          place(row + dy, column + dx, ring !== 1);
        }
      }
    }
  }

  place(size - 8, 8, true); // dark module

  // Reserve the format areas so data placement skips them.
  for (let index = 0; index < 9; index++) {
    if ((modules[8] as (boolean | undefined)[])[index] === undefined) place(8, index, false);
    if ((modules[index] as (boolean | undefined)[])[8] === undefined) place(index, 8, false);
  }
  for (let index = 0; index < 8; index++) {
    if ((modules[8] as (boolean | undefined)[])[size - 1 - index] === undefined) {
      place(8, size - 1 - index, false);
    }
    if ((modules[size - 1 - index] as (boolean | undefined)[])[8] === undefined) {
      place(size - 1 - index, 8, false);
    }
  }
  if (version >= 7) {
    for (let index = 0; index < 6; index++) {
      for (let offset = 0; offset < 3; offset++) {
        place(index, size - 11 + offset, false);
        place(size - 11 + offset, index, false);
      }
    }
  }

  const codewords = encodeData(text, version);
  const bits: number[] = [];
  for (const byte of codewords) {
    for (let index = 7; index >= 0; index--) bits.push((byte >> index) & 1);
  }

  let cursorBit = 0;
  let upward = true;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const offset of [0, 1]) {
        const x = column - offset;
        if ((modules[row] as (boolean | undefined)[])[x] !== undefined) continue;
        const value = cursorBit < bits.length ? (bits[cursorBit] as number) : 0;
        cursorBit++;
        // Mask 0: (row + column) % 2 === 0.
        const masked = (row + x) % 2 === 0 ? value ^ 1 : value;
        place(row, x, masked === 1);
      }
    }
    upward = !upward;
  }

  // Format information for EC level L with mask 0, from the standard's table.
  // Written twice: column 8 top / row 8 left, then row 8 right / column 8
  // bottom, so a damaged corner still leaves one readable copy.
  const format = 0b111011111000100;
  const bit = (index: number) => ((format >> index) & 1) === 1;
  for (let index = 0; index <= 5; index++) place(index, 8, bit(index));
  place(7, 8, bit(6));
  place(8, 8, bit(7));
  place(8, 7, bit(8));
  for (let index = 9; index <= 14; index++) place(8, 14 - index, bit(index));
  for (let index = 0; index <= 7; index++) place(8, size - 1 - index, bit(index));
  for (let index = 8; index <= 14; index++) place(size - 15 + index, 8, bit(index));
  place(size - 8, 8, true);

  // Version information, from version 7 up: an 18-bit BCH word written twice,
  // above the bottom-left finder and left of the top-right one. Reserving the
  // space without filling it leaves a scanner unable to read the symbol.
  if (version >= 7) {
    const bits = versionInformation(version);
    for (let index = 0; index < 18; index++) {
      const dark = ((bits >> index) & 1) === 1;
      const a = Math.floor(index / 3);
      const b = (index % 3) + size - 11;
      place(b, a, dark);
      place(a, b, dark);
    }
  }

  return modules.map((row) => row.map((cell) => cell === true));
}
