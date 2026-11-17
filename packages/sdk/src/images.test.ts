import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkImage,
  loadImageFile,
  MAX_IMAGE_BYTES,
  sniffImage,
  userContentWithImages,
} from "./images.ts";

function pngBytes(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(33 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

function jpegBytes(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment to skip, then a baseline frame header.
  const app0 = [0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(16).fill(0)]);
}

function webpBytes(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  const ascii = (text: string, at: number) =>
    bytes.set(
      [...text].map((char) => char.charCodeAt(0)),
      at,
    );
  ascii("RIFF", 0);
  ascii("WEBP", 8);
  ascii(chunk, 12);
  const view = new DataView(bytes.buffer);
  if (chunk === "VP8 ") {
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  } else if (chunk === "VP8L") {
    const w = width - 1;
    const h = height - 1;
    bytes[21] = w & 0xff;
    bytes[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
    bytes[23] = (h >> 2) & 0xff;
    bytes[24] = (h >> 10) & 0x0f;
  } else {
    view.setUint32(24, width - 1, true);
    view.setUint32(27, height - 1, true);
  }
  return bytes;
}

describe("sniffImage", () => {
  test("reads the format and size of every format providers accept", () => {
    expect(sniffImage(pngBytes(1280, 720))).toEqual({
      mimeType: "image/png",
      width: 1280,
      height: 720,
    });
    expect(sniffImage(jpegBytes(640, 480))).toEqual({
      mimeType: "image/jpeg",
      width: 640,
      height: 480,
    });
    const gif = new Uint8Array([...Buffer.from("GIF89a"), 0x20, 0x01, 0xc8, 0x00]);
    expect(sniffImage(gif)).toEqual({ mimeType: "image/gif", width: 288, height: 200 });
    for (const chunk of ["VP8 ", "VP8L", "VP8X"] as const) {
      expect(sniffImage(webpBytes(chunk, 1000, 563))).toEqual({
        mimeType: "image/webp",
        width: 1000,
        height: 563,
      });
    }
  });

  test("text and other binaries are not images", () => {
    expect(sniffImage(Buffer.from("hello, world, this is text"))).toBeUndefined();
    expect(sniffImage(Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj"))).toBeUndefined();
  });
});

describe("checkImage", () => {
  test("refuses images over the provider limits with a way forward", () => {
    const wide = checkImage(pngBytes(9000, 100));
    expect(wide?.ok).toBe(false);
    expect(wide?.ok === false && wide.reason).toContain("9000×100");
    const heavy = checkImage(pngBytes(100, 100, MAX_IMAGE_BYTES));
    expect(heavy?.ok === false && heavy.reason).toContain("magick");
  });

  test("an accepted image carries its base64 bytes", () => {
    const bytes = pngBytes(10, 20);
    const checked = checkImage(bytes);
    expect(checked?.ok).toBe(true);
    if (checked?.ok) {
      expect(checked.loaded.image).toEqual({
        type: "image",
        mimeType: "image/png",
        data: Buffer.from(bytes).toString("base64"),
      });
      expect(checked.loaded.bytes).toBe(bytes.length);
    }
  });
});

describe("loadImageFile", () => {
  test("names the problem with a file that cannot be sent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mu-images-"));
    await writeFile(join(dir, "shot.heic"), "not really");
    await writeFile(join(dir, "notes.png"), "plain text");
    await writeFile(join(dir, "ok.png"), pngBytes(3, 4));
    await expect(loadImageFile(join(dir, "shot.heic"))).rejects.toThrow("convert it to PNG");
    await expect(loadImageFile(join(dir, "notes.png"))).rejects.toThrow("is not a PNG");
    await expect(loadImageFile(join(dir, "missing.png"))).rejects.toThrow();
    expect((await loadImageFile(join(dir, "ok.png"))).info).toMatchObject({ width: 3, height: 4 });
  });
});

describe("userContentWithImages", () => {
  test("each image follows a marker after the text", () => {
    const one = checkImage(pngBytes(1, 2));
    const two = checkImage(pngBytes(3, 4));
    if (!one?.ok || !two?.ok) throw new Error("fixture");
    const content = userContentWithImages("compare these", [one.loaded, two.loaded]);
    expect(content.map((block) => (block.type === "text" ? block.text : "<img>"))).toEqual([
      "compare these\n[image 1 · 1×2]",
      "<img>",
      " [image 2 · 3×4]",
      "<img>",
    ]);
    expect(userContentWithImages("plain", [])).toEqual([{ type: "text", text: "plain" }]);
  });
});
