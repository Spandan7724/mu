import { delimiter, dirname } from "node:path";
import { resolveRipgrepExecutable } from "./tools/search.ts";

export interface ShellCommandOptions {
  platform?: NodeJS.Platform;
  interactive?: boolean;
}

export interface ProcessTreeTarget {
  pid: number;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): void;
}

// Commands are model-authored for the platform named in the session
// environment. Use the native shell so the compiled Windows binary does not
// quietly depend on Git Bash or WSL being installed.
export function shellCommand(command: string, options: ShellCommandOptions = {}): string[] {
  if ((options.platform ?? process.platform) === "win32") {
    return [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      ...(options.interactive ? [] : ["-NonInteractive"]),
      "-Command",
      command,
    ];
  }
  return ["bash", "-c", command];
}

export function windowsTaskkillCommand(pid: number): string[] {
  return ["taskkill.exe", "/PID", String(pid), "/T", "/F"];
}

let bundledToolDir: string | null | undefined;

// Only the directory mu ships, never one already on PATH: `which` is stubbed
// out so a system rg cannot make this reorder the user's own PATH.
function defaultToolDir(): string | undefined {
  if (bundledToolDir === undefined) {
    const ripgrep = resolveRipgrepExecutable(undefined, undefined, () => null);
    bundledToolDir = ripgrep ? dirname(ripgrep) : null;
  }
  return bundledToolDir ?? undefined;
}

// The prompt and the bash tool description both tell the model to reach for
// rg, but mu's copy lives beside the binary rather than on PATH, so without
// this every child shell would report "rg: command not found".
export function shellEnv(
  overrides: Record<string, string> = {},
  toolDir: () => string | undefined = defaultToolDir,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  const dir = toolDir();
  if (!dir) return env;
  // Windows spells it Path; spreading process.env loses its case-insensitivity.
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const current = env[key];
  env[key] = current ? `${dir}${delimiter}${current}` : dir;
  return env;
}

function fallbackKill(process: ProcessTreeTarget, signal: NodeJS.Signals): void {
  try {
    process.kill(signal);
  } catch {
    // The process may already have exited between the status check and signal.
  }
}

// Bun's detached POSIX processes are group leaders. Windows has no equivalent
// signal for descendants, so taskkill /T is the native process-tree boundary.
export async function terminateProcessTree(
  process: ProcessTreeTarget,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = globalThis.process.platform,
): Promise<void> {
  if (platform !== "win32") {
    try {
      globalThis.process.kill(-process.pid, signal);
    } catch {
      fallbackKill(process, signal);
    }
    return;
  }

  try {
    const killer = Bun.spawn(windowsTaskkillCommand(process.pid), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    if ((await killer.exited) !== 0 && process.exitCode === null) fallbackKill(process, signal);
  } catch {
    fallbackKill(process, signal);
  }
}
