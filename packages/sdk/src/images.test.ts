import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jpegOrientation,
  loadImageFile,
  MAX_IMAGE_BASE64,
  prepareImage,
  sniffImage,
  userContentWithImages,
} from "./images.ts";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

// A decodable 24-bit BMP; Bun.Image turns it into any other format.
function bmp(width: number, height: number, pixel: (x: number, y: number) => number[]): Uint8Array {
  const row = Math.ceil((width * 3) / 4) * 4;
  const bytes = new Uint8Array(54 + row * height);
  const view = new DataView(bytes.buffer);
  bytes.set([0x42, 0x4d]);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r = 0, g = 0, b = 0] = pixel(x, height - 1 - y);
      bytes.set([b, g, r], 54 + y * row + x * 3);
    }
  }
  return bytes;
}

const gradient = (width: number, height: number) =>
  bmp(width, height, (x, y) => [(x * 255) / width, (y * 255) / height, 128]);

async function encoded(source: Uint8Array, format: "png" | "jpeg"): Promise<Uint8Array> {
  const image = new Bun.Image(source);
  return format === "png" ? image.png().bytes() : image.jpeg({ quality: 90 }).bytes();
}

function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [
    0x4d,
    0x4d,
    0,
    0x2a,
    0,
    0,
    0,
    8,
    0,
    1,
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    orientation,
  ];
  const payload = [...new TextEncoder().encode("Exif"), 0, 0, ...tiff, 0, 0, 0, 0, 0, 0];
  const length = payload.length + 2;
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    length >> 8,
    length & 0xff,
    ...payload,
    ...jpeg.subarray(2),
  ]);
}

async function prepared(bytes: Uint8Array) {
  const result = await prepareImage(bytes);
  if (!result?.ok) throw new Error(`not prepared: ${JSON.stringify(result)}`);
  return result.loaded;
}

describe("sniffImage", () => {
  test("reads the format and size of the formats providers accept", async () => {
    expect(sniffImage(pngHeader(1280, 720))).toEqual({
      mimeType: "image/png",
      width: 1280,
      height: 720,
    });
    expect(sniffImage(await encoded(gradient(64, 48), "jpeg"))).toEqual({
      mimeType: "image/jpeg",
      width: 64,
      height: 48,
    });
    const gif = new Uint8Array([...Buffer.from("GIF89a"), 0x20, 0x01, 0xc8, 0x00]);
    expect(sniffImage(gif)).toEqual({ mimeType: "image/gif", width: 288, height: 200 });
    for (const lossless of [false, true]) {
      const webp = await new Bun.Image(gradient(100, 56)).webp({ lossless }).bytes();
      expect(sniffImage(webp)).toEqual({ mimeType: "image/webp", width: 100, height: 56 });
    }
  });

  test("text and other binaries are not images", () => {
    expect(sniffImage(Buffer.from("hello, world, this is text"))).toBeUndefined();
    expect(sniffImage(Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj"))).toBeUndefined();
  });
});

describe("prepareImage", () => {
  test("an image that already fits is sent byte for byte", async () => {
    const bytes = pngHeader(1280, 720);
    const loaded = await prepared(bytes);
    expect(loaded.image.data).toBe(Buffer.from(bytes).toString("base64"));
    expect(loaded.source).toBeUndefined();
  });

  test("a large screenshot is fitted inside 2000 px and stays lossless", async () => {
    const loaded = await prepared(await encoded(gradient(3000, 1500), "png"));
    expect(loaded.info).toEqual({ mimeType: "image/png", width: 2000, height: 1000 });
    expect(loaded.source).toMatchObject({ width: 3000, height: 1500 });
    expect(sniffImage(Buffer.from(loaded.image.data, "base64"))).toEqual(loaded.info);
  });

  test("a large photo stays JPEG", async () => {
    const loaded = await prepared(await encoded(gradient(2400, 3000), "jpeg"));
    expect(loaded.info).toEqual({ mimeType: "image/jpeg", width: 1600, height: 2000 });
  });

  test("a PNG too heavy to send losslessly becomes WebP within the limit", async () => {
    let seed = 7;
    const noise = bmp(1500, 1500, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return [seed & 255, (seed >> 8) & 255, (seed >> 16) & 255];
    });
    const loaded = await prepared(await encoded(noise, "png"));
    expect(loaded.info.mimeType).toBe("image/webp");
    expect(loaded.image.data.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64);
  });

  test("a phone photo is turned upright", async () => {
    const sideways = withOrientation(await encoded(gradient(40, 20), "jpeg"), 6);
    expect(jpegOrientation(sideways)).toBe(6);
    const loaded = await prepared(sideways);
    expect(loaded.info).toMatchObject({ mimeType: "image/jpeg", width: 20, height: 40 });
    expect(jpegOrientation(Buffer.from(loaded.image.data, "base64"))).toBe(1);
  });

  test("formats providers do not read are converted", async () => {
    const loaded = await prepared(gradient(120, 80));
    expect(loaded.info).toEqual({ mimeType: "image/png", width: 120, height: 80 });
  });

  test("text is not an image", async () => {
    expect(await prepareImage(Buffer.from("just some text, not pixels"))).toBeUndefined();
  });
});

describe("loadImageFile", () => {
  test("names the problem with a file that cannot be sent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mu-images-"));
    await writeFile(join(dir, "notes.png"), "plain text");
    await writeFile(join(dir, "ok.png"), pngHeader(3, 4));
    await expect(loadImageFile(join(dir, "notes.png"))).rejects.toThrow("not an image");
    await expect(loadImageFile(join(dir, "missing.png"))).rejects.toThrow();
    expect((await loadImageFile(join(dir, "ok.png"))).info).toMatchObject({ width: 3, height: 4 });
  });
});

describe("userContentWithImages", () => {
  test("each image follows a marker after the text", async () => {
    const one = await prepared(pngHeader(1, 2));
    const two = await prepared(pngHeader(3, 4));
    const content = userContentWithImages("compare these", [one, two]);
    expect(content.map((block) => (block.type === "text" ? block.text : "<img>"))).toEqual([
      "compare these\n[image 1 · 1×2]",
      "<img>",
      " [image 2 · 3×4]",
      "<img>",
    ]);
    expect(userContentWithImages("plain", [])).toEqual([{ type: "text", text: "plain" }]);
  });
});
