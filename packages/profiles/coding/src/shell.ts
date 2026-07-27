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

function fallbackKill(process: ProcessTreeTarget, signal: NodeJS.Signals): void {
  try {
    process.kill(signal);
  } catch {
    // The process may already have exited between the status check and signal.
  }
}

// Bun's detached POSIX processes are group leaders. Windows has no equivalent
// signal for descendants, so taskkill /T is the native process-tree boundary.
export function terminateProcessTree(
  process: ProcessTreeTarget,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = globalThis.process.platform,
): void {
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
    void killer.exited
      .then((exitCode) => {
        if (exitCode !== 0 && process.exitCode === null) fallbackKill(process, signal);
      })
      .catch(() => fallbackKill(process, signal));
  } catch {
    fallbackKill(process, signal);
  }
}
