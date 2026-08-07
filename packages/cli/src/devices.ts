import { DeviceStore, type EnrolledDevice, fingerprint, fromBase64Url } from "@mu/server";
import type { ParsedArgs } from "./args.ts";
import { EXIT } from "./headless.ts";

export interface DevicesIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

// Relative where it is useful and absolute where it is not: "3 days ago" tells
// you whether a device is still in use; a timestamp tells you when it was
// enrolled.
export function formatLastSeen(lastSeenAt: string | undefined, now: number): string {
  if (!lastSeenAt) return "never connected";
  const elapsed = now - Date.parse(lastSeenAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "last seen just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "last seen just now";
  if (minutes < 60) return `last seen ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${Math.floor(hours / 24)}d ago`;
}

export function formatDevices(devices: readonly EnrolledDevice[], now: number): string[] {
  if (devices.length === 0) {
    return ["No paired devices.", "", "Run mu share in a project to print a pairing code."];
  }
  return devices.flatMap((device) => [
    `${device.name}  ${device.id}`,
    `  ${fingerprint(fromBase64Url(device.publicKey))}`,
    `  enrolled ${device.enrolledAt.slice(0, 10)} · ${formatLastSeen(device.lastSeenAt, now)}`,
    "",
  ]);
}

export async function runDevices(
  args: ParsedArgs,
  io: DevicesIo,
  options: { path?: string; now?: () => number } = {},
): Promise<number> {
  const store = new DeviceStore({
    ...(options.path ? { path: options.path } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  await store.load();

  if (args.devicesAction === "revoke") {
    const id = args.deviceId as string;
    const removed = await store.revoke(id);
    if (!removed) {
      io.stderr(`mu: no paired device with id ${id}\n`);
      return EXIT.usage;
    }
    io.stdout(`Revoked ${removed.name} (${removed.id}).\n`);
    // A running mu holds the socket, not this process. It watches the store and
    // drops the connection when the entry disappears.
    io.stdout("Any connection it holds is dropped by the mu instance serving it.\n");
    return 0;
  }

  for (const line of formatDevices(store.list(), options.now?.() ?? Date.now())) {
    io.stdout(`${line}\n`);
  }
  return 0;
}
