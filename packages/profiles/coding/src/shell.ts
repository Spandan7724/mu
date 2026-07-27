export interface ShellCommandOptions {
  platform?: NodeJS.Platform;
  interactive?: boolean;
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
