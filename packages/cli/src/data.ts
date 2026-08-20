import { homedir } from "node:os";
import { join } from "node:path";

// The coding product's data namespace. Every path the runtime needs is derived
// from here so a second product never writes into this one's state.
export function codingDataDir(home = homedir()): string {
  return join(home, ".mu");
}

export function userConfigPath(home = homedir()): string {
  return join(codingDataDir(home), "config.json");
}

export function modelCatalogCachePath(home = homedir()): string {
  return join(codingDataDir(home), "models.json");
}
