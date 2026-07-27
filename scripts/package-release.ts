import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type ReleaseTarget = "linux-x64" | "darwin-arm64" | "windows-x64";

export interface RipgrepArtifact {
  version: string;
  size: number;
  digest: string;
  url: string;
  archiveMember: string;
  format: "tar.gz" | "zip";
}

export interface ReleaseSpec {
  target: ReleaseTarget;
  binaryName: string;
  packagedBinaryName: string;
  rgName: string;
  archiveFormat: "tar.gz" | "zip";
  ripgrep: RipgrepArtifact;
}

export interface PackageReleaseOptions {
  binaryPath?: string;
  outputPath?: string;
  rgArchivePath?: string;
  cacheDir?: string;
  smoke?: boolean;
  fetcher?: typeof fetch;
}

export interface PrepareRipgrepOptions {
  rgArchivePath?: string;
  cacheDir?: string;
  fetcher?: typeof fetch;
}

const RIPGREP_VERSION = "15.2.0";
const RIPGREP_RELEASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}`;

export const RELEASE_SPECS: Record<ReleaseTarget, ReleaseSpec> = {
  "linux-x64": {
    target: "linux-x64",
    binaryName: "mu-linux-x64",
    packagedBinaryName: "mu",
    rgName: "rg",
    archiveFormat: "tar.gz",
    ripgrep: {
      version: RIPGREP_VERSION,
      size: 2_265_718,
      digest: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
      url: `${RIPGREP_RELEASE}/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
      archiveMember: `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl/rg`,
      format: "tar.gz",
    },
  },
  "darwin-arm64": {
    target: "darwin-arm64",
    binaryName: "mu-darwin-arm64",
    packagedBinaryName: "mu",
    rgName: "rg",
    archiveFormat: "tar.gz",
    ripgrep: {
      version: RIPGREP_VERSION,
      size: 1_764_284,
      digest: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
      url: `${RIPGREP_RELEASE}/ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin.tar.gz`,
      archiveMember: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin/rg`,
      format: "tar.gz",
    },
  },
  "windows-x64": {
    target: "windows-x64",
    binaryName: "mu-windows-x64.exe",
    packagedBinaryName: "mu.exe",
    rgName: "rg.exe",
    archiveFormat: "zip",
    ripgrep: {
      version: RIPGREP_VERSION,
      size: 1_789_611,
      digest: "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
      url: `${RIPGREP_RELEASE}/ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip`,
      archiveMember: `ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc/rg.exe`,
      format: "zip",
    },
  },
};

export function isReleaseTarget(value: string | undefined): value is ReleaseTarget {
  return value !== undefined && Object.hasOwn(RELEASE_SPECS, value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyArchive(path: string, artifact: RipgrepArtifact): Promise<void> {
  const info = await stat(path);
  if (info.size !== artifact.size) {
    throw new Error(`ripgrep archive ${path} has size ${info.size}; expected ${artifact.size}`);
  }
  const digest = sha256(await readFile(path));
  if (digest !== artifact.digest) {
    throw new Error(`ripgrep archive ${path} has SHA-256 ${digest}; expected ${artifact.digest}`);
  }
}

async function cachedArchiveIsValid(path: string, artifact: RipgrepArtifact): Promise<boolean> {
  try {
    await verifyArchive(path, artifact);
    return true;
  } catch {
    await rm(path, { force: true });
    return false;
  }
}

async function downloadArchive(
  artifact: RipgrepArtifact,
  cacheDir: string,
  fetcher: typeof fetch,
): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, basename(new URL(artifact.url).pathname));
  if (await cachedArchiveIsValid(archivePath, artifact)) return archivePath;

  const response = await fetcher(artifact.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`could not download ripgrep: HTTP ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.digest) {
    throw new Error("downloaded ripgrep archive failed its pinned size or SHA-256 check");
  }

  const temporaryPath = `${archivePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, bytes, { mode: 0o600 });
  try {
    await rename(temporaryPath, archivePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return archivePath;
}

async function runCommand(command: string[], cwd?: string): Promise<string> {
  const process = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  return stdout;
}

function hostMatches(target: ReleaseTarget): boolean {
  return (
    (target === "linux-x64" && process.platform === "linux" && process.arch === "x64") ||
    (target === "darwin-arm64" && process.platform === "darwin" && process.arch === "arm64") ||
    (target === "windows-x64" && process.platform === "win32" && process.arch === "x64")
  );
}

async function createArchive(
  spec: ReleaseSpec,
  stagingDir: string,
  packageName: string,
  outputPath: string,
): Promise<void> {
  await rm(outputPath, { force: true });
  if (spec.archiveFormat === "tar.gz") {
    await runCommand(["tar", "-czf", outputPath, "-C", stagingDir, packageName]);
    return;
  }

  if (process.platform === "win32") {
    await runCommand(["tar", "-a", "-cf", outputPath, "-C", stagingDir, packageName]);
    return;
  }

  await runCommand(["zip", "-qr", outputPath, packageName], stagingDir);
}

async function obtainRipgrepArchive(
  spec: ReleaseSpec,
  options: PrepareRipgrepOptions,
): Promise<string> {
  const cacheDir = resolve(options.cacheDir ?? join(tmpdir(), "mu-release-cache", spec.target));
  const archivePath = options.rgArchivePath
    ? resolve(options.rgArchivePath)
    : await downloadArchive(spec.ripgrep, cacheDir, options.fetcher ?? fetch);
  await verifyArchive(archivePath, spec.ripgrep);
  return archivePath;
}

async function extractRipgrepArchive(
  spec: ReleaseSpec,
  archivePath: string,
  extractDir: string,
): Promise<void> {
  if (spec.ripgrep.format === "zip" && process.platform !== "win32") {
    await runCommand(["unzip", "-q", archivePath, "-d", extractDir]);
    return;
  }
  await runCommand(["tar", "-xf", archivePath, "-C", extractDir]);
}

export async function prepareRipgrepPackage(
  spec: ReleaseSpec,
  packageDir: string,
  options: PrepareRipgrepOptions = {},
): Promise<void> {
  const archivePath = await obtainRipgrepArchive(spec, options);
  const stagingDir = await mkdtemp(join(tmpdir(), "mu-ripgrep-package-"));
  const extractDir = join(stagingDir, "ripgrep");
  const vendorDir = resolve(packageDir, "vendor");
  try {
    await mkdir(extractDir, { recursive: true });
    await extractRipgrepArchive(spec, archivePath, extractDir);
    const rgSource = join(extractDir, spec.ripgrep.archiveMember);
    const sourceRoot = dirname(rgSource);
    await mkdir(vendorDir, { recursive: true });
    await Promise.all([
      copyFile(rgSource, join(vendorDir, spec.rgName)),
      copyFile(join(sourceRoot, "LICENSE-MIT"), resolve(packageDir, "LICENSE-MIT")),
      copyFile(join(sourceRoot, "UNLICENSE"), resolve(packageDir, "UNLICENSE")),
    ]);
    if (spec.target !== "windows-x64") {
      await chmod(join(vendorDir, spec.rgName), 0o755);
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export async function packageRelease(
  spec: ReleaseSpec,
  options: PackageReleaseOptions = {},
): Promise<string> {
  const binaryPath = resolve(options.binaryPath ?? join("dist", spec.binaryName));
  const packageName = `mu-${spec.target}`;
  const outputPath = resolve(
    options.outputPath ?? join("dist", `${packageName}.${spec.archiveFormat}`),
  );
  const rgArchivePath = await obtainRipgrepArchive(spec, options);
  await stat(binaryPath);

  const stagingDir = await mkdtemp(join(tmpdir(), "mu-release-"));
  const packageDir = join(stagingDir, packageName);
  const binDir = join(packageDir, "bin");
  const pathDir = join(packageDir, "mu-path");
  const licenseDir = join(packageDir, "licenses", "ripgrep");
  const extractDir = join(stagingDir, "ripgrep");

  try {
    await Promise.all([
      mkdir(binDir, { recursive: true }),
      mkdir(pathDir, { recursive: true }),
      mkdir(licenseDir, { recursive: true }),
      mkdir(extractDir, { recursive: true }),
    ]);
    await extractRipgrepArchive(spec, rgArchivePath, extractDir);

    const rgSource = join(extractDir, spec.ripgrep.archiveMember);
    const sourceRoot = dirname(rgSource);
    const packagedBinary = join(binDir, spec.packagedBinaryName);
    const packagedRg = join(pathDir, spec.rgName);
    await Promise.all([
      copyFile(binaryPath, packagedBinary),
      copyFile(rgSource, packagedRg),
      copyFile(join(sourceRoot, "LICENSE-MIT"), join(licenseDir, "LICENSE-MIT")),
      copyFile(join(sourceRoot, "UNLICENSE"), join(licenseDir, "UNLICENSE")),
    ]);
    if (spec.target !== "windows-x64") {
      await Promise.all([chmod(packagedBinary, 0o755), chmod(packagedRg, 0o755)]);
    }

    await writeFile(
      join(packageDir, "mu-package.json"),
      `${JSON.stringify(
        {
          layoutVersion: 1,
          target: spec.target,
          entrypoint: `bin/${spec.packagedBinaryName}`,
          pathDir: "mu-path",
          ripgrepVersion: spec.ripgrep.version,
          ripgrepArchiveSha256: spec.ripgrep.digest,
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(packageDir, "README.txt"),
      `mu ${spec.target}\n\nRun bin/${spec.packagedBinaryName} from this extracted directory.\n`,
    );

    if (options.smoke !== false && hostMatches(spec.target)) {
      await runCommand([packagedBinary, "--version"]);
      const version = await runCommand([packagedRg, "--version"]);
      if (!version.startsWith(`ripgrep ${spec.ripgrep.version}`)) {
        throw new Error(`packaged ripgrep reported an unexpected version: ${version.trim()}`);
      }
    }

    await mkdir(dirname(outputPath), { recursive: true });
    await createArchive(spec, stagingDir, packageName, outputPath);
    return outputPath;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

function parseArgs(args: string[]): {
  target: ReleaseTarget;
  options: PackageReleaseOptions;
} {
  const target = args[0] as ReleaseTarget | undefined;
  if (!isReleaseTarget(target)) {
    throw new Error(`usage: package-release.ts <${Object.keys(RELEASE_SPECS).join("|")}>`);
  }

  const options: PackageReleaseOptions = {};
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--binary") options.binaryPath = value;
    else if (flag === "--output") options.outputPath = value;
    else if (flag === "--rg-archive") options.rgArchivePath = value;
    else if (flag === "--cache-dir") options.cacheDir = value;
    else throw new Error(`unknown option ${flag}`);
    i++;
  }
  return { target, options };
}

if (import.meta.main) {
  try {
    const { target, options } = parseArgs(process.argv.slice(2));
    const output = await packageRelease(RELEASE_SPECS[target], options);
    console.log(`packaged ${output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
