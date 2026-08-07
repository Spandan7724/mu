import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_GITHUB_REPO = "Spandan7724/mu";
const UPDATE_TIMEOUT_MS = 15_000;
// Not a whole-transfer deadline: that fails a slow but healthy link outright
// (this archive needs >180s below ~211 KB/s). Only a body that stops
// delivering bytes counts as dead.
const DOWNLOAD_STALL_MS = 60_000;
const NATIVE_RECEIPT_FILENAME = ".mu-install.json";

export type UpdatePackageManager = "npm" | "bun" | "native";

// Targets install.sh / install.ps1 can install and self-update can therefore
// replace in place.
export type NativeReleaseTarget = "linux-x64" | "darwin-arm64" | "windows-x64";

// The release archive, not the bare binary: ~2.6x fewer bytes over the wire
// (GitHub serves release assets uncompressed) and it keeps the pinned ripgrep
// sidecar in step with the binary it shipped with.
const NATIVE_ASSET_NAME: Record<NativeReleaseTarget, string> = {
  "linux-x64": "mu-linux-x64.tar.gz",
  "darwin-arm64": "mu-darwin-arm64.tar.gz",
  "windows-x64": "mu-windows-x64.zip",
};

const NATIVE_BINARY_NAME: Record<NativeReleaseTarget, string> = {
  "linux-x64": "mu",
  "darwin-arm64": "mu",
  "windows-x64": "mu.exe",
};

// Archive members under mu-<target>/ that install.sh and install.ps1 unpack
// alongside the executable. Everything else in ~/.mu is user state.
const OWNED_ENTRIES = ["mu-path", "licenses", "mu-package.json"];

export interface SelfUpdateIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

// Fields detectInstallationMethod needs, shared by self-update and
// self-uninstall so neither has to fabricate the other's required options.
interface InstallationDetectionOptions {
  packageName: string;
  entryPath?: string | undefined;
  // The real running executable's path (process.execPath). Compiled
  // single-file binaries report a virtual path for argv[1], so native-install
  // detection needs this separately from entryPath, which npm/Bun use.
  execPath?: string | undefined;
  packageManager?: UpdatePackageManager | undefined;
  resolvePath?: ((path: string) => Promise<string>) | undefined;
  readReceipt?: ((execPath: string) => Promise<string | undefined>) | undefined;
}

export interface SelfUpdateOptions extends InstallationDetectionOptions {
  currentVersion: string;
  registry?: string | undefined;
  repo?: string | undefined;
  fetch?: typeof fetch | undefined;
  runCommand?: ((command: string[]) => Promise<number>) | undefined;
  installNative?:
    | ((execPath: string, bytes: Uint8Array, target: NativeReleaseTarget) => Promise<void>)
    | undefined;
}

interface ParsedSemver {
  core: [string, string, string];
  prerelease: string[];
}

type UpdateInstallation =
  | { manager: "npm"; npmPrefix?: string }
  | { manager: "bun" }
  | { manager: "native"; execPath: string; target: NativeReleaseTarget };

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
): "npm" | "bun" | undefined {
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

function isNativeReleaseTarget(value: unknown): value is NativeReleaseTarget {
  return value === "linux-x64" || value === "darwin-arm64" || value === "windows-x64";
}

function parseNativeReceipt(text: string): NativeReleaseTarget | undefined {
  try {
    const data: unknown = JSON.parse(text);
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { method?: unknown }).method === "github-release" &&
      isNativeReleaseTarget((data as { target?: unknown }).target)
    ) {
      return (data as { target: NativeReleaseTarget }).target;
    }
  } catch {
    // Not a receipt this version understands; fall through to undefined.
  }
  return undefined;
}

async function defaultReadReceipt(execPath: string): Promise<string | undefined> {
  try {
    return await readFile(join(dirname(execPath), NATIVE_RECEIPT_FILENAME), "utf8");
  } catch {
    return undefined;
  }
}

async function detectNativeInstall(
  execPath: string,
  readReceipt: (execPath: string) => Promise<string | undefined>,
): Promise<NativeReleaseTarget | undefined> {
  const text = await readReceipt(execPath);
  return text ? parseNativeReceipt(text) : undefined;
}

