import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareSemver,
  installByRenamingAside,
  installNativeArchive,
  npmPrefixFromInstallPath,
  packageManagerFromInstallPaths,
  runSelfUninstall,
  runSelfUpdate,
  type SelfUpdateIo,
  type UpdatePackageManager,
} from "./self-update.ts";

const packageName = "@mu-agent/mu";

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: SelfUpdateIo = {
    stdout: (chunk) => stdout.push(chunk),
    stderr: (chunk) => stderr.push(chunk),
  };
  return { stdout, stderr, io };
}

function registry(version: string): typeof fetch {
  return (async () => Response.json({ version })) as unknown as typeof fetch;
}

async function update(
  currentVersion: string,
  latest: string,
  manager: UpdatePackageManager = "npm",
) {
  const commands: string[][] = [];
  const sink = output();
  const exitCode = await runSelfUpdate(
    {
      currentVersion,
      packageName,
      packageManager: manager,
      fetch: registry(latest),
      runCommand: async (command) => {
        commands.push(command);
        return 0;
      },
    },
    sink.io,
  );
  return { ...sink, commands, exitCode };
}

describe("semantic version comparison", () => {
  test("orders stable, prerelease, and large versions", () => {
    expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareSemver("1.2.3-beta.2", "1.2.3")).toBeLessThan(0);
    expect(compareSemver("1.2.3-beta.10", "1.2.3-beta.2")).toBeGreaterThan(0);
    expect(compareSemver("100000000000000000000.0.0", "99999999999999999999.0.0")).toBeGreaterThan(
      0,
    );
    expect(compareSemver("1.2.3+build.1", "1.2.3+build.2")).toBe(0);
  });
});

describe("self update", () => {
  test("installs the exact latest npm version when an update exists", async () => {
    const result = await update("0.0.1", "0.1.0");

    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([
      ["npm", "install", "--global", "--ignore-scripts", `${packageName}@0.1.0`],
    ]);
    expect(result.stdout.join("")).toContain("Updated mu to 0.1.0");
    expect(result.stderr).toEqual([]);
  });

  test("preserves Bun global installations", async () => {
    const result = await update("0.0.1", "0.0.2", "bun");

    expect(result.commands).toEqual([
      ["bun", "install", "--global", "--ignore-scripts", `${packageName}@0.0.2`],
    ]);
  });

  test("does not invoke a package manager when already current or ahead", async () => {
    const current = await update("1.0.0", "1.0.0");
    const ahead = await update("2.0.0", "1.0.0");

    expect(current.commands).toEqual([]);
    expect(current.stdout.join("")).toContain("up to date");
    expect(ahead.commands).toEqual([]);
    expect(ahead.stdout.join("")).toContain("newer than");
  });

  test("reports registry and package-manager failures", async () => {
    const registryFailure = output();
    const registryCode = await runSelfUpdate(
      {
        currentVersion: "0.0.1",
        packageName,
        packageManager: "npm",
        fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
      },
      registryFailure.io,
    );
    const commandFailure = output();
    const commandCode = await runSelfUpdate(
      {
        currentVersion: "0.0.1",
        packageName,
        packageManager: "npm",
        fetch: registry("0.0.2"),
        runCommand: async () => 7,
      },
      commandFailure.io,
    );

    expect(registryCode).toBe(1);
    expect(registryFailure.stderr.join("")).toContain("HTTP 503");
    expect(commandCode).toBe(1);
    expect(commandFailure.stderr.join("")).toContain("status 7");
  });

  test("refuses installations that are not identifiable as global packages", async () => {
    const sink = output();
    const exitCode = await runSelfUpdate(
      {
        currentVersion: "0.0.1",
        packageName,
        entryPath: "/workspace/mu/packages/cli/src/main.ts",
        resolvePath: async (path) => path,
        fetch: (() => {
          throw new Error("should not fetch");
        }) as unknown as typeof fetch,
      },
      sink.io,
    );

    expect(exitCode).toBe(1);
    expect(sink.stderr.join("")).toContain("not a global npm or Bun package");
  });
});

