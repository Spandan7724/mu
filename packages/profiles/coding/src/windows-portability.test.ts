import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyTool, ProcessManager } from "@mu/core";
import { gitConfigNullDevice, ShadowCheckpointProvider } from "./checkpoint.ts";
import { codingEnvironment } from "./context.ts";
import { shellCommand, windowsTaskkillCommand } from "./shell.ts";
import { bashTool } from "./tools/bash.ts";
import { shellSpawner } from "./tools/tasks.ts";

const signal = new AbortController().signal;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(stderr);
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

describe("Windows portability", () => {
  test("selects native shells without relying on WSL or Git Bash", () => {
    expect(shellCommand("Write-Output ok", { platform: "win32" })).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Write-Output ok",
    ]);
    expect(shellCommand("printf ok", { platform: "linux" })).toEqual(["bash", "-c", "printf ok"]);
  });

  test("uses Windows' native recursive process-tree termination command", () => {
    expect(windowsTaskkillCommand(4242)).toEqual(["taskkill.exe", "/PID", "4242", "/T", "/F"]);
  });

  test("uses the platform null device for isolated Git configuration", () => {
    expect(gitConfigNullDevice("win32")).toBe("NUL");
    expect(gitConfigNullDevice("linux")).toBe("/dev/null");
  });

  test("shadow checkpoints work with platform-native Git configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-native-checkpoint-root-"));
    const shadowDir = await mkdtemp(join(tmpdir(), "mu-native-checkpoint-store-"));
    const provider = new ShadowCheckpointProvider({ root, shadowDir });
    await writeFile(join(root, "state.txt"), "before\n");
    const ref = await provider.snapshot("before");
    await writeFile(join(root, "state.txt"), "after\n");

    await provider.restore(ref as string);

    expect(await readFile(join(root, "state.txt"), "utf8")).toBe("before\n");
  });

  test("repository context uses Git directly without POSIX pipelines", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-native-context-"));
    await git(root, "init", "--quiet");
    await git(root, "config", "user.email", "mu@example.com");
    await git(root, "config", "user.name", "mu test");
    await writeFile(join(root, "tracked.txt"), "clean\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "--quiet", "-m", "initial");
    await writeFile(join(root, "tracked.txt"), "dirty\n");

    const environment = await codingEnvironment(root);

    expect(environment.branch).toBeTruthy();
    expect(environment.uncommittedFiles).toBe("1");
  });

  test("the foreground tool executes through the host-native shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-native-shell-"));
    const command =
      process.platform === "win32"
        ? 'Write-Output "native-shell-ok"'
        : 'printf "native-shell-ok\\n"';
    const result = await (bashTool({ root }) as AnyTool).execute("call-1", { command }, signal);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("native-shell-ok");
  });

  test("background commands execute through the host-native transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-native-pty-"));
    const manager = new ProcessManager(shellSpawner(root));
    const command =
      process.platform === "win32" ? 'Write-Output "native-pty-ok"' : 'printf "native-pty-ok\\n"';
    const task = manager.start(command);

    await manager.wait(task.id);

    expect(manager.output(task.id, "start")?.text).toContain("native-pty-ok");
    expect(manager.get(task.id)?.exitCode).toBe(0);
  });

  test("task kill terminates Windows descendants", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "mu-windows-tree-"));
    const marker = join(root, "child-alive.txt");
    const escapedMarker = marker.replaceAll("'", "''");
    const childScript = [
      "while ($true) {",
      `  [IO.File]::WriteAllText('${escapedMarker}', [DateTime]::UtcNow.Ticks.ToString())`,
      "  Start-Sleep -Milliseconds 50",
      "}",
    ].join("\n");
    const encoded = Buffer.from(childScript, "utf16le").toString("base64");
    const command = [
      "$child = Start-Process powershell.exe",
      `-ArgumentList '-NoLogo','-NoProfile','-EncodedCommand','${encoded}'`,
      "-PassThru",
      "; Wait-Process -Id $child.Id",
    ].join(" ");
    const manager = new ProcessManager(shellSpawner(root));
    const task = manager.start(command);

    for (let attempt = 0; attempt < 40; attempt++) {
      if (await readFile(marker, "utf8").catch(() => "")) break;
      await Bun.sleep(50);
    }
    expect(await readFile(marker, "utf8")).not.toBe("");

    manager.kill(task.id);
    await manager.wait(task.id);
    const afterKill = await readFile(marker, "utf8");
    await Bun.sleep(250);

    expect(await readFile(marker, "utf8")).toBe(afterKill);
  });
});
