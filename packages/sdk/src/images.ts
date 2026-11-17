import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { ImageContent, UserContent } from "@mu/ai";

// Images are fitted inside 2000 px a side and 4.5 MB of base64: Anthropic's
// limits once a request holds more than 20 images, and below its 5 MB cap.
export const MAX_IMAGE_SIDE = 2000;
export const MAX_IMAGE_BASE64 = 4.5 * 1024 * 1024;
// Without a resizer, what providers accept at all.
const PROVIDER_MAX_SIDE = 8000;
const PROVIDER_MAX_BASE64 = 5_000_000;
export const MAX_SOURCE_IMAGE_BYTES = 64 * 1024 * 1024;
const LOSSY_QUALITIES = [80, 70, 55, 40];

export interface ImageInfo {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
}

export interface LoadedImage {
  image: ImageContent;
  info: ImageInfo;
  bytes: number;
  // Present when the image was resized, converted or turned upright.
  source?: { width: number; height: number; bytes: number };
}

export type ImageCheck = { ok: true; loaded: LoadedImage } | { ok: false; reason: string };

// Formats no provider reads directly; mu converts those Bun can decode here.
const CONVERTED_IMAGE_EXTENSIONS = new Set([
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif",
  ".ico",
  ".jxl",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function hasImageExtension(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) || CONVERTED_IMAGE_EXTENSIONS.has(extension);
}

function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function u16le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function u24le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    at += 2 + u16be(bytes, at + 2);
  }
  return undefined;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const b0 = bytes[21] ?? 0;
    const b1 = bytes[22] ?? 0;
    const b2 = bytes[23] ?? 0;
    const b3 = bytes[24] ?? 0;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X") return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  return undefined;
}

// Recognizes the image formats every provider reads, from the bytes alone.
export function sniffImage(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length >= 24 && ascii(bytes, 1, 3) === "PNG" && bytes[0] === 0x89) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    return size ? { mimeType: "image/jpeg", ...size } : undefined;
  }
  if (bytes.length >= 10 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
    return { mimeType: "image/gif", width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const size = webpSize(bytes);
    return size ? { mimeType: "image/webp", ...size } : undefined;
  }
  return undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The EXIF orientation of a JPEG (1 = upright), read from its APP1 segment.
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let at = 2;
  while (at + 4 < bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1] ?? 0;
    const length = u16be(bytes, at + 2);
    if (marker === 0xda || marker === 0xd9) return 1;
    if (marker === 0xe1 && ascii(bytes, at + 4, 6) === "Exif\0\0") {
      const tiff = at + 10;
      const little = ascii(bytes, tiff, 2) === "II";
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (tiff + 8 > bytes.length) return 1;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      if (ifd + 2 > bytes.length) return 1;
      const entries = view.getUint16(ifd, little);
      for (let entry = 0; entry < entries; entry++) {
        const field = ifd + 2 + entry * 12;
        if (field + 10 > bytes.length) return 1;
        if (view.getUint16(field, little) === 0x0112) return view.getUint16(field + 8, little);
      }
      return 1;
    }
    at += 2 + length;
  }
  return 1;
}

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function loaded(bytes: Uint8Array, info: ImageInfo, source?: LoadedImage["source"]): ImageCheck {
  return {
    ok: true,
    loaded: {
      image: {
        type: "image",
        mimeType: info.mimeType,
        data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
      },
      info,
      bytes: bytes.length,
      ...(source ? { source } : {}),
    },
  };
}

const SHRINK_HINT =
  "Make a smaller copy first (for example `magick in.png -resize 2000x2000 out.png`).";

// Bun.Image arrived in Bun 1.4; an older Bun sends images as they are, within provider limits.
function resizer(): typeof Bun.Image | undefined {
  return typeof Bun !== "undefined" && typeof Bun.Image === "function" ? Bun.Image : undefined;
}

function unresized(bytes: Uint8Array, info: ImageInfo): ImageCheck {
  if (
    info.width <= PROVIDER_MAX_SIDE &&
    info.height <= PROVIDER_MAX_SIDE &&
    base64Length(bytes.length) <= PROVIDER_MAX_BASE64
  ) {
    return loaded(bytes, info);
  }
  return {
    ok: false,
    reason: `the image is ${info.width}×${info.height} px and ${formatBytes(bytes.length)}, over what models accept, and this Bun cannot resize images (Bun 1.4 or later can). ${SHRINK_HINT}`,
  };
}

function fitSizes(width: number, height: number): { width: number; height: number }[] {
  const scale = Math.min(1, MAX_IMAGE_SIDE / width, MAX_IMAGE_SIDE / height);
  const sizes = [
    {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    },
  ];
  for (;;) {
    const last = sizes.at(-1) as { width: number; height: number };
    if (last.width === 1 && last.height === 1) return sizes;
    sizes.push({
      width: Math.max(1, Math.floor(last.width * 0.75)),
      height: Math.max(1, Math.floor(last.height * 0.75)),
    });
  }
}