async function detectInstallationMethod(
  options: InstallationDetectionOptions,
): Promise<UpdateInstallation | undefined> {
  const readReceipt = options.readReceipt ?? defaultReadReceipt;
  if (options.packageManager) {
    if (options.packageManager !== "native") return { manager: options.packageManager };
    const target = options.execPath
      ? await detectNativeInstall(options.execPath, readReceipt)
      : undefined;
    return target && options.execPath
      ? { manager: "native", execPath: options.execPath, target }
      : undefined;
  }
  if (options.execPath) {
    const target = await detectNativeInstall(options.execPath, readReceipt);
    if (target) return { manager: "native", execPath: options.execPath, target };
  }
  return options.entryPath
    ? detectInstallation(options.packageName, options.entryPath, options.resolvePath ?? realpath)
    : undefined;
}

async function latestGithubTag(repo: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(`https://github.com/${repo}/releases/latest`, {
    redirect: "follow",
    signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status} ${response.statusText}`.trim());
  }
  const match = /\/releases\/tag\/(v[^/]+)$/.exec(response.url);
  if (!match) throw new Error("could not resolve the latest GitHub release tag");
  return match[1] as string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// SHA256SUMS lines are `<digest>  <filename>` (sha256sum) or `<digest> *<filename>`
// (binary mode) — either way, whitespace-split with an optional leading `*`.
function digestForAsset(sums: string, assetName: string): string | undefined {
  for (const rawLine of sums.split("\n")) {
    const line = rawLine.trim();
    const spaceIndex = line.indexOf(" ");
    if (spaceIndex < 0) continue;
    const digest = line.slice(0, spaceIndex);
    const name = line.slice(spaceIndex).trim().replace(/^\*/, "");
    if (name === assetName) return digest;
  }
  return undefined;
}

async function readWithStallTimeout(
  body: ReadableStream<Uint8Array>,
  assetName: string,
  abort: () => void,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort();
          reject(
            new Error(
              `download of ${assetName} stalled for ${DOWNLOAD_STALL_MS / 1000}s with ` +
                `${total} bytes received`,
            ),
          );
        }, DOWNLOAD_STALL_MS);
      });
      const chunk = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
      if (chunk.done) break;
      chunks.push(chunk.value);
      total += chunk.value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function downloadReleaseAsset(
  repo: string,
  tag: string,
  assetName: string,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(`https://github.com/${repo}/releases/download/${tag}/${assetName}`, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(connectTimer);
  }
  if (!response.ok) {
    throw new Error(
      `could not download ${assetName}: HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }
  return response.body
    ? await readWithStallTimeout(response.body, assetName, () => controller.abort())
    : new Uint8Array(await response.arrayBuffer());
}

// Windows won't let a running .exe's *contents* be overwritten or deleted,
// but renaming it aside is generally permitted (that only touches the
// directory entry, not the locked image mapping) — the same technique used
// by Scoop and most self-updating Go/Rust Windows CLIs. If placing the new
// file at execPath fails, the old binary is restored so a failed update
// never leaves the install without a working executable.
export async function installByRenamingAside(execPath: string, tempPath: string): Promise<void> {
  const oldPath = `${execPath}.old`;
  await rm(oldPath, { force: true }).catch(() => {});
  await rename(execPath, oldPath);
  try {
    await rename(tempPath, execPath);
  } catch (error) {
    await rename(oldPath, execPath).catch(() => {});
    throw error;
  }
  await rm(oldPath, { force: true }).catch(() => {});
}

// tar handles both formats mu publishes: GNU tar reads the .tar.gz, and the
// bsdtar shipped in Windows since 10 1803 reads the .zip. Extraction is a
// subprocess rather than an in-process reader because neither Bun nor Node
// exposes a tar/zip decoder.
async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const child = Bun.spawn(["tar", "-xf", archivePath, "-C", destination], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) {
    const detail = stderr.trim() || `tar exited with status ${code}`;
    throw new Error(`could not extract the release archive: ${detail}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Unpacks the archive beside the install, then swaps the pieces into place:
// sidecars first, so a failure part-way leaves the previous — still working —
// executable running, and the binary last via either an atomic rename over
// the executing file (POSIX permits renaming an open file; the running
// process keeps its old inode until it exits) or the Windows rename-aside
// dance above.
export async function installNativeArchive(
  execPath: string,
  bytes: Uint8Array,
  target: NativeReleaseTarget,
): Promise<void> {
  // install.sh / install.ps1 lay out <root>/bin/mu next to <root>/mu-path/rg.
  const root = dirname(dirname(execPath));
  const staging = join(root, `.mu-update-${process.pid}`);
  const archivePath = join(staging, NATIVE_ASSET_NAME[target]);
  const extractDir = join(staging, "extract");
  try {
    await mkdir(extractDir, { recursive: true });
    await writeFile(archivePath, bytes);
    await extractArchive(archivePath, extractDir);

    const staged = join(extractDir, `mu-${target}`);
    const stagedBinary = join(staged, "bin", NATIVE_BINARY_NAME[target]);
    if (!(await pathExists(stagedBinary))) {
      throw new Error(
        `${NATIVE_ASSET_NAME[target]} did not contain bin/${NATIVE_BINARY_NAME[target]}`,
      );
    }

    for (const entry of OWNED_ENTRIES) {
      const source = join(staged, entry);
      if (!(await pathExists(source))) continue;
      const destination = join(root, entry);
      await rm(destination, { recursive: true, force: true });
      await rename(source, destination);
    }

    if (process.platform === "win32") {
      await installByRenamingAside(execPath, stagedBinary);
    } else {
      await chmod(stagedBinary, 0o755);
      await rename(stagedBinary, execPath);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
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
  manager: "npm" | "bun",
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
    const installation = await detectInstallationMethod(options);
    if (!installation) {
      throw new Error(
        "this installation is not a global npm or Bun package, or a github-release native " +
          "install; update it using the same method you installed it with",
      );
    }
    const manager = installation.manager;

    io.stdout(`Checking ${options.packageName} for updates...\n`);
    const fetcher = options.fetch ?? fetch;
    const repo = options.repo ?? DEFAULT_GITHUB_REPO;
    const tag = manager === "native" ? await latestGithubTag(repo, fetcher) : undefined;
    const latest =
      tag !== undefined
        ? tag.replace(/^v/, "")
        : await latestVersion(options.packageName, options.registry ?? DEFAULT_REGISTRY, fetcher);
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

    if (installation.manager === "native") {
      const { target, execPath } = installation;
      const assetName = NATIVE_ASSET_NAME[target];
      io.stdout(`Updating mu ${options.currentVersion} → ${latest}...\n`);
      const [bytes, sumsBytes] = await Promise.all([
        downloadReleaseAsset(repo, tag as string, assetName, fetcher),
        downloadReleaseAsset(repo, tag as string, "SHA256SUMS", fetcher),
      ]);
      const expected = digestForAsset(new TextDecoder().decode(sumsBytes), assetName);
      if (!expected) throw new Error(`SHA256SUMS did not list a digest for ${assetName}`);
      const actual = sha256Hex(bytes);
      if (actual !== expected) {
        throw new Error(`downloaded ${assetName} failed its published SHA-256 check`);
      }
      await (options.installNative ?? installNativeArchive)(execPath, bytes, target);
      io.stdout(`Updated mu to ${latest}. Restart mu to use the new version.\n`);
      return 0;
    }

    io.stdout(`Updating mu ${options.currentVersion} → ${latest} with ${manager}...\n`);
    const command = updateCommand(
      installation.manager,
      options.packageName,
      latest,
      installation.manager === "npm" ? installation.npmPrefix : undefined,
    );
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

export interface SelfUninstallOptions extends InstallationDetectionOptions {
  // Also delete ~/.mu (config, credentials, session/checkpoint state), not
  // just the binary. Off by default: it's the one part of this operation
  // that can't be undone by reinstalling.
  purgeData?: boolean | undefined;
  home?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  runCommand?: ((command: string[]) => Promise<number>) | undefined;
  removeNativeInstall?: ((execPath: string) => Promise<void>) | undefined;
  removeWindowsPathEntry?: ((installDir: string) => Promise<void>) | undefined;
  removeDataDir?: ((home: string) => Promise<void>) | undefined;
}

async function defaultRemoveNativeInstall(execPath: string): Promise<void> {
  await rm(execPath, { force: true });
  await rm(join(dirname(execPath), NATIVE_RECEIPT_FILENAME), { force: true });
  // The rest of what the release archive unpacked; user state under ~/.mu is
  // left for the caller's --purge handling.
  const root = dirname(dirname(execPath));
  for (const entry of OWNED_ENTRIES) {
    await rm(join(root, entry), { recursive: true, force: true });
  }
}

// install.ps1 adds the install dir to the user's PATH by editing the
// registry-backed User PATH env var directly; only PowerShell can undo that
// the same way. Best-effort: a failure here leaves a harmless stale PATH
// entry pointing at a now-empty directory, not a broken install.
async function defaultRemoveWindowsPathEntry(installDir: string): Promise<void> {
  const escaped = installDir.replace(/'/g, "''");
  const script = [
    `$dir = '${escaped}'.TrimEnd('\\')`,
    "$userPath = [Environment]::GetEnvironmentVariable('PATH','User')",
    "if ($userPath) {",
    "  $parts = $userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ne $dir }",
    "  [Environment]::SetEnvironmentVariable('PATH', ($parts -join ';'), 'User')",
    "}",
  ].join("\n");
  const child = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`powershell exited with status ${code}`);
}

async function defaultRemoveDataDir(home: string): Promise<void> {
  await rm(join(home, ".mu"), { recursive: true, force: true });
}

function uninstallCommand(
  manager: "npm" | "bun",
  packageName: string,
  npmPrefix?: string,
): string[] {
  return manager === "bun"
    ? ["bun", "remove", "--global", packageName]
    : ["npm", ...(npmPrefix ? ["--prefix", npmPrefix] : []), "uninstall", "--global", packageName];
}

export async function runSelfUninstall(
  options: SelfUninstallOptions,
  io: SelfUpdateIo,
): Promise<number> {
  try {
    const installation = await detectInstallationMethod(options);
    if (!installation) {
      throw new Error(
        "this installation is not a global npm or Bun package, or a github-release native " +
          "install; remove it using the same method you installed it with",
      );
    }

    if (installation.manager === "native") {
      const { execPath } = installation;
      io.stdout(`Removing ${execPath}...\n`);
      await (options.removeNativeInstall ?? defaultRemoveNativeInstall)(execPath);
      if ((options.platform ?? process.platform) === "win32") {
        try {
          await (options.removeWindowsPathEntry ?? defaultRemoveWindowsPathEntry)(
            dirname(execPath),
          );
        } catch (error) {
          io.stderr(
            `mu: could not remove ${dirname(execPath)} from your PATH automatically: ` +
              `${errorMessage(error)}\n`,
          );
        }
      }
    } else {
      const manager = installation.manager;
      const command = uninstallCommand(
        manager,
        options.packageName,
        manager === "npm" ? installation.npmPrefix : undefined,
      );
      io.stdout(`Removing ${options.packageName} with ${manager}...\n`);
      const exitCode = await (options.runCommand ?? runUpdateCommand)(command);
      if (exitCode !== 0) throw new Error(`${manager} exited with status ${exitCode}`);
    }
    io.stdout("Removed mu.\n");

    const home = options.home ?? homedir();
    const dataDir = join(home, ".mu");
    if (options.purgeData) {
      await (options.removeDataDir ?? defaultRemoveDataDir)(home);
      io.stdout(`Deleted ${dataDir} (config, credentials, sessions, checkpoints).\n`);
    } else {
      io.stdout(`Left ${dataDir} in place. Run 'mu self uninstall --purge' to remove it too.\n`);
    }
    return 0;
  } catch (error) {
    io.stderr(`mu: uninstall failed: ${errorMessage(error)}\n`);
    return 1;
  }
}
