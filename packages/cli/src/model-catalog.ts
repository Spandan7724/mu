import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type Credential,
  type ModelDiscoveryOptions,
  type ModelInfo,
  refreshModels,
  registerModels,
} from "mu";

const CACHE_VERSION = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 2;

interface ModelCatalogCache {
  version: number;
  updatedAt: string;
  models: ModelInfo[];
}

type RefreshModels = (options?: ModelDiscoveryOptions) => Promise<ModelInfo[]>;

export type ModelCatalogRefreshResult =
  | {
      ok: true;
      models: ModelInfo[];
      attempts: number;
      cacheWarning?: string;
      warnings?: string[];
    }
  | {
      ok: false;
      error: string;
      attempts: number;
      fallback: "cached" | "bundled";
    };

export interface ModelCatalogOptions {
  cacheFile?: string;
  timeoutMs?: number;
  attempts?: number;
  refresh?: RefreshModels;
  register?: (models: ModelInfo[]) => void;
  getCredentials?: (provider: string) => Promise<Credential | undefined>;
  clientVersion?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isModel(value: unknown): value is ModelInfo {
  if (!isRecord(value) || !isRecord(value.pricing)) return false;
  const pricing = value.pricing;
  if (
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !isFiniteNonNegative(value.contextWindow) ||
    value.contextWindow === 0 ||
    !isFiniteNonNegative(value.maxOutput) ||
    value.maxOutput === 0 ||
    !Array.isArray(value.modalities) ||
    !value.modalities.includes("text") ||
    !value.modalities.every((item) => item === "text" || item === "image")
  ) {
    return false;
  }
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (value.baseUrl !== undefined && typeof value.baseUrl !== "string") return false;
  if (value.thinking !== undefined && typeof value.thinking !== "boolean") return false;
  if (
    value.thinkingMode !== undefined &&
    value.thinkingMode !== "adaptive" &&
    value.thinkingMode !== "budget"
  ) {
    return false;
  }
  return ["input", "output", "cacheRead", "cacheWrite"].every((key) =>
    isFiniteNonNegative(pricing[key]),
  );
}

function parseCache(raw: string, file: string): ModelCatalogCache {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.version !== CACHE_VERSION ||
    typeof parsed.updatedAt !== "string" ||
    !Array.isArray(parsed.models) ||
    parsed.models.length === 0 ||
    parsed.models.length > 10_000 ||
    !parsed.models.every(isModel)
  ) {
    throw new Error(`Invalid model catalog cache at ${file}`);
  }
  return parsed as unknown as ModelCatalogCache;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function saveCache(file: string, models: ModelInfo[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const body: ModelCatalogCache = {
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    models,
  };
  try {
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function modelCatalogCachePath(home = homedir()): string {
  return join(home, ".mu", "models.json");
}

export class ModelCatalog {
  private readonly cacheFile: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly refreshModels: RefreshModels;
  private readonly registerModels: (models: ModelInfo[]) => void;
  private readonly getCredentials:
    | ((provider: string) => Promise<Credential | undefined>)
    | undefined;
  private readonly clientVersion: string | undefined;
  private inFlight: Promise<ModelCatalogRefreshResult> | undefined;
  private refreshController: AbortController | undefined;
  private lastResult: ModelCatalogRefreshResult | undefined;
  private cachedModels = 0;
  private cacheIssue: string | undefined;

  constructor(options: ModelCatalogOptions = {}) {
    this.cacheFile = options.cacheFile ?? modelCatalogCachePath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
    this.refreshModels = options.refresh ?? refreshModels;
    this.registerModels = options.register ?? registerModels;
    this.getCredentials = options.getCredentials;
    this.clientVersion = options.clientVersion;
  }

  get isRefreshing(): boolean {
    return this.inFlight !== undefined;
  }

  get hasFreshModels(): boolean {
    return this.lastResult?.ok === true;
  }

  get fallback(): "cached" | "bundled" {
    return this.cachedModels > 0 ? "cached" : "bundled";
  }

  get cacheWarning(): string | undefined {
    return this.cacheIssue;
  }

  async loadCache(): Promise<number> {
    try {
      const cache = parseCache(await readFile(this.cacheFile, "utf8"), this.cacheFile);
      this.registerModels(cache.models);
      this.cachedModels = cache.models.length;
      this.cacheIssue = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.cacheIssue = errorMessage(error);
      }
      this.cachedModels = 0;
    }
    return this.cachedModels;
  }

  refresh(): Promise<ModelCatalogRefreshResult> {
    if (this.inFlight) return this.inFlight;
    const controller = new AbortController();
    const operation = this.performRefresh(controller.signal);
    this.refreshController = controller;
    this.inFlight = operation;
    void operation.finally(() => {
      if (this.inFlight === operation) {
        this.inFlight = undefined;
        this.refreshController = undefined;
      }
    });
    return operation;
  }

  async ensureFresh(): Promise<ModelCatalogRefreshResult> {
    if (this.lastResult?.ok) return this.lastResult;
    return this.inFlight ?? this.refresh();
  }

  stop(): void {
    this.refreshController?.abort();
  }

  private async performRefresh(stopSignal: AbortSignal): Promise<ModelCatalogRefreshResult> {
    let lastError: unknown;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      attemptsMade = attempt;
      try {
        const warnings: string[] = [];
        const models = await this.refreshModels({
          signal: AbortSignal.any([stopSignal, AbortSignal.timeout(this.timeoutMs)]),
          ...(this.getCredentials ? { getCredentials: this.getCredentials } : {}),
          ...(this.clientVersion ? { clientVersion: this.clientVersion } : {}),
          onWarning: (warning) => warnings.push(warning),
        });
        this.registerModels(models);
        let cacheWarning: string | undefined;
        try {
          await saveCache(this.cacheFile, models);
          this.cachedModels = models.length;
          this.cacheIssue = undefined;
        } catch (error) {
          cacheWarning = `could not save model cache: ${errorMessage(error)}`;
          this.cacheIssue = cacheWarning;
        }
        const result: ModelCatalogRefreshResult = {
          ok: true,
          models,
          attempts: attempt,
          ...(cacheWarning ? { cacheWarning } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
        this.lastResult = result;
        return result;
      } catch (error) {
        lastError = error;
        if (stopSignal.aborted) break;
      }
    }
    const result: ModelCatalogRefreshResult = {
      ok: false,
      error: errorMessage(lastError),
      attempts: attemptsMade,
      fallback: this.fallback,
    };
    this.lastResult = result;
    return result;
  }
}

export async function initializeModelCatalog(
  options: ModelCatalogOptions = {},
): Promise<ModelCatalog> {
  const catalog = new ModelCatalog(options);
  await catalog.loadCache();
  void catalog.refresh();
  return catalog;
}