// BMP, TIFF and HEIF/AVIF containers, so plain files never reach the decoder.
function convertibleHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const start = ascii(bytes, 0, 4);
  if (start.startsWith("BM") || start === "II*\0" || start === "MM\0*") return true;
  return (
    ascii(bytes, 4, 4) === "ftyp" &&
    /^(heic|heix|hevc|mif1|msf1|avif|avis)$/.test(ascii(bytes, 8, 4))
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

// Makes an image ready for a model: unchanged when it already fits, otherwise
// turned upright, fitted inside the limits and re-encoded. Photos stay JPEG;
// anything else tries lossless PNG, then WebP, which keeps transparency.
// undefined: the bytes are not an image mu can read.
export async function prepareImage(bytes: Uint8Array): Promise<ImageCheck | undefined> {
  const sniffed = sniffImage(bytes);
  const upright = sniffed?.mimeType !== "image/jpeg" || jpegOrientation(bytes) <= 1;
  if (
    sniffed &&
    sniffed.mimeType !== "image/gif" &&
    upright &&
    sniffed.width <= MAX_IMAGE_SIDE &&
    sniffed.height <= MAX_IMAGE_SIDE &&
    base64Length(bytes.length) <= MAX_IMAGE_BASE64
  ) {
    return loaded(bytes, sniffed);
  }
  if (!sniffed && !convertibleHeader(bytes)) return undefined;
  const Image = resizer();
  if (!Image) return sniffed ? unresized(bytes, sniffed) : undefined;

  let source: { width: number; height: number; format: string };
  try {
    source = await new Image(bytes).metadata();
  } catch (error) {
    const code = errorCode(error);
    if (code === "ERR_IMAGE_FORMAT_UNSUPPORTED") {
      return {
        ok: false,
        reason: "this image format cannot be decoded on this system; convert it to PNG or JPEG",
      };
    }
    if (code === "ERR_IMAGE_TOO_MANY_PIXELS") {
      return { ok: false, reason: `the image has too many pixels to open. ${SHRINK_HINT}` };
    }
    if (sniffed) return { ok: false, reason: "the image could not be decoded; it may be damaged" };
    return undefined;
  }

  const photo = source.format === "jpeg";
  const original = { width: source.width, height: source.height, bytes: bytes.length };
  for (const size of fitSizes(source.width, source.height)) {
    const resized = () => {
      const image = new Image(bytes);
      return size.width === source.width && size.height === source.height
        ? image
        : image.resize(size.width, size.height);
    };
    const encodings: [ImageInfo["mimeType"], () => Promise<Uint8Array>][] = photo
      ? LOSSY_QUALITIES.map((quality) => ["image/jpeg", () => resized().jpeg({ quality }).bytes()])
      : [
          ["image/png", () => resized().png().bytes()],
          ...LOSSY_QUALITIES.map(
            (quality) =>
              ["image/webp", () => resized().webp({ quality }).bytes()] as [
                ImageInfo["mimeType"],
                () => Promise<Uint8Array>,
              ],
          ),
        ];
    for (const [mimeType, encode] of encodings) {
      const output = await encode();
      if (base64Length(output.length) <= MAX_IMAGE_BASE64) {
        return loaded(output, { mimeType, ...size }, original);
      }
    }
  }
  return { ok: false, reason: `the image could not be made small enough. ${SHRINK_HINT}` };
}

// Throws with a reason a person can act on.
export async function loadImageFile(path: string): Promise<LoadedImage> {
  const info = await stat(path);
  if (info.isDirectory()) throw new Error(`${path} is a folder, not an image`);
  if (info.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(
      `${path} is ${formatBytes(info.size)}; images must be at most ${formatBytes(MAX_SOURCE_IMAGE_BYTES)}`,
    );
  }
  const checked = await prepareImage(await readFile(path));
  if (!checked) throw new Error(`${path} is not an image mu can read`);
  if (!checked.ok) throw new Error(`${path}: ${checked.reason}`);
  return checked.loaded;
}

export function imageMarker(index: number, info: Pick<ImageInfo, "width" | "height">): string {
  return `[image ${index} · ${info.width}×${info.height}]`;
}

// Each image follows its marker, so the model and the transcript can tell them apart.
export function userContentWithImages(text: string, images: readonly LoadedImage[]): UserContent[] {
  if (images.length === 0) return [{ type: "text", text }];
  const content: UserContent[] = [];
  images.forEach((loaded, index) => {
    const prefix = index === 0 ? (text ? `${text}\n` : "") : " ";
    content.push({ type: "text", text: `${prefix}${imageMarker(index + 1, loaded.info)}` });
    content.push(loaded.image);
  });
  return content;
}
