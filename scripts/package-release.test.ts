import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  packageRelease,
  prepareRipgrepPackage,
  RELEASE_SPECS,
  type ReleaseSpec,
} from "./package-release.ts";

async function command(args: string[], cwd?: string): Promise<string> {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mu-release-test-"));
  const sourceRoot = join(root, "ripgrep-test");
  await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, "rg"), "fixture-rg");
  await writeFile(join(sourceRoot, "LICENSE-MIT"), "MIT");
  await writeFile(join(sourceRoot, "UNLICENSE"), "Unlicense");
  const archive = join(root, "rg.tar.gz");
  await command(["tar", "-czf", archive, "-C", root, "ripgrep-test"]);
  const bytes = await readFile(archive);
  const binary = join(root, "mu");
  await writeFile(binary, "fixture-mu");
  await chmod(binary, 0o755);

  const spec: ReleaseSpec = {
    target: "linux-x64",
    binaryName: "mu",
    packagedBinaryName: "mu",
    rgName: "rg",
    archiveFormat: "tar.gz",
    ripgrep: {
      version: "test",
      size: bytes.byteLength,
      digest: createHash("sha256").update(bytes).digest("hex"),
      url: "https://invalid.example/rg.tar.gz",
      archiveMember: "ripgrep-test/rg",
      format: "tar.gz",
    },
  };
  return { root, archive, binary, spec };
}

describe("release packaging", () => {
  test("publishes npm packages through trusted publishing after CI", async () => {
    const ci = await readFile(".github/workflows/ci.yml", "utf8");
    const release = await readFile(".github/workflows/release.yml", "utf8");

    expect(ci).toContain("id-token: write");
    expect(ci).toContain("npm publish --access public");
    expect(ci).toContain("github.ref == 'refs/heads/main'");
    expect(ci).not.toContain("NPM_CONFIG_TOKEN");
    expect(release).not.toContain("npm publish");
    expect(release).not.toContain("NPM_CONFIG_TOKEN");
  });

  test("the pinned artifacts cover every native release target", () => {
    expect(Object.keys(RELEASE_SPECS).sort()).toEqual(["darwin-arm64", "linux-x64", "windows-x64"]);
    for (const spec of Object.values(RELEASE_SPECS)) {
      expect(spec.ripgrep.version).toBe("15.2.0");
      expect(spec.ripgrep.digest).toHaveLength(64);
      expect(spec.ripgrep.url).toStartWith("https://github.com/BurntSushi/ripgrep/");
    }
  });

  test("Windows workflows install the pinned baseline Bun runtime before compiling", async () => {
    const rootPackage = JSON.parse(await readFile("package.json", "utf8")) as {
      packageManager: string;
    };
    const version = rootPackage.packageManager.replace(/^bun@/, "");
    const baselineUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-windows-x64-baseline.zip`;
    const [ci, release] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
    ]);

    expect(ci).toContain(baselineUrl);
    expect(release).toContain(baselineUrl);
  });

  test("builds the canonical sidecar layout with licenses and metadata", async () => {
    const { root, archive, binary, spec } = await fixture();
    const output = join(root, "mu-linux-x64.tar.gz");
    await packageRelease(spec, {
      binaryPath: binary,
      outputPath: output,
      rgArchivePath: archive,
      smoke: false,
    });

    expect((await stat(output)).size).toBeGreaterThan(0);
    const listing = await command(["tar", "-tzf", output]);
    expect(listing).toContain("mu-linux-x64/bin/mu");
    expect(listing).toContain("mu-linux-x64/mu-path/rg");
    expect(listing).toContain("mu-linux-x64/licenses/ripgrep/LICENSE-MIT");
    expect(listing).toContain("mu-linux-x64/licenses/ripgrep/UNLICENSE");
    expect(listing).toContain("mu-linux-x64/licenses/highlight.js/LICENSE");
    expect(listing).toContain("mu-linux-x64/mu-package.json");
  });

  test("prepares an npm platform package without a postinstall download", async () => {
    const { root, archive, spec } = await fixture();
    const packageDir = join(root, "npm-package");
    await mkdir(packageDir);
    await prepareRipgrepPackage(spec, packageDir, { rgArchivePath: archive });

    expect(await readFile(join(packageDir, "vendor", "rg"), "utf8")).toBe("fixture-rg");
    expect(await readFile(join(packageDir, "LICENSE-MIT"), "utf8")).toBe("MIT");
    expect(await readFile(join(packageDir, "UNLICENSE"), "utf8")).toBe("Unlicense");
  });

  test("npm release packages share public metadata while platform versions stay pinned", async () => {
    const cli = JSON.parse(await readFile("packages/cli/package.json", "utf8")) as {
      name: string;
      version: string;
      author: string;
      license: string;
      main: string;
      types: string;
      exports: { ".": { types: string; import: string; default: string } };
      bin: { mu: string };
      files: string[];
      dependencies: Record<string, string>;
      optionalDependencies: Record<string, string>;
      repository: { url: string };
      publishConfig: { access: string; registry: string };
    };
    expect(cli.name).toBe("@mu-agent/mu");
    expect(cli.author).toBe("Spandan Chavan");
    expect(cli.license).toBe("MIT");
    expect(cli.repository.url).toBe("git+https://github.com/Spandan7724/mu.git");
    expect(cli.main).toBe("./dist/index.js");
    expect(cli.types).toBe("./dist/types/index.d.ts");
    expect(cli.exports["."]).toEqual({
      types: "./dist/types/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    });
    expect(cli.bin).toEqual({ mu: "./dist/mu.js" });
    expect(cli.files).toContain("dist/index.js");
    expect(cli.files).toContain("dist/types");
    expect(cli.dependencies).toEqual({ zod: "4.4.3" });
    expect(cli.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
    });

    const platformPackages = {
      "packages/ripgrep-linux-x64": "@mu-agent/ripgrep-linux-x64",
      "packages/ripgrep-darwin-arm64": "@mu-agent/ripgrep-darwin-arm64",
      "packages/ripgrep-windows-x64": "@mu-agent/ripgrep-windows-x64",
    };
    expect(cli.optionalDependencies).toEqual(
      Object.fromEntries(Object.values(platformPackages).map((name) => [name, "0.0.1"])),
    );

    for (const [directory, name] of Object.entries(platformPackages)) {
      const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        name: string;
        version: string;
        author: string;
        repository: { url: string };
        publishConfig: { access: string; registry: string };
      };
      expect(packageJson.name).toBe(name);
      expect(packageJson.version).toBe("0.0.1");
      expect(packageJson.author).toBe(cli.author);
      expect(packageJson.repository.url).toBe(cli.repository.url);
      expect(packageJson.publishConfig).toEqual(cli.publishConfig);
    }
  });

  test("rejects a ripgrep archive that does not match the pinned digest", async () => {
    const { root, archive, binary, spec } = await fixture();
    await writeFile(archive, "tampered");

    await expect(
      packageRelease(spec, {
        binaryPath: binary,
        outputPath: join(root, "output.tar.gz"),
        rgArchivePath: archive,
        smoke: false,
      }),
    ).rejects.toThrow("expected");
  });
});
