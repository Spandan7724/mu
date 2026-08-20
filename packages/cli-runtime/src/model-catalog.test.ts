import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo } from "mu";
import { ModelCatalog, modelCatalogDiagnostics } from "./model-catalog.ts";

function model(id: string): ModelInfo {
  return {
    provider: "openai",
    id,
    name: id,
    contextWindow: 400_000,
    maxOutput: 128_000,
    modalities: ["text", "image"],
    thinking: true,
    thinkingLevels: ["none", "low", "xhigh"],
    defaultThinkingLevel: "none",
    pricing: {
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0,
    },
  };
}

function cacheBody(models: ModelInfo[]): string {
  return JSON.stringify({
    version: 6,
    updatedAt: "2026-07-27T00:00:00.000Z",
    models,
  });
}

describe("model catalog cache", () => {
  test("a successful refresh is persisted privately and loads on the next launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-model-catalog-"));
    const file = join(root, ".mu", "models.json");
    const discovered = [model("gpt-new")];
    const firstRegistered: ModelInfo[][] = [];
    const first = new ModelCatalog({
      cacheFile: file,
      refresh: async () => discovered,
      register: (models) => firstRegistered.push(models),
    });

    const refreshed = await first.refresh();
    expect(refreshed.ok).toBe(true);
    expect(firstRegistered).toEqual([discovered]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const stored = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      models: ModelInfo[];
    };
    expect(stored.version).toBe(6);
    expect(stored.models).toEqual(discovered);

    const secondRegistered: ModelInfo[][] = [];
    const second = new ModelCatalog({
      cacheFile: file,
      refresh: async () => [],
      register: (models) => secondRegistered.push(models),
    });
    expect(await second.loadCache()).toBe(1);
    expect(secondRegistered).toEqual([discovered]);
    expect(second.fallback).toBe("cached");
  });

  test("a malformed cache is ignored without poisoning the registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-model-catalog-bad-"));
    const file = join(root, "models.json");
    await writeFile(file, JSON.stringify({ version: 3, models: [{ id: "broken" }] }));
    const registered: ModelInfo[][] = [];
    const catalog = new ModelCatalog({
      cacheFile: file,
      refresh: async () => [],
      register: (models) => registered.push(models),
    });

    expect(await catalog.loadCache()).toBe(0);
    expect(registered).toEqual([]);
    expect(catalog.fallback).toBe("bundled");
    expect(catalog.cacheWarning).toContain("Invalid model catalog cache");
  });

  test("ignores the previous cache version after bundled compatibility metadata changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-model-catalog-stale-"));
    const file = join(root, "models.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 5,
        updatedAt: "2026-07-27T00:00:00.000Z",
        models: [model("gpt-stale")],
      }),
    );
    const registered: ModelInfo[][] = [];
    const catalog = new ModelCatalog({
      cacheFile: file,
      refresh: async () => [],
      register: (models) => registered.push(models),
    });

    expect(await catalog.loadCache()).toBe(0);
    expect(registered).toEqual([]);
    expect(catalog.fallback).toBe("bundled");
  });

  test("a cached fallback survives a failed remote refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-model-catalog-offline-"));
    const file = join(root, "models.json");
    await writeFile(file, cacheBody([model("gpt-cached")]));
    let attempts = 0;
    const catalog = new ModelCatalog({
      cacheFile: file,
      attempts: 2,
      refresh: async () => {
        attempts++;
        throw new Error("offline");
      },
      register: () => {},
    });
    await catalog.loadCache();

    const result = await catalog.refresh();
    expect(result).toEqual({
      ok: false,
      error: "offline",
      attempts: 2,
      fallback: "cached",
    });
    expect(attempts).toBe(2);
  });

  test("concurrent callers share one refresh and a successful result stays fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-model-catalog-flight-"));
    let calls = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const catalog = new ModelCatalog({
      cacheFile: join(root, "models.json"),
      refresh: async () => {
        calls++;
        await blocked;
        return [model("gpt-shared")];
      },
      register: () => {},
    });

    const first = catalog.refresh();
    const second = catalog.refresh();
    expect(first).toBe(second);
    expect(catalog.isRefreshing).toBe(true);
    release?.();
    expect((await first).ok).toBe(true);
    expect(catalog.hasFreshModels).toBe(true);
    expect((await catalog.ensureFresh()).ok).toBe(true);
    expect(calls).toBe(1);
  });

  test("a transient failure retries before falling back", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-model-catalog-retry-"));
    let calls = 0;
    const catalog = new ModelCatalog({
      cacheFile: join(root, "models.json"),
      attempts: 2,
      refresh: async () => {
        calls++;
        if (calls === 1) throw new Error("temporary");
        return [model("gpt-recovered")];
      },
      register: () => {},
    });

    const result = await catalog.refresh();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  test("passes credentials and client version to discovery and reports partial warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-model-catalog-options-"));
    const credential = { type: "apiKey" as const, apiKey: "secret" };
    let resolvedProvider = "";
    const catalog = new ModelCatalog({
      cacheFile: join(root, "models.json"),
      clientVersion: "1.2.3",
      getCredentials: async (provider) => {
        resolvedProvider = provider;
        return credential;
      },
      refresh: async (options) => {
        expect(options?.clientVersion).toBe("1.2.3");
        expect(await options?.getCredentials?.("future-provider")).toEqual(credential);
        options?.onWarning?.("secondary catalog unavailable");
        return [model("gpt-discovered")];
      },
      register: () => {},
    });

    const result = await catalog.refresh();

    expect(resolvedProvider).toBe("future-provider");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual(["secondary catalog unavailable"]);
  });

  test("stop aborts an in-flight background refresh without retrying", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-model-catalog-stop-"));
    let calls = 0;
    const catalog = new ModelCatalog({
      cacheFile: join(root, "models.json"),
      attempts: 2,
      refresh: async (options) => {
        calls++;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
        return [];
      },
      register: () => {},
    });

    const refresh = catalog.refresh();
    catalog.stop();
    const result = await refresh;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });
});

describe("model catalog diagnostics", () => {
  test("headless output suppresses partial provider warnings", () => {
    const result = {
      ok: true as const,
      models: [model("gpt-new")],
      attempts: 1,
      warnings: ["Could not discover github-copilot models: catalog returned no models"],
    };

    expect(modelCatalogDiagnostics(result, { includePartialWarnings: false })).toEqual([]);
    expect(modelCatalogDiagnostics(result)).toEqual([
      "model discovery warning: Could not discover github-copilot models: catalog returned no models",
    ]);
  });

  test("fatal fallback and cache diagnostics remain visible", () => {
    expect(
      modelCatalogDiagnostics(
        { ok: false, error: "offline", attempts: 2, fallback: "cached" },
        { includePartialWarnings: false },
      ),
    ).toEqual(["model discovery failed; using cached catalog: offline"]);
    expect(
      modelCatalogDiagnostics(
        {
          ok: true,
          models: [model("gpt-new")],
          attempts: 1,
          cacheWarning: "could not save model cache: read-only",
        },
        { includePartialWarnings: false },
      ),
    ).toEqual(["could not save model cache: read-only"]);
  });
});
