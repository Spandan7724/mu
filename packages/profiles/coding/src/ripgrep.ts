import { accessSync, constants, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

function bundledRipgrepPath(execPath: string, platform: NodeJS.Platform): string | undefined {
  const name = platform === "win32" ? "rg.exe" : "rg";
  const path = resolve(dirname(execPath), "..", "mu-path", name);
  try {
    if (!statSync(path).isFile()) return undefined;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

const RIPGREP_PACKAGE_BY_PLATFORM: Partial<
  Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>
> = {
  darwin: { arm64: "@mu-agent/ripgrep-darwin-arm64" },
  linux: { x64: "@mu-agent/ripgrep-linux-x64" },
  win32: { x64: "@mu-agent/ripgrep-windows-x64" },
};

export function resolveNpmRipgrepExecutable(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
  from = process.argv[1] ? dirname(resolve(process.argv[1])) : process.cwd(),
  resolvePackage: (specifier: string, from: string) => string = (specifier, root) =>
    Bun.resolveSync(specifier, root),
): string | undefined {
  const packageName = RIPGREP_PACKAGE_BY_PLATFORM[platform]?.[architecture];
  if (!packageName) return undefined;
  try {
    const packageJson = resolvePackage(`${packageName}/package.json`, from);
    const name = platform === "win32" ? "rg.exe" : "rg";
    const path = resolve(dirname(packageJson), "vendor", name);
    if (!statSync(path).isFile()) return undefined;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

export function resolveRipgrepExecutable(
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
  which: (command: string) => string | null = (command) => Bun.which(command),
  resolveNpm: () => string | undefined = () => resolveNpmRipgrepExecutable(platform, process.arch),
): string | undefined {
  return bundledRipgrepPath(execPath, platform) ?? resolveNpm() ?? which("rg") ?? undefined;
}
