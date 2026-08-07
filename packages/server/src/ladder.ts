export interface Endpoint {
  kind: "mdns" | "last-known" | "tunnel" | "relay";
  address: string;
  port: number;
}

export interface LadderInput {
  // Instances seen on the current network, most recent first.
  discovered?: { address: string; port: number }[];
  // Where this machine answered last time.
  lastKnown?: { address: string; port: number };
  // A user-run `ssh -L`, Tailscale address or Cloudflare tunnel.
  tunnel?: { address: string; port: number };
  relay?: { address: string; port: number };
}

// mDNS on the current network → last-known address for that machine →
// configured tunnel host → relay if one exists. The user picks a session, never
// a transport (ARCHITECTURE.md §6).
export function connectionLadder(input: LadderInput): Endpoint[] {
  const rungs: Endpoint[] = [
    ...(input.discovered ?? []).map((found) => ({ kind: "mdns" as const, ...found })),
    ...(input.lastKnown ? [{ kind: "last-known" as const, ...input.lastKnown }] : []),
    ...(input.tunnel ? [{ kind: "tunnel" as const, ...input.tunnel }] : []),
    ...(input.relay ? [{ kind: "relay" as const, ...input.relay }] : []),
  ];
  // The same address reached two ways is one rung: trying it twice only makes
  // a failing connection take longer to give up on.
  const seen = new Set<string>();
  return rungs.filter((rung) => {
    const key = `${rung.address}:${rung.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
