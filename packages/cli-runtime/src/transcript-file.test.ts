import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveTranscriptMarkdown, transcriptPath } from "./transcript-file.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mu-export-test-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("transcript files", () => {
  test("generates a timestamped Markdown path in the current directory", () => {
    const cwd = resolve("workspace");
    expect(
      transcriptPath({ cwd, prefix: "mu", now: new Date("2026-08-03T12:34:56.789Z") }),
    ).toEqual({
      path: join(cwd, "mu-transcript-2026-08-03T12-34-56-789Z.md"),
      generated: true,
    });
  });

  test("saves a private UTF-8 Markdown file and accepts quoted paths", async () => {
    const cwd = await temporaryDirectory();
    const saved = await saveTranscriptMarkdown("# transcript\n", {
      cwd,
      requestedPath: '"my chat"',
    });
    expect(saved.displayPath).toBe("my chat.md");
    expect(await readFile(saved.path, "utf8")).toBe("# transcript\n");
    if (process.platform !== "win32") {
      expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    }
  });

  test("never overwrites an explicit destination", async () => {
    const cwd = await temporaryDirectory();
    const path = join(cwd, "chat.md");
    await writeFile(path, "existing");
    await expect(
      saveTranscriptMarkdown("replacement", { cwd, requestedPath: "chat.md" }),
    ).rejects.toThrow("Refusing to overwrite");
    expect(await readFile(path, "utf8")).toBe("existing");
  });

  test("adds a suffix when a generated timestamp collides", async () => {
    const cwd = await temporaryDirectory();
    const now = new Date("2026-08-03T12:34:56.789Z");
    const first = await saveTranscriptMarkdown("first", { cwd, prefix: "mu", now });
    const second = await saveTranscriptMarkdown("second", { cwd, prefix: "mu", now });
    expect(first.displayPath).toBe("mu-transcript-2026-08-03T12-34-56-789Z.md");
    expect(second.displayPath).toBe("mu-transcript-2026-08-03T12-34-56-789Z-2.md");
  });

  test("rejects non-Markdown extensions", async () => {
    const cwd = await temporaryDirectory();
    await expect(
      saveTranscriptMarkdown("content", { cwd, requestedPath: "chat.txt" }),
    ).rejects.toThrow(".md extension");
  });
});
