import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { equal, fromBase64Url, generateKeyPair, random, toBase64Url } from "./noise/primitives.ts";

export interface EnrolledDevice {
  id: string;
  name: string;
  // The device's Noise static public key, base64url. This alone authenticates
  // every connection after pairing — no token, no window, no enrolment race.
  publicKey: string;
  enrolledAt: string;
  lastSeenAt?: string;
}

interface DeviceFile {
  version: 1;
  // The machine's Noise static key pair. Scoped to the machine, not the
  // terminal, so every mu instance on this box accepts the same paired phone
  // (RD7).
  hostPrivateKey: string;
  hostPublicKey: string;
  hostId: string;
  devices: EnrolledDevice[];
}

export const PAIRING_TOKEN_TTL_MS = 60_000;

export interface DeviceStoreOptions {
  // Defaults to ~/.mu/devices.json.
  path?: string;
  now?: () => number;
}

function emptyFile(): DeviceFile {
  const keys = generateKeyPair();
  return {
    version: 1,
    hostPrivateKey: toBase64Url(keys.privateKey),
    hostPublicKey: toBase64Url(keys.publicKey),
    hostId: `h_${randomUUID().slice(0, 12)}`,
    devices: [],
  };
}

// Enrolled devices and the machine's own static key. Written with the same
// discipline as auth.json: 0600, atomic rename, never a partial file.
export class DeviceStore {
  private readonly path: string;
  private readonly now: () => number;
  private file: DeviceFile | undefined;
  private readonly tokens = new Map<string, { issuedAt: number; usedAt?: number }>();
  private pending: Promise<void> = Promise.resolve();

  constructor(options: DeviceStoreOptions = {}) {
    this.path = options.path ?? join(homedir(), ".mu", "devices.json");
    this.now = options.now ?? (() => Date.now());
  }

  async load(): Promise<void> {
    if (this.file) return;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as DeviceFile;
      if (parsed.version !== 1 || !parsed.hostPrivateKey) throw new Error("unsupported");
      this.file = { ...parsed, devices: parsed.devices ?? [] };
      await this.tighten();
    } catch {
      // A missing or unreadable file means this machine has not paired yet.
      // Refusing to start would leave no way to recover from a corrupt one.
      this.file = emptyFile();
      await this.save();
    }
  }

  get hostId(): string {
    return this.require().hostId;
  }

  get hostPublicKey(): Uint8Array {
    return fromBase64Url(this.require().hostPublicKey);
  }

  get hostKeys(): { publicKey: Uint8Array; privateKey: Uint8Array } {
    const file = this.require();
    return {
      publicKey: fromBase64Url(file.hostPublicKey),
      privateKey: fromBase64Url(file.hostPrivateKey),
    };
  }

  list(): EnrolledDevice[] {
    return [...this.require().devices];
  }

  find(publicKey: Uint8Array): EnrolledDevice | undefined {
    return this.require().devices.find((device) =>
      equal(fromBase64Url(device.publicKey), publicKey),
    );
  }

  // One-time, 60-second, consumed on first use. A photograph taken after you
  // have paired is worthless (SECURITY.md §2).
  issuePairingToken(): string {
    const token = toBase64Url(random(24));
    this.tokens.set(token, { issuedAt: this.now() });
    return token;
  }

  redeemPairingToken(token: string): { ok: true } | { ok: false; reason: string } {
    const record = this.tokens.get(token);
    if (!record) return { ok: false, reason: "unknown pairing token" };
    if (record.usedAt !== undefined) return { ok: false, reason: "pairing token already used" };
    if (this.now() - record.issuedAt > PAIRING_TOKEN_TTL_MS) {
      this.tokens.delete(token);
      return { ok: false, reason: "pairing token expired" };
    }
    record.usedAt = this.now();
    return { ok: true };
  }

  // Synchronous by design: the handshake needs the device id in the same tick
  // it authenticates the key, and the durable write is not what authorises the
  // connection — the key is.
  enroll(publicKey: Uint8Array, name: string): EnrolledDevice {
    const existing = this.find(publicKey);
    if (existing) return existing;
    const device: EnrolledDevice = {
      id: `d_${randomUUID().slice(0, 12)}`,
      name,
      publicKey: toBase64Url(publicKey),
      enrolledAt: new Date(this.now()).toISOString(),
    };
    this.require().devices.push(device);
    this.schedule();
    return device;
  }

  touch(deviceId: string): void {
    const device = this.require().devices.find((candidate) => candidate.id === deviceId);
    if (!device) return;
    device.lastSeenAt = new Date(this.now()).toISOString();
    this.schedule();
  }

  // Awaits every write scheduled so far. Shutdown and tests use it; nothing on
  // the connection path does.
  async flush(): Promise<void> {
    await this.pending;
  }

  // `mu devices revoke` runs in its own process; the socket lives in the mu
  // instance serving the session. Watching the file is what makes revocation
  // immediate rather than merely future-facing.
  watch(onRevoked: (deviceIds: string[]) => void): () => void {
    let watcher: ReturnType<typeof watch> | undefined;
    let reloading = false;
    const reload = async () => {
      if (reloading) return;
      reloading = true;
      try {
        await this.pending;
        const before = new Set(this.require().devices.map((device) => device.id));
        const raw = await readFile(this.path, "utf8");
        const parsed = JSON.parse(raw) as DeviceFile;
        if (parsed.version !== 1 || !parsed.hostPrivateKey) return;
        this.file = { ...parsed, devices: parsed.devices ?? [] };
        const after = new Set(this.file.devices.map((device) => device.id));
        const gone = [...before].filter((id) => !after.has(id));
        if (gone.length > 0) onRevoked(gone);
      } catch {
        // A torn read during another process's atomic rename is transient; the
        // next event re-reads it. Never drop connections on a failed read.
      } finally {
        reloading = false;
      }
    };
    try {
      // The directory, not the file: every write here is an atomic rename, and
      // a path watch follows the inode it started on, so it goes deaf after the
      // first one.
      const directory = join(this.path, "..");
      const name = basename(this.path);
      watcher = watch(directory, (_event, changed) => {
        if (changed === null || changed === undefined || changed === name) void reload();
      });
    } catch {
      // No watch available (or the directory vanished): revocation still
      // applies to future connections, which is the pre-existing behaviour.
    }
    return () => watcher?.close();
  }

  async revoke(deviceId: string): Promise<EnrolledDevice | undefined> {
    const file = this.require();
    const index = file.devices.findIndex((device) => device.id === deviceId);
    if (index === -1) return undefined;
    const [removed] = file.devices.splice(index, 1);
    await this.save();
    return removed;
  }

  // Writes are serialized so two enrolments in the same tick cannot interleave
  // into a half-written file.
  private schedule(): void {
    this.pending = this.pending.then(() => this.save()).catch(() => {});
  }

  private require(): DeviceFile {
    if (!this.file) throw new Error("device store not loaded");
    return this.file;
  }

  private async tighten(): Promise<void> {
    if (process.platform === "win32") return;
    try {
      const info = await stat(this.path);
      if ((info.mode & 0o077) !== 0) await chmod(this.path, 0o600);
    } catch {
      // Nothing to tighten if it is not there.
    }
  }

  private async save(): Promise<void> {
    const directory = join(this.path, "..");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.require(), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.path);
      if (process.platform !== "win32") await chmod(this.path, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
