import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Extension, ExtensionHost } from "@mu/core";

export interface LoadOptions {
  // Explicit files/directories to load, in order.
  paths?: string[];
  // Also scan ~/.mu/extensions and <projectDir>/.mu/extensions.
  userDir?: boolean;
  projectDir?: string;
}

function looksLikeExtension(value: unknown): value is Extension {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Extension).name === "string" &&
    typeof (value as Extension).activate === "function"
  );
}

async function filesIn(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => name.endsWith(".ts") || name.endsWith(".js"))
      .sort()
      .map((name) => join(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function expand(path: string): Promise<string[]> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? filesIn(path) : [path];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function resolveExtensionFiles(options: LoadOptions = {}): Promise<string[]> {
  const files: string[] = [];
  if (options.userDir !== false) {
    files.push(...(await filesIn(join(homedir(), ".mu", "extensions"))));
  }
  if (options.projectDir) {
    files.push(...(await filesIn(join(options.projectDir, ".mu", "extensions"))));
  }
  for (const path of options.paths ?? []) {
    files.push(...(await expand(isAbsolute(path) ? path : resolve(path))));
  }
  return files;
}

export interface LoadReport {
  loaded: string[];
  failed: { file: string; error: string }[];
}

// A broken extension must not take the agent down with it: failures are
// collected and reported, and the rest still load.
export async function loadExtensions(
  host: ExtensionHost,
  options: LoadOptions = {},
): Promise<LoadReport> {
  const report: LoadReport = { loaded: [], failed: [] };

  for (const file of await resolveExtensionFiles(options)) {
    try {
      const module = (await import(file)) as Record<string, unknown>;
      const candidate = module.default ?? module.extension;
      if (!looksLikeExtension(candidate)) {
        report.failed.push({
          file,
          error: "no default export with { name, activate } found",
        });
        continue;
      }
      await host.register(candidate);
      report.loaded.push(file);
    } catch (error) {
      report.failed.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return report;
}
