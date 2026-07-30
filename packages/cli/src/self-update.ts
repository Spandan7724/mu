import { realpath } from "node:fs/promises";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const UPDATE_TIMEOUT_MS = 15_000;

export type UpdatePackageManager = "npm" | "bun";

export interface SelfUpdateIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export interface SelfUpdateOptions {
  currentVersion: string;
  packageName: string;
  entryPath?: string | undefined;
  packageManager?: UpdatePackageManager | undefined;
  registry?: string | undefined;
  fetch?: typeof fetch | undefined;
  runCommand?: ((command: string[]) => Promise<number>) | undefined;
  resolvePath?: ((path: string) => Promise<string>) | undefined;
}

interface ParsedSemver {
  core: [string, string, string];
  prerelease: string[];
}

interface UpdateInstallation {
  manager: UpdatePackageManager;
  npmPrefix?: string;
}

function parseSemver(version: string): ParsedSemver {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) throw new Error(`invalid semantic version "${version}"`);
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error(`invalid semantic version "${version}"`);
  }
  return {
    core: [match[1] as string, match[2] as string, match[3] as string],
    prerelease,
  };
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < a.core.length; index++) {
    const compared = compareNumeric(a.core[index] as string, b.core[index] as string);
    if (compared !== 0) return compared;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumeric(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function packageManagerFromInstallPaths(
  packageName: string,
  entryPath: string,
  resolvedPath: string,
): UpdatePackageManager | undefined {
  const entry = normalizePath(entryPath);
  const resolved = normalizePath(resolvedPath);
  if (entry.includes("/.bun/bin/") || resolved.includes("/.bun/install/global/node_modules/")) {
    return "bun";
  }
  if (entry.includes("/node_modules/.bin/")) return undefined;
  return resolved.includes(`/node_modules/${packageName}/`) ? "npm" : undefined;
}

export function npmPrefixFromInstallPath(
  packageName: string,
  resolvedPath: string,
): string | undefined {
  const resolved = normalizePath(resolvedPath);
  const markerIndex = resolved.indexOf(`/node_modules/${packageName}/`);
  if (markerIndex < 0) return undefined;
  const beforeNodeModules = resolved.slice(0, markerIndex);
  if (beforeNodeModules.endsWith("/lib")) {
    return beforeNodeModules.slice(0, -"/lib".length) || "/";
  }
  return beforeNodeModules || "/";
}

async function detectInstallation(
  packageName: string,
  entryPath: string,
  resolvePath: (path: string) => Promise<string>,
): Promise<UpdateInstallation | undefined> {
  let resolvedPath = entryPath;
  try {
    resolvedPath = await resolvePath(entryPath);
  } catch {
    // The original path still identifies ordinary Bun global shims.
  }
  const manager = packageManagerFromInstallPaths(packageName, entryPath, resolvedPath);
  if (!manager) return undefined;
  const npmPrefix =
    manager === "npm" ? npmPrefixFromInstallPath(packageName, resolvedPath) : undefined;
  return {
    manager,
    ...(npmPrefix ? { npmPrefix } : {}),
  };
}

async function latestVersion(
  packageName: string,
  registry: string,
  fetcher: typeof fetch,
): Promise<string> {
  const response = await fetcher(
    `${registry.replace(/\/+$/, "")}/${encodeURIComponent(packageName)}/latest`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status} ${response.statusText}`.trim());
  }
  const payload: unknown = await response.json();
  const version =
    typeof payload === "object" && payload !== null
      ? (payload as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string") throw new Error("npm registry response has no version");
  parseSemver(version);
  return version;
}

async function runUpdateCommand(command: string[]): Promise<number> {
  const child = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

function updateCommand(
  manager: UpdatePackageManager,
  packageName: string,
  version: string,
  npmPrefix?: string,
): string[] {
  const spec = `${packageName}@${version}`;
  return manager === "bun"
    ? ["bun", "install", "--global", "--ignore-scripts", spec]
    : [
        "npm",
        ...(npmPrefix ? ["--prefix", npmPrefix] : []),
        "install",
        "--global",
        "--ignore-scripts",
        spec,
      ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSelfUpdate(options: SelfUpdateOptions, io: SelfUpdateIo): Promise<number> {
  try {
    const installation = options.packageManager
      ? { manager: options.packageManager }
      : options.entryPath
        ? await detectInstallation(
            options.packageName,
            options.entryPath,
            options.resolvePath ?? realpath,
          )
        : undefined;
    const manager = installation?.manager;
    if (!manager) {
      throw new Error(
        "this installation is not a global npm or Bun package; update it using the same method you installed it with",
      );
    }

    io.stdout(`Checking ${options.packageName} for updates...\n`);
    const latest = await latestVersion(
      options.packageName,
      options.registry ?? DEFAULT_REGISTRY,
      options.fetch ?? fetch,
    );
    const comparison = compareSemver(options.currentVersion, latest);
    if (comparison === 0) {
      io.stdout(`mu is up to date (${options.currentVersion}).\n`);
      return 0;
    }
    if (comparison > 0) {
      io.stdout(
        `mu ${options.currentVersion} is newer than the latest published version (${latest}).\n`,
      );
      return 0;
    }

    io.stdout(`Updating mu ${options.currentVersion} → ${latest} with ${manager}...\n`);
    const command = updateCommand(manager, options.packageName, latest, installation?.npmPrefix);
    const exitCode = await (options.runCommand ?? runUpdateCommand)(command);
    if (exitCode !== 0) {
      throw new Error(`${manager} exited with status ${exitCode}`);
    }
    io.stdout(`Updated mu to ${latest}. Restart mu to use the new version.\n`);
    return 0;
  } catch (error) {
    io.stderr(`mu: self-update failed: ${errorMessage(error)}\n`);
    return 1;
  }
}
