export type PowerAssertionSpawn = (command: string[]) => { kill: () => void };

export interface PowerAssertionOptions {
  platform?: NodeJS.Platform;
  spawn?: PowerAssertionSpawn;
  reason?: string;
}

// The command that keeps this platform awake, or undefined where we have no
// answer. A machine that suspends mid-run costs you the run under the
// in-process model (RD2), which is why this is held rather than hoped for.
export function powerAssertionCommand(
  platform: NodeJS.Platform,
  reason: string,
): string[] | undefined {
  switch (platform) {
    case "darwin":
      return ["caffeinate", "-i"];
    case "linux":
      return [
        "systemd-inhibit",
        "--what=idle:sleep",
        `--why=${reason}`,
        "--mode=block",
        "sleep",
        "infinity",
      ];
    case "win32":
      return [
        "powershell",
        "-NoProfile",
        "-Command",
        "$s=Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint e);' -Name P -PassThru; $s::SetThreadExecutionState(0x80000001); while($true){Start-Sleep 60}",
      ];
    default:
      return undefined;
  }
}

// Held for the duration of a run and released on completion or abort. Reference
// counted: overlapping holds must not release each other's assertion.
export class PowerAssertion {
  private handle: { kill: () => void } | undefined;
  private holds = 0;
  private readonly platform: NodeJS.Platform;
  private readonly reason: string;
  private readonly spawn: PowerAssertionSpawn;

  constructor(options: PowerAssertionOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.reason = options.reason ?? "mu is running an agent turn";
    this.spawn =
      options.spawn ??
      ((command) => Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
  }

  get held(): boolean {
    return this.handle !== undefined;
  }

  acquire(): void {
    this.holds += 1;
    if (this.handle || this.holds > 1) return;
    const command = powerAssertionCommand(this.platform, this.reason);
    if (!command) return;
    try {
      this.handle = this.spawn(command);
    } catch {
      // A missing caffeinate/systemd-inhibit must never fail a run.
    }
  }

  release(): void {
    this.holds = Math.max(0, this.holds - 1);
    if (this.holds > 0) return;
    try {
      this.handle?.kill();
    } catch {
      // Already gone.
    }
    this.handle = undefined;
  }
}
