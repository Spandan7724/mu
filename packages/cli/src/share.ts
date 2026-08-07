import { networkInterfaces } from "node:os";
import {
  type Advertiser,
  advertise,
  DeviceStore,
  encodePairingUrl,
  fingerprint,
  PreAuthLimiter,
  primaryAddress,
  qrLines,
  type RunningServer,
  SealedChannel,
  type SessionHost,
  serve,
} from "@mu/server";

export interface ShareIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export interface ShareOptions {
  host: SessionHost;
  hostName: string;
  version: string;
  protocol: number;
  // Absent binds the primary non-internal IPv4 interface. Never 0.0.0.0
  // implicitly (SECURITY.md §6).
  bindAddress?: string;
  devicesPath?: string;
  advertise?: boolean;
}

export interface Sharing {
  server: RunningServer;
  devices: DeviceStore;
  url: string;
  stop: () => Promise<void>;
}

// Chosen over the loopback address deliberately: sharing to 127.0.0.1 would
// advertise a service nothing on the network can reach.
export function shareAddress(explicit?: string): string | undefined {
  if (explicit) return explicit;
  return primaryAddress();
}

export function exposureWarning(address: string): string[] {
  return [
    "  mu share exposes this session to your local network.",
    `  Anyone who can reach ${address} can attempt the handshake; only a device`,
    "  you have paired can complete it. A machine with a public IP or a",
    "  forwarded port turns this into an open shell — check before you share.",
  ];
}

export function pairingBlock(url: string, hostKey: Uint8Array, address: string): string[] {
  return [
    "",
    ...qrLines(url),
    "",
    `  Scan with mu remote, or open: ${url}`,
    `  Host key: ${fingerprint(hostKey)}`,
    `  Listening on ${address}`,
    "  This code is single-use and expires in 60 seconds.",
    "",
  ];
}

export async function startSharing(options: ShareOptions, io: ShareIo): Promise<Sharing> {
  const address = shareAddress(options.bindAddress);
  if (!address) {
    throw new Error("no non-loopback network interface to share on");
  }

  const devices = new DeviceStore(options.devicesPath ? { path: options.devicesPath } : {});
  await devices.load();

  const limiter = new PreAuthLimiter();
  const server = serve({
    host: options.host,
    hostName: options.hostName,
    version: options.version,
    hostname: address,
    channel: (peer) =>
      new SealedChannel({
        devices,
        onAuthenticated: () => limiter.forget(peer),
      }),
    admit: (peer) => limiter.admit(peer),
  });

  // A revocation happens in another process; the socket lives here.
  const unwatch = devices.watch((revoked) => {
    server.disconnect(
      "revoked",
      (origin) => origin.kind === "remote" && revoked.includes(origin.deviceId),
    );
  });

  let advertiser: Advertiser | undefined;
  if (options.advertise !== false) {
    advertiser = await advertise({
      instanceId: options.host.instanceId,
      port: server.port,
      protocol: options.protocol,
      address,
    });
  }

  const url = encodePairingUrl({
    hostKey: devices.hostPublicKey,
    token: devices.issuePairingToken(),
    address: `${address}:${server.port}`,
  });

  for (const line of exposureWarning(address)) io.stderr(`${line}\n`);
  for (const line of pairingBlock(url, devices.hostPublicKey, `${address}:${server.port}`)) {
    io.stdout(`${line}\n`);
  }

  return {
    server,
    devices,
    url,
    stop: async () => {
      unwatch();
      advertiser?.stop();
      await server.stop();
      await devices.flush();
    },
  };
}

export function interfaceChoices(): string[] {
  const out: string[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(`${name} ${entry.address}`);
    }
  }
  return out;
}
