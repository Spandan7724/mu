import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

// One live mu session per managed profile. A second session attaching to the same browser
// would track the first one's tabs as its own (and close the browser under it), so the
// holder is recorded in the profile dir and kept fresh while held. A record counts only
// while it is fresh and its process lives, so a crashed or killed session never blocks.
const LEASE_FILE = "mu-session.json";
const HEARTBEAT_MS = 15_000;
const STALE_MS = 60_000;

export interface LeaseHolder {
  pid: number;
  host: string;
  token: string;
  since: string;
}

export function profileInUseMessage(holder: LeaseHolder, profileName: string): string {
  const where = holder.host === hostname() ? "" : ` on ${holder.host}`;
  return `Browser profile "${profileName}" is in use by another mu session (pid ${holder.pid}${where}, since ${holder.since}). Two sessions on one profile would drive the same tabs. Use another profile (--browser-profile <name>), run the work as parallel sub-tasks in that session, or stop it first.`;
}

export class ProfileInUseError extends Error {
  constructor(
    readonly holder: LeaseHolder,
    profileName: string,
  ) {
    super(profileInUseMessage(holder, profileName));
  }
}

const leasePath = (userDataDir: string) => join(userDataDir, LEASE_FILE);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLease(path: string): { raw: string; holder: LeaseHolder | undefined } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as LeaseHolder;
    return typeof parsed.pid === "number" && typeof parsed.token === "string"
      ? { raw, holder: parsed }
      : { raw, holder: undefined };
  } catch {
    return { raw, holder: undefined };
  }
}

function live(path: string, holder: LeaseHolder): boolean {
  let fresh: boolean;
  try {
    fresh = Date.now() - statSync(path).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
  return fresh && (holder.host !== hostname() || processAlive(holder.pid));
}

// The live session holding the profile, if any.
export function liveHolder(userDataDir: string): LeaseHolder | undefined {
  const path = leasePath(userDataDir);
  const found = readLease(path);
  return found?.holder && live(path, found.holder) ? found.holder : undefined;
}

const held = new Set<ProfileLease>();
let exitHook = false;

export class ProfileLease {
  private readonly token = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly userDataDir: string,
    readonly profileName: string,
  ) {}

  // Throws ProfileInUseError while another live session holds the profile.
  acquire(): void {
    if (this.timer) return;
    const path = leasePath(this.userDataDir);
    mkdirSync(this.userDataDir, { recursive: true });
    const record: LeaseHolder = {
      pid: process.pid,
      host: hostname(),
      token: this.token,
      since: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(path, "wx");
        writeSync(fd, JSON.stringify(record));
        closeSync(fd);
        this.hold(path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const found = readLease(path);
      if (found?.holder && live(path, found.holder))
        throw new ProfileInUseError(found.holder, this.profileName);
      // Remove a stale record only if it is still the one judged stale.
      if (readLease(path)?.raw === found?.raw) rmSync(path, { force: true });
    }
    const holder = liveHolder(this.userDataDir);
    if (holder) throw new ProfileInUseError(holder, this.profileName);
    throw new Error(`could not take the lease on browser profile "${this.profileName}"`);
  }

  release(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    held.delete(this);
    const path = leasePath(this.userDataDir);
    if (readLease(path)?.holder?.token === this.token) rmSync(path, { force: true });
  }

  private hold(path: string): void {
    this.timer = setInterval(() => {
      const now = new Date();
      try {
        utimesSync(path, now, now);
      } catch {}
    }, HEARTBEAT_MS);
    this.timer.unref?.();
    held.add(this);
    if (!exitHook) {
      exitHook = true;
      process.once("exit", () => {
        for (const lease of [...held]) lease.release();
      });
    }
  }
}