describe("package manager detection", () => {
  test("distinguishes npm, Bun, and local package shims", () => {
    expect(
      packageManagerFromInstallPaths(
        packageName,
        "/usr/local/bin/mu",
        "/usr/local/lib/node_modules/@mu-agent/mu/dist/mu.js",
      ),
    ).toBe("npm");
    expect(
      packageManagerFromInstallPaths(
        packageName,
        "/home/user/.bun/bin/mu",
        "/home/user/.bun/install/global/node_modules/@mu-agent/mu/dist/mu.js",
      ),
    ).toBe("bun");
    expect(
      packageManagerFromInstallPaths(
        packageName,
        "/workspace/node_modules/.bin/mu",
        "/workspace/node_modules/@mu-agent/mu/dist/mu.js",
      ),
    ).toBeUndefined();
  });

  test("preserves custom npm prefixes", async () => {
    const resolved = "/opt/custom/lib/node_modules/@mu-agent/mu/dist/mu.js";
    expect(npmPrefixFromInstallPath(packageName, resolved)).toBe("/opt/custom");

    const commands: string[][] = [];
    const sink = output();
    const exitCode = await runSelfUpdate(
      {
        currentVersion: "0.0.1",
        packageName,
        entryPath: "/opt/custom/bin/mu",
        resolvePath: async () => resolved,
        fetch: registry("0.0.2"),
        runCommand: async (command) => {
          commands.push(command);
          return 0;
        },
      },
      sink.io,
    );

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      [
        "npm",
        "--prefix",
        "/opt/custom",
        "install",
        "--global",
        "--ignore-scripts",
        `${packageName}@0.0.2`,
      ],
    ]);
  });
});

