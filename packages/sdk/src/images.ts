import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { ImageContent, UserContent } from "@mu/ai";

// Anthropic refuses images over 5 MB of base64 or 8000 px a side; the other
// providers accept at least that much.
export const MAX_IMAGE_BYTES = 3_750_000;
export const MAX_IMAGE_SIDE = 8000;

export interface ImageInfo {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
}

export interface LoadedImage {
  image: ImageContent;
  info: ImageInfo;
  bytes: number;
}

export type ImageCheck = { ok: true; loaded: LoadedImage } | { ok: false; reason: string };

// Image formats a user may hand over that no provider reads directly.
const UNSUPPORTED_IMAGE_EXTENSIONS = new Set([
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
  return IMAGE_EXTENSIONS.has(extension) || UNSUPPORTED_IMAGE_EXTENSIONS.has(extension);
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

// undefined: the bytes are not an image mu recognizes.
export function checkImage(bytes: Uint8Array): ImageCheck | undefined {
  const info = sniffImage(bytes);
  if (!info) return undefined;
  if (
    info.width > MAX_IMAGE_SIDE ||
    info.height > MAX_IMAGE_SIDE ||
    bytes.length > MAX_IMAGE_BYTES
  ) {
    return {
      ok: false,
      reason: `the image is ${info.width}×${info.height} px and ${formatBytes(bytes.length)}; models accept at most ${MAX_IMAGE_SIDE} px a side and ${formatBytes(MAX_IMAGE_BYTES)}. Make a smaller copy first (for example \`magick in.png -resize 1600x1600 out.png\`).`,
    };
  }
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
    },
  };
}

// Throws with a reason a person can act on.
export async function loadImageFile(path: string): Promise<LoadedImage> {
  const info = await stat(path);
  if (info.isDirectory()) throw new Error(`${path} is a folder, not an image`);
  if (info.size > MAX_IMAGE_BYTES * 4) {
    throw new Error(
      `${path} is ${formatBytes(info.size)}; images must be at most ${formatBytes(MAX_IMAGE_BYTES)}`,
    );
  }
  const checked = checkImage(await readFile(path));
  if (!checked) {
    throw new Error(
      UNSUPPORTED_IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
        ? `${path}: this image format is not supported; convert it to PNG, JPEG, GIF or WebP`
        : `${path} is not a PNG, JPEG, GIF or WebP image`,
    );
  }
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
