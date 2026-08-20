import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AnyTool } from "@mu/core";
import { resolveNpmRipgrepExecutable, resolveRipgrepExecutable } from "./ripgrep.ts";
import { shellEnv } from "./shell.ts";
import { bashTool } from "./tools/bash.ts";

const signal = new AbortController().signal;

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-shell-"));
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

describe("shellEnv", () => {
  test("prepends mu's tool directory so child shells can run the bundled rg", () => {
    const env = shellEnv({}, () => "/opt/mu/mu-path");
    expect(env.PATH?.startsWith(`/opt/mu/mu-path${delimiter}`)).toBe(true);
    expect(env.PATH).toContain(process.env.PATH ?? "");
  });

  test("leaves PATH untouched when mu ships no bundled tools", () => {
    expect(shellEnv({}, () => undefined).PATH).toBe(process.env.PATH);
  });

  test("extends the existing PATH rather than replacing it", () => {
    const env = shellEnv({}, () => "/tools");
    expect(env.PATH).toBe(`/tools${delimiter}${process.env.PATH}`);
  });

  test("carries overrides through", () => {
    expect(shellEnv({ TERM: "xterm-256color" }, () => undefined).TERM).toBe("xterm-256color");
  });

  // Windows names the variable Path; spreading process.env drops the
  // case-insensitive lookup, so a naive PATH write would leave two keys and
  // let the stale one win.
  test("extends a Windows-style Path key instead of adding a second entry", () => {
    const original = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase() === "PATH") delete process.env[key];
    }
    process.env.Path = "C:\\Windows\\System32";
    try {
      const env = shellEnv({}, () => "C:\\Users\\me\\.mu\\mu-path");
      const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
      expect(pathKeys).toEqual(["Path"]);
      expect(env.Path).toBe(`C:\\Users\\me\\.mu\\mu-path${delimiter}C:\\Windows\\System32`);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (key.toUpperCase() === "PATH") delete process.env[key];
      }
      Object.assign(process.env, original);
    }
  });
});

describe("ripgrep detection", () => {
  test("prefers a bundled sidecar and otherwise searches PATH", async () => {
    const root = await scratch();
    const executable = join(root, "bin", "mu");
    const bundled = join(root, "mu-path", "rg");
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(join(root, "mu-path"), { recursive: true });
    await writeFile(bundled, "");
    await chmod(bundled, 0o755);

    expect(
      resolveRipgrepExecutable(
        executable,
        "linux",
        () => "/usr/bin/rg",
        () => undefined,
      ),
    ).toBe(bundled);
    const unbundled = join(root, "other", "bin", "mu");
    expect(
      resolveRipgrepExecutable(
        unbundled,
        "linux",
        () => "/usr/bin/rg",
        () => undefined,
      ),
    ).toBe("/usr/bin/rg");
    expect(
      resolveRipgrepExecutable(
        unbundled,
        "linux",
        () => null,
        () => undefined,
      ),
    ).toBeUndefined();
  });

  test("finds the matching optional npm platform package", async () => {
    const root = await scratch();
    const packageRoot = join(root, "node_modules", "@mu-agent", "ripgrep-linux-x64");
    const executable = join(packageRoot, "vendor", "rg");
    await mkdir(join(packageRoot, "vendor"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), "{}");
    await writeFile(executable, "");
    await chmod(executable, 0o755);

    expect(
      resolveNpmRipgrepExecutable("linux", "x64", root, () => join(packageRoot, "package.json")),
    ).toBe(executable);
    expect(resolveNpmRipgrepExecutable("linux", "arm64", root, () => "unused")).toBeUndefined();
  });
});

describe.if(process.platform !== "win32")("bash tool environment", () => {
  test("runs commands with the PATH shellEnv builds", async () => {
    const result = await (bashTool({ root: process.cwd() }) as AnyTool).execute(
      "call-1",
      { command: 'printf %s "$PATH"' },
      signal,
    );
    expect(textOf(result).trim()).toBe(shellEnv().PATH ?? "");
  });
});
