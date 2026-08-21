// Package-boundary proof against the artifacts a user would actually install.
// A workspace import proves nothing here: these tests build both products, pack
// them, and read what is inside the two tarballs.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..", "..", "..");
const skip = process.platform === "win32";

interface Tarball {
  path: string;
  entries: string[];
  manifest: Record<string, unknown>;
  read: (entry: string) => Promise<string>;
}

async function run(command: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code}):\n${err}\n${out}`);
  return out;
}

async function pack(packageDir: string, destination: string): Promise<Tarball> {
  // `bun pm pack` runs prepack, so the tarball is built from source every time
  // rather than from whatever happened to be in dist.
  await run(
    ["bun", "pm", "pack", "--quiet", "--destination", destination],
    join(repositoryRoot, packageDir),
  );
  const listing = await run(["sh", "-c", `ls ${destination}/*.tgz`], repositoryRoot);
  const path = listing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) as string;
  const entries = (await run(["tar", "-tzf", path], repositoryRoot))
    .split("\n")
    .map((line) => line.trim().replace(/^package\//, ""))
    .filter((line) => line.length > 0 && !line.endsWith("/"));
  const read = async (entry: string) =>
    run(["tar", "-xzOf", path, `package/${entry}`], repositoryRoot);
  return {
    path,
    entries,
    manifest: JSON.parse(await read("package.json")) as Record<string, unknown>,
    read,
  };
}

let workspace: string;
let browser: Tarball;
let coding: Tarball;

beforeAll(async () => {
  if (skip) return;
  workspace = await mkdtemp(join(tmpdir(), "mu-tarballs-"));
  browser = await pack("packages/browser-cli", join(workspace, "browser"));
  coding = await pack("packages/cli", join(workspace, "coding"));
}, 300_000);

function dependencyNames(manifest: Record<string, unknown>): string[] {
  return ["dependencies", "optionalDependencies", "peerDependencies"].flatMap((field) =>
    Object.keys((manifest[field] as Record<string, string>) ?? {}),
  );
}

describe.skipIf(skip)("the browser tarball", () => {
  test("ships exactly its declared files and nothing else", () => {
    const outsideTypes = browser.entries.filter((entry) => !entry.startsWith("dist/types/")).sort();
    expect(outsideTypes).toEqual([
      "LICENSE",
      "README.md",
      "THIRD_PARTY_LICENSES.txt",
      "dist/index.js",
      "dist/mu-browser.js",
      "package.json",
    ]);
    expect(browser.entries.some((entry) => entry.startsWith("dist/types/"))).toBe(true);
  });

  test("exposes only the mu-browser executable, and it is in the tarball", () => {
    expect(browser.manifest.bin).toEqual({ "mu-browser": "./dist/mu-browser.js" });
    expect(browser.entries).toContain("dist/mu-browser.js");
    expect(browser.entries).not.toContain("dist/mu.js");
  });

  test("declares no dependency on the coding product and no browser runtime package", () => {
    expect(dependencyNames(browser.manifest)).toEqual(["zod"]);
    expect(JSON.stringify(browser.manifest)).not.toContain("@mu-agent/mu");
  });

  test("its declaration bundle resolves inside the package, not to a workspace name", async () => {
    const types = await browser.read("dist/types/index.d.ts");
    expect(types).toContain("./profile-browser/profile/index.js");
    expect(types).not.toContain('from "@mu/');
    expect(types).not.toContain('from "mu"');
    expect(browser.entries).toContain("dist/types/index.d.ts");
    expect(browser.entries.some((entry) => entry.includes("profile-coding"))).toBe(false);
  });

  test("carries no coding profile module, tool, prompt or renderer", async () => {
    const bundle = await browser.read("dist/mu-browser.js");
    for (const coded of [
      "codingProfile",
      "ShadowCheckpointProvider",
      "InstructionLoader",
      "AGENTS.md",
      "ripgrep",
      "@mu-agent/mu",
    ]) {
      expect(bundle).not.toContain(coded);
    }
  });

  test("carries no test scaffolding, browser profile or credential", () => {
    for (const entry of browser.entries) {
      expect(entry).not.toMatch(/\.test\.|__tests__|spikes?\//i);
      // The driver conformance harness and the loopback web fixture are test
      // packages; the fake driver itself is a shipped connection mode.
      expect(entry).not.toMatch(/profile-browser\/testing\/|browser-fixture/);
      expect(entry).not.toMatch(/cookies|credential|auth\.json|resume\.pdf/i);
      expect(entry).not.toMatch(/^profiles\/|\.config\/google-chrome/);
    }
    expect(browser.entries).toContain("dist/types/profile-browser/drivers/fake/driver.d.ts");
  });

  // Dropping the conformance harness from the declaration bundle must not leave
  // a re-export pointing at a file that is no longer there.
  test("every relative import in the declaration bundle resolves inside the tarball", async () => {
    const declarations = browser.entries.filter((entry) => entry.endsWith(".d.ts"));
    const present = new Set(declarations);
    const dangling: string[] = [];
    for (const entry of declarations) {
      const source = await browser.read(entry);
      for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const target = join(entry, "..", (match[1] as string).replace(/\.js$/, ".d.ts"));
        if (!present.has(target)) dangling.push(`${entry} -> ${match[1]}`);
      }
    }
    expect(dangling).toEqual([]);
  }, 120_000);

  test("bundles no personal document or applicant profile", async () => {
    const bundle = await browser.read("dist/mu-browser.js");
    expect(bundle).not.toContain("SYNTHETIC_APPLICANT");
    expect(bundle).not.toContain("POISONED_RESUME");
  });
});

describe.skipIf(skip)("the coding tarball is unchanged by the browser product", () => {
  test("exposes only the mu executable", () => {
    expect(coding.manifest.bin).toEqual({ mu: "./dist/mu.js" });
    expect(coding.entries).not.toContain("dist/mu-browser.js");
  });

  test("declares no dependency on the browser product", () => {
    expect(JSON.stringify(coding.manifest)).not.toContain("@mu-agent/browser");
    expect(dependencyNames(coding.manifest)).toEqual([
      "zod",
      "@mu-agent/ripgrep-darwin-arm64",
      "@mu-agent/ripgrep-linux-x64",
      "@mu-agent/ripgrep-windows-x64",
    ]);
  });

  test("ships no browser profile module or browser declaration", async () => {
    expect(coding.entries.some((entry) => entry.includes("profile-browser"))).toBe(false);
    const bundle = await coding.read("dist/mu.js");
    for (const browserOnly of ["browserProfile", "browser_status", "BrowserDriverError"]) {
      expect(bundle).not.toContain(browserOnly);
    }
  });
});

describe.skipIf(skip)("installing both products", () => {
  test("neither tarball contains the other's public package", () => {
    expect(browser.entries.some((entry) => entry.includes("mu-agent-mu"))).toBe(false);
    expect(coding.entries.some((entry) => entry.includes("mu-agent-browser"))).toBe(false);
    expect(basename(browser.path)).not.toBe(basename(coding.path));
  });

  test("their bin names, package names and installed paths are disjoint", () => {
    const browserBins = Object.keys(browser.manifest.bin as Record<string, string>);
    const codingBins = Object.keys(coding.manifest.bin as Record<string, string>);
    expect(browserBins.filter((name) => codingBins.includes(name))).toEqual([]);
    expect(browser.manifest.name).not.toBe(coding.manifest.name);
  });

  test("unpacking both into one prefix overwrites nothing", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "mu-dual-install-"));
    try {
      for (const [tarball, name] of [
        [browser, "@mu-agent/browser"],
        [coding, "@mu-agent/mu"],
      ] as const) {
        const target = join(prefix, "node_modules", name);
        await run(["mkdir", "-p", target], repositoryRoot);
        await run(
          ["tar", "-xzf", tarball.path, "-C", target, "--strip-components=1"],
          repositoryRoot,
        );
      }
      const browserManifest = JSON.parse(
        await readFile(
          join(prefix, "node_modules", "@mu-agent", "browser", "package.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const codingManifest = JSON.parse(
        await readFile(join(prefix, "node_modules", "@mu-agent", "mu", "package.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(browserManifest.name).toBe("@mu-agent/browser");
      expect(codingManifest.name).toBe("@mu-agent/mu");
      // Both executables survive side by side, each in its own package directory.
      expect(
        await Bun.file(
          join(prefix, "node_modules", "@mu-agent", "browser", "dist", "mu-browser.js"),
        ).exists(),
      ).toBe(true);
      expect(
        await Bun.file(join(prefix, "node_modules", "@mu-agent", "mu", "dist", "mu.js")).exists(),
      ).toBe(true);
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  });

  test("the packed browser executable runs its own help and doctor", async () => {
    // The same bundle the tarball carries, run from the directory it was built in.
    const built = join(repositoryRoot, "packages", "browser-cli", "dist", "mu-browser.js");
    const text = await run(["bun", built, "--help"], repositoryRoot);
    expect(text).toContain("mu-browser — a general-purpose browser automation agent");
    const doctor = await run(["bun", built, "doctor"], repositoryRoot);
    expect(doctor).toContain("No network was used and no browser was launched.");
  }, 60_000);
});