describe("native GitHub-release installs", () => {
  const execPath = "/home/user/.mu/bin/mu";
  const receipt = JSON.stringify({ method: "github-release", target: "linux-x64" });

  function githubFetch(options: {
    tag: string;
    assetBytes: Uint8Array;
    sums: string;
  }): typeof fetch {
    return (async (url: string) => {
      if (url.endsWith("/releases/latest")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url: url.replace(/\/latest$/, `/tag/${options.tag}`),
        } as unknown as Response;
      }
      if (url.endsWith("/SHA256SUMS")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => new TextEncoder().encode(options.sums).buffer,
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => options.assetBytes.buffer,
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  test("downloads, verifies, and installs over the running binary", async () => {
    const assetBytes = new TextEncoder().encode("fake binary contents");
    const sums = `${sha256Hex(assetBytes)}  mu-linux-x64.tar.gz\n`;
    const installed: { execPath: string; bytes: Uint8Array }[] = [];
    const sink = output();

    const exitCode = await runSelfUpdate(
      {
        currentVersion: "0.0.1",
        packageName,
        execPath,
        readReceipt: async () => receipt,
        fetch: githubFetch({ tag: "v0.1.0", assetBytes, sums }),
        installNative: async (path, bytes) => {
          installed.push({ execPath: path, bytes });
        },
      },
      sink.io,
    );

    expect(exitCode).toBe(0);
    expect(installed).toEqual([{ execPath, bytes: assetBytes }]);
    expect(sink.stdout.join("")).toContain("Updated mu to 0.1.0");
  });

  test("refuses to install when the downloaded asset fails its checksum", async () => {
    const assetBytes = new TextEncoder().encode("fake binary contents");
    const sums =
      "0000000000000000000000000000000000000000000000000000000000000000  mu-linux-x64.tar.gz\n";
    let installCalled = false;
    const sink = output();

    const exitCode = await runSelfUpdate(
      {
        currentVersion: "0.0.1",
        packageName,
        execPath,
        readReceipt: async () => receipt,
        fetch: githubFetch({ tag: "v0.1.0", assetBytes, sums }),
        installNative: async () => {
          installCalled = true;
        },
      },
      sink.io,
    );

    expect(exitCode).toBe(1);
    expect(installCalled).toBe(false);
    expect(sink.stderr.join("")).toContain("SHA-256 check");
  });

  test("refuses to install when SHA256SUMS has no entry for the asset", async () => {
    const assetBytes = new TextEncoder().encode("fake binary contents");
    const sums = `${sha256Hex(assetBytes)}  some-other-asset\n`;
    const sink = output();

    const exitCode = await runSelfUpdate(
      {
        currentVersion: "0.0.1",
        packageName,
        execPath,
        readReceipt: async () => receipt,
        fetch: githubFetch({ tag: "v0.1.0", assetBytes, sums }),
      },
      sink.io,
    );

    expect(exitCode).toBe(1);
    expect(sink.stderr.join("")).toContain("did not list a digest");
  });

  test("does not download anything when already up to date", async () => {
    const assetBytes = new TextEncoder().encode("fake binary contents");
    const sink = output();
    let assetRequested = false;

    const exitCode = await runSelfUpdate(
      {
        currentVersion: "0.1.0",
        packageName,
        execPath,
        readReceipt: async () => receipt,
        fetch: (async (url: string) => {
          if (url.endsWith("/releases/latest")) {
            return {
              ok: true,
              url: url.replace(/\/latest$/, "/tag/v0.1.0"),
            } as unknown as Response;
          }
          assetRequested = true;
          return { ok: true, arrayBuffer: async () => assetBytes.buffer } as unknown as Response;
        }) as unknown as typeof fetch,
      },
      sink.io,
    );

    expect(exitCode).toBe(0);
    expect(assetRequested).toBe(false);
    expect(sink.stdout.join("")).toContain("up to date");
  });

  test("falls back to failing closed when no receipt is present", async () => {
    const sink = output();
    const exitCode = await runSelfUpdate(
      {
        currentVersion: "0.0.1",
        packageName,
        execPath,
        readReceipt: async () => undefined,
        fetch: (() => {
          throw new Error("should not fetch");
        }) as unknown as typeof fetch,
      },
      sink.io,
    );

    expect(exitCode).toBe(1);
    expect(sink.stderr.join("")).toContain("not a global npm or Bun package");
  });

  test("ignores a receipt with an unrecognized shape", async () => {
    const sink = output();
    const exitCode = await runSelfUpdate(
      {
        currentVersion: "0.0.1",
        packageName,
        execPath,
        readReceipt: async () => JSON.stringify({ method: "something-else" }),
        fetch: (() => {
          throw new Error("should not fetch");
        }) as unknown as typeof fetch,
      },
      sink.io,
    );

    expect(exitCode).toBe(1);
  });

  test("recognizes a windows-x64 receipt and fetches the .zip asset", async () => {
    const assetBytes = new TextEncoder().encode("fake zip contents");
    const sums = `${sha256Hex(assetBytes)}  mu-windows-x64.zip\n`;
    const installed: { execPath: string; bytes: Uint8Array }[] = [];
    const sink = output();

    const exitCode = await runSelfUpdate(
      {
        currentVersion: "0.0.1",
        packageName,
        execPath: "C:\\Users\\me\\.mu\\bin\\mu.exe",
        readReceipt: async () =>
          JSON.stringify({ method: "github-release", target: "windows-x64" }),
        fetch: githubFetch({ tag: "v0.1.0", assetBytes, sums }),
        installNative: async (path, bytes) => {
          installed.push({ execPath: path, bytes });
        },
      },
      sink.io,
    );

    expect(exitCode).toBe(0);
    expect(installed).toEqual([{ execPath: "C:\\Users\\me\\.mu\\bin\\mu.exe", bytes: assetBytes }]);
  });
});

describe("self uninstall", () => {
  test("uninstalls a global npm package", async () => {
    const commands: string[][] = [];
    const sink = output();
    const exitCode = await runSelfUninstall(
      {
        packageName,
        packageManager: "npm",
        runCommand: async (command) => {
          commands.push(command);
          return 0;
        },
      },
      sink.io,
    );

    expect(exitCode).toBe(0);
    expect(commands).toEqual([["npm", "uninstall", "--global", packageName]]);
    expect(sink.stdout.join("")).toContain("Removed mu.");
    expect(sink.stdout.join("")).toContain("Run 'mu self uninstall --purge'");
  });

  test("uninstalls a global Bun package and preserves a custom npm prefix", async () => {
    const bunCommands: string[][] = [];
    const bunResult = await runSelfUninstall(
      {
        packageName,
        packageManager: "bun",
        runCommand: async (command) => {
          bunCommands.push(command);
          return 0;
        },
      },
      output().io,
    );
    expect(bunResult).toBe(0);
    expect(bunCommands).toEqual([["bun", "remove", "--global", packageName]]);

    const resolved = "/opt/custom/lib/node_modules/@mu-agent/mu/dist/mu.js";
    const npmCommands: string[][] = [];
    const prefixResult = await runSelfUninstall(
      {
        packageName,
        entryPath: "/opt/custom/bin/mu",
        resolvePath: async () => resolved,
        runCommand: async (command) => {
          npmCommands.push(command);
          return 0;
        },
      },
      output().io,
    );
    expect(prefixResult).toBe(0);
    expect(npmCommands).toEqual([
      ["npm", "--prefix", "/opt/custom", "uninstall", "--global", packageName],
    ]);
  });

  test("refuses installations that are not identifiable as global packages", async () => {
    const sink = output();
    const exitCode = await runSelfUninstall(
      {
        packageName,
        entryPath: "/workspace/mu/packages/cli/src/main.ts",
        resolvePath: async (path) => path,
      },
      sink.io,
    );

    expect(exitCode).toBe(1);
    expect(sink.stderr.join("")).toContain("not a global npm or Bun package");
  });

  test("reports a package-manager failure", async () => {
    const sink = output();
    const exitCode = await runSelfUninstall(
      { packageName, packageManager: "npm", runCommand: async () => 7 },
      sink.io,
    );

    expect(exitCode).toBe(1);
    expect(sink.stderr.join("")).toContain("status 7");
  });

  describe("native GitHub-release installs", () => {
    const execPath = "/home/user/.mu/bin/mu";
    const receipt = JSON.stringify({ method: "github-release", target: "linux-x64" });

    test("removes the binary and receipt, and leaves ~/.mu in place by default", async () => {
      const removed: string[] = [];
      const dataDirRemovals: string[] = [];
      const sink = output();

      const exitCode = await runSelfUninstall(
        {
          packageName,
          execPath,
          home: "/home/user",
          readReceipt: async () => receipt,
          removeNativeInstall: async (path) => {
            removed.push(path);
          },
          removeDataDir: async (home) => {
            dataDirRemovals.push(home);
          },
        },
        sink.io,
      );

      expect(exitCode).toBe(0);
      expect(removed).toEqual([execPath]);
      expect(dataDirRemovals).toEqual([]);
      expect(sink.stdout.join("")).toContain("Left /home/user/.mu in place");
    });

    test("--purge also deletes the data directory", async () => {
      const dataDirRemovals: string[] = [];
      const sink = output();

      const exitCode = await runSelfUninstall(
        {
          packageName,
          execPath,
          home: "/home/user",
          purgeData: true,
          readReceipt: async () => receipt,
          removeNativeInstall: async () => {},
          removeDataDir: async (home) => {
            dataDirRemovals.push(home);
          },
        },
        sink.io,
      );

      expect(exitCode).toBe(0);
      expect(dataDirRemovals).toEqual(["/home/user"]);
      expect(sink.stdout.join("")).toContain("Deleted /home/user/.mu");
    });

    test("cleans up the Windows PATH entry for a windows-x64 install", async () => {
      // node:path picks POSIX or win32 semantics from the real process.platform,
      // not from the `platform` option above (which only gates whether cleanup
      // runs) — so this uses forward slashes, which dirname() resolves the same
      // way under both dialects, to stay host-OS-independent.
      const pathRemovals: string[] = [];
      const sink = output();

      const exitCode = await runSelfUninstall(
        {
          packageName,
          execPath: "C:/Users/me/.mu/bin/mu.exe",
          home: "C:/Users/me",
          platform: "win32",
          readReceipt: async () =>
            JSON.stringify({ method: "github-release", target: "windows-x64" }),
          removeNativeInstall: async () => {},
          removeWindowsPathEntry: async (dir) => {
            pathRemovals.push(dir);
          },
        },
        sink.io,
      );

      expect(exitCode).toBe(0);
      expect(pathRemovals).toEqual(["C:/Users/me/.mu/bin"]);
    });

    test("a failed Windows PATH cleanup warns but does not fail the uninstall", async () => {
      const sink = output();

      const exitCode = await runSelfUninstall(
        {
          packageName,
          execPath: "C:\\Users\\me\\.mu\\bin\\mu.exe",
          home: "C:\\Users\\me",
          platform: "win32",
          readReceipt: async () =>
            JSON.stringify({ method: "github-release", target: "windows-x64" }),
          removeNativeInstall: async () => {},
          removeWindowsPathEntry: async () => {
            throw new Error("powershell exited with status 1");
          },
        },
        sink.io,
      );

      expect(exitCode).toBe(0);
      expect(sink.stderr.join("")).toContain("could not remove");
      expect(sink.stdout.join("")).toContain("Removed mu.");
    });

    test("does not touch the Windows PATH on non-Windows platforms", async () => {
      const pathRemovals: string[] = [];
      const exitCode = await runSelfUninstall(
        {
          packageName,
          execPath,
          home: "/home/user",
          platform: "linux",
          readReceipt: async () => receipt,
          removeNativeInstall: async () => {},
          removeWindowsPathEntry: async (dir) => {
            pathRemovals.push(dir);
          },
        },
        output().io,
      );

      expect(exitCode).toBe(0);
      expect(pathRemovals).toEqual([]);
    });
  });
});

describe("installByRenamingAside", () => {
  async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "mu-rename-aside-"));
    try {
      return await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("renames the running binary aside and installs the new one in its place", async () => {
    await withTempDir(async (dir) => {
      const execPath = join(dir, "mu.exe");
      const tempPath = join(dir, "mu.exe.new");
      await writeFile(execPath, "old contents");
      await writeFile(tempPath, "new contents");

      await installByRenamingAside(execPath, tempPath);

      expect(await readFile(execPath, "utf8")).toBe("new contents");
      await expect(readFile(`${execPath}.old`, "utf8")).rejects.toThrow();
      await expect(readFile(tempPath, "utf8")).rejects.toThrow();
    });
  });

  test("restores the original binary if placing the new one fails", async () => {
    await withTempDir(async (dir) => {
      const execPath = join(dir, "mu.exe");
      const missingTempPath = join(dir, "does-not-exist.exe");
      await writeFile(execPath, "old contents");

      await expect(installByRenamingAside(execPath, missingTempPath)).rejects.toThrow();

      // The rollback must leave a working binary at execPath with its
      // original content — a failed update must never delete the old exe.
      expect(await readFile(execPath, "utf8")).toBe("old contents");
      await expect(readFile(`${execPath}.old`, "utf8")).rejects.toThrow();
    });
  });

  test("cleans up a stale .old file left by a previous failed update", async () => {
    await withTempDir(async (dir) => {
      const execPath = join(dir, "mu.exe");
      const tempPath = join(dir, "mu.exe.new");
      await writeFile(execPath, "current contents");
      await writeFile(`${execPath}.old`, "stale leftover");
      await writeFile(tempPath, "new contents");

      await installByRenamingAside(execPath, tempPath);

      expect(await readFile(execPath, "utf8")).toBe("new contents");
    });
  });
});

// The .zip half of this runs only on Windows (bsdtar), which CI does not run
// `bun test` on; the layout logic either path drives is the same.
describe.if(process.platform !== "win32")("installNativeArchive", () => {
  async function withInstall<T>(run: (root: string, execPath: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "mu-archive-install-"));
    const root = join(dir, ".mu");
    await mkdir(join(root, "bin"), { recursive: true });
    try {
      return await run(root, join(root, "bin", "mu"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // A stand-in for mu-<target>.tar.gz with the layout packageRelease produces.
  async function releaseArchive(target: string, binary: string): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), "mu-archive-build-"));
    const packageDir = join(dir, `mu-${target}`);
    try {
      await mkdir(join(packageDir, "bin"), { recursive: true });
      await mkdir(join(packageDir, "mu-path"), { recursive: true });
      await mkdir(join(packageDir, "licenses", "ripgrep"), { recursive: true });
      await writeFile(join(packageDir, "bin", "mu"), binary);
      await writeFile(join(packageDir, "mu-path", "rg"), "new rg", { mode: 0o755 });
      await writeFile(join(packageDir, "licenses", "ripgrep", "UNLICENSE"), "unlicense");
      await writeFile(join(packageDir, "mu-package.json"), '{"layoutVersion":1}');
      const archive = join(dir, "release.tar.gz");
      const child = Bun.spawn(["tar", "-czf", archive, "-C", dir, `mu-${target}`], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await child.exited) !== 0) throw new Error("could not build the test archive");
      return new Uint8Array(await readFile(archive));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("replaces the binary and its sidecars, leaving user state alone", async () => {
    await withInstall(async (root, execPath) => {
      await writeFile(execPath, "old binary");
      await mkdir(join(root, "mu-path"), { recursive: true });
      await writeFile(join(root, "mu-path", "rg"), "old rg");
      await writeFile(join(root, "mu-path", "dropped-in-a-past-release"), "stale");
      await writeFile(join(root, "config.json"), '{"model":"opus"}');
      await mkdir(join(root, "sessions"), { recursive: true });
      await writeFile(join(root, "sessions", "s1.jsonl"), "session data");

      await installNativeArchive(
        execPath,
        await releaseArchive("linux-x64", "new binary"),
        "linux-x64",
      );

      expect(await readFile(execPath, "utf8")).toBe("new binary");
      expect(await readFile(join(root, "mu-path", "rg"), "utf8")).toBe("new rg");
      // mu-path is replaced wholesale, so files a past release left are gone.
      await expect(
        readFile(join(root, "mu-path", "dropped-in-a-past-release"), "utf8"),
      ).rejects.toThrow();
      expect(await readFile(join(root, "mu-package.json"), "utf8")).toBe('{"layoutVersion":1}');
      expect(await readFile(join(root, "config.json"), "utf8")).toBe('{"model":"opus"}');
      expect(await readFile(join(root, "sessions", "s1.jsonl"), "utf8")).toBe("session data");
    });
  });

  test("leaves the installed binary executable", async () => {
    await withInstall(async (_root, execPath) => {
      await writeFile(execPath, "old binary");
      await installNativeArchive(
        execPath,
        await releaseArchive("linux-x64", "new binary"),
        "linux-x64",
      );
      await access(execPath, constants.X_OK);
    });
  });

  test("removes its staging directory on success and on failure", async () => {
    await withInstall(async (root, execPath) => {
      await writeFile(execPath, "old binary");
      await installNativeArchive(
        execPath,
        await releaseArchive("linux-x64", "new binary"),
        "linux-x64",
      );
      expect((await readdir(root)).filter((n) => n.startsWith(".mu-update-"))).toEqual([]);

      await expect(
        installNativeArchive(execPath, new TextEncoder().encode("not an archive"), "linux-x64"),
      ).rejects.toThrow();
      expect((await readdir(root)).filter((n) => n.startsWith(".mu-update-"))).toEqual([]);
      // A failed extraction must not disturb the working install.
      expect(await readFile(execPath, "utf8")).toBe("new binary");
    });
  });

  test("refuses an archive whose payload directory is missing the binary", async () => {
    await withInstall(async (_root, execPath) => {
      await writeFile(execPath, "old binary");
      await expect(
        installNativeArchive(
          execPath,
          await releaseArchive("darwin-arm64", "wrong target"),
          "linux-x64",
        ),
      ).rejects.toThrow("did not contain bin/mu");
      expect(await readFile(execPath, "utf8")).toBe("old binary");
    });
  });
});
