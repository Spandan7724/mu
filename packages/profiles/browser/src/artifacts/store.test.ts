import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleReceipt } from "../testing/samples.ts";
import { ArtifactWriteError, BrowserArtifactStore } from "./store.ts";

const DAY = 24 * 60 * 60 * 1000;
let root: string;
let now = 1_700_000_000_000;

function store(overrides: Partial<ConstructorParameters<typeof BrowserArtifactStore>[0]> = {}) {
  return new BrowserArtifactStore({ root, now: () => now, ...overrides });
}

beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), "mu-artifacts-")), "artifacts");
  now = 1_700_000_000_000;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function age(path: string, milliseconds: number): Promise<void> {
  const when = new Date(now - milliseconds);
  await utimes(path, when, when);
}

describe("artifact store", () => {
  test("writes are private and land under a kind directory", async () => {
    const artifacts = store();
    const written = await artifacts.write("log", "session.log", "connected\n");
    expect(written.path).toBe("logs/session.log");
    const file = await stat(join(root, "logs", "session.log"));
    const directory = await stat(join(root, "logs"));
    if (process.platform !== "win32") {
      expect(file.mode & 0o777).toBe(0o600);
      expect(directory.mode & 0o777).toBe(0o700);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    }
  });

  test("a write leaves no temporary file behind", async () => {
    const artifacts = store();
    await artifacts.write("observation", "obs-1.json", "{}");
    const names = await readdir(join(root, "observations"));
    expect(names.filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  test("an artifact name is a bare filename", async () => {
    const artifacts = store();
    for (const name of ["../escape.log", "nested/deep.log", "/absolute.log"]) {
      await expect(artifacts.write("log", name, "x")).rejects.toThrow(ArtifactWriteError);
    }
    expect(await readdir(root).catch(() => [])).not.toContain("escape.log");
  });

  test("an artifact larger than its kind's whole budget is refused", async () => {
    const artifacts = store({
      retention: { log: { maxCount: 5, maxBytes: 16, maxAgeMs: DAY } },
    });
    await expect(artifacts.write("log", "big.log", "x".repeat(64))).rejects.toThrow(
      ArtifactWriteError,
    );
  });

  test("a screenshot reaches disk as bytes, never as base64", async () => {
    const artifacts = store();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const written = await artifacts.writeScreenshot("shot.png", png.toString("base64"));
    expect(written.path).toBe("screenshots/shot.png");
    const bytes = await Bun.file(join(root, "screenshots", "shot.png")).bytes();
    expect([...bytes]).toEqual([...png]);
  });

  test("writing past the count limit evicts the oldest", async () => {
    const artifacts = store({
      retention: { screenshot: { maxCount: 2, maxBytes: 1_000_000, maxAgeMs: DAY } },
    });
    for (const index of [0, 1, 2]) {
      await artifacts.write("screenshot", `shot-${index}.png`, `png-${index}`);
      await age(join(root, "screenshots", `shot-${index}.png`), (3 - index) * 1_000);
    }
    const last = await artifacts.write("screenshot", "shot-3.png", "png-3");
    expect(last.evicted).toEqual(["shot-1.png"]);
    const names = (await artifacts.list("screenshot")).map((entry) => entry.name);
    expect(names).toHaveLength(2);
    expect(names).toContain("shot-3.png");
    expect(names).not.toContain("shot-0.png");
  });

  test("an expired artifact is evicted on the next prune", async () => {
    const artifacts = store({
      retention: { observation: { maxCount: 50, maxBytes: 1_000_000, maxAgeMs: DAY } },
    });
    await artifacts.write("observation", "old.json", "{}");
    await age(join(root, "observations", "old.json"), 3 * DAY);
    expect(await artifacts.prune("observation")).toEqual(["old.json"]);
    expect(await artifacts.list("observation")).toHaveLength(0);
  });

  test("download metadata is bounded like everything else", async () => {
    const artifacts = store({
      retention: { download: { maxCount: 1, maxBytes: 1_000, maxAgeMs: DAY } },
    });
    await artifacts.write("download", "one.json", JSON.stringify({ basename: "invoice.pdf" }));
    await age(join(root, "downloads", "one.json"), 5_000);
    const second = await artifacts.write(
      "download",
      "two.json",
      JSON.stringify({ basename: "terms.pdf" }),
    );
    expect(second.evicted).toEqual(["one.json"]);
  });

  test("a receipt round-trips and validates on the way back in", async () => {
    const artifacts = store();
    const receipt = sampleReceipt();
    const written = await artifacts.writeReceipt(receipt);
    expect(written.path).toBe("receipts/receipt-1.json");
    expect(await artifacts.readReceipt("receipt-1")).toEqual(receipt);
    expect(await artifacts.readReceipt("receipt-absent")).toBeUndefined();
  });

  test("an invalid receipt never reaches disk", async () => {
    const artifacts = store();
    await expect(
      artifacts.writeReceipt({ ...sampleReceipt(), origin: "https://elsewhere.example.com" }),
    ).rejects.toThrow(ArtifactWriteError);
    expect(await artifacts.list("receipt")).toHaveLength(0);
  });

  test("pruning every kind is one call", async () => {
    const artifacts = store({
      retention: { log: { maxCount: 1, maxBytes: 1_000, maxAgeMs: DAY } },
    });
    await artifacts.write("log", "a.log", "a");
    await age(join(root, "logs", "a.log"), 5_000);
    await artifacts.write("log", "b.log", "b");
    const pruned = await artifacts.pruneAll();
    expect(Object.keys(pruned).sort()).toEqual([
      "download",
      "log",
      "observation",
      "receipt",
      "screenshot",
    ]);
  });

  test("listing a kind that was never written is empty, not an error", async () => {
    expect(await store().list("receipt")).toEqual([]);
  });
});
