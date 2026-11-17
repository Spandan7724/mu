import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pastedImagePaths, splitPastedPaths } from "./image-input.ts";

describe("splitPastedPaths", () => {
  test("reads the forms terminals use for dropped files", () => {
    expect(splitPastedPaths("'/tmp/a b.png' /tmp/c\\ d.png \"/tmp/e f.jpg\"\n", "linux")).toEqual([
      "/tmp/a b.png",
      "/tmp/c d.png",
      "/tmp/e f.jpg",
    ]);
    expect(splitPastedPaths("C:\\Users\\me\\shot.png", "win32")).toEqual([
      "C:\\Users\\me\\shot.png",
    ]);
  });
});

describe("pastedImagePaths", () => {
  test("takes a paste that names only existing image files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mu-paste-"));
    await writeFile(join(dir, "one shot.png"), "x");
    await writeFile(join(dir, "two.JPG"), "x");
    await writeFile(join(dir, "notes.txt"), "x");
    await mkdir(join(dir, "folder.png"));

    expect(pastedImagePaths(`'${join(dir, "one shot.png")}'`, "/")).toEqual([
      join(dir, "one shot.png"),
    ]);
    expect(pastedImagePaths(pathToFileURL(join(dir, "one shot.png")).href, "/")).toEqual([
      join(dir, "one shot.png"),
    ]);
    expect(pastedImagePaths("two.JPG", dir)).toEqual([join(dir, "two.JPG")]);
    expect(pastedImagePaths(`~/two.JPG`, "/", dir)).toEqual([join(dir, "two.JPG")]);
    expect(pastedImagePaths(`two.JPG 'one shot.png'`, dir)).toHaveLength(2);
  });

  test("anything else stays a text paste", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mu-paste-"));
    await writeFile(join(dir, "a.png"), "x");
    await writeFile(join(dir, "notes.txt"), "x");
    await mkdir(join(dir, "folder.png"));

    expect(pastedImagePaths("look at a.png please", dir)).toBeUndefined();
    expect(pastedImagePaths("a.png notes.txt", dir)).toBeUndefined();
    expect(pastedImagePaths("missing.png", dir)).toBeUndefined();
    expect(pastedImagePaths("folder.png", dir)).toBeUndefined();
    expect(pastedImagePaths("   ", dir)).toBeUndefined();
  });
});
