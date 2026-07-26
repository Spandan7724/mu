import data from "./models.json" with { type: "json" };
import type { ModelInfo } from "./types.ts";

const models: ModelInfo[] = data.models as ModelInfo[];

export function listModels(): ModelInfo[] {
  return [...models];
}

export function registerModels(extra: ModelInfo[]): void {
  models.push(...extra);
}

// Accepts "provider/model-id" or a bare model id (first match wins).
export function findModel(ref: string): ModelInfo | undefined {
  const slash = ref.indexOf("/");
  if (slash !== -1) {
    const provider = ref.slice(0, slash);
    const id = ref.slice(slash + 1);
    return models.find((m) => m.provider === provider && m.id === id);
  }
  return models.find((m) => m.id === ref);
}

export function modelRef(model: ModelInfo): string {
  return `${model.provider}/${model.id}`;
}
