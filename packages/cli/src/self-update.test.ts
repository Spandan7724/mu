import { describe, expect, test } from "bun:test";
import {
  compareSemver,
  npmPrefixFromInstallPath,
  packageManagerFromInstallPaths,
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
