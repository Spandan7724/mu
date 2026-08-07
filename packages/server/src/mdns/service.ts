import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import {
  CLASS_IN,
  decodeMessage,
  encodeMessage,
  FLUSH,
  type Message,
  type Record,
  TYPE_A,
  TYPE_ANY,
  TYPE_PTR,
  TYPE_SRV,
  TYPE_TXT,
} from "./dns.ts";

export const MDNS_ADDRESS = "224.0.0.251";
export const MDNS_PORT = 5353;
export const SERVICE_TYPE = "_mu._tcp.local";
const TTL = 120;

export interface Advertisement {
  // Opaque, and the only identifier that goes on the wire. The machine and
  // project names are resolved after the handshake (RD9).
  instanceId: string;
  port: number;
  protocol: number;
  host?: string;
  address?: string;
}

export interface DiscoveredInstance {
  instanceId: string;
  protocol: number;
  address: string;
  port: number;
}

// Everything an advertisement is allowed to say. Project names would broadcast
// what you are working on to everyone on the network for no benefit, since only
// a paired client can use the name anyway.
export function advertisementRecords(advertisement: Advertisement): {
  answers: Record[];
  additionals: Record[];
} {
  const instance = `${advertisement.instanceId}.${SERVICE_TYPE}`;
  const target = advertisement.host ?? `${advertisement.instanceId}.local`;
  return {
    answers: [
      {
        name: SERVICE_TYPE,
        type: TYPE_PTR,
        class: CLASS_IN,
        ttl: TTL,
        ptr: instance,
      },
    ],
    additionals: [
      {
        name: instance,
        type: TYPE_SRV,
        class: CLASS_IN | FLUSH,
        ttl: TTL,
        priority: 0,
        weight: 0,
        port: advertisement.port,
        target,
      },
      {
        name: instance,
        type: TYPE_TXT,
        class: CLASS_IN | FLUSH,
        ttl: TTL,
        txt: { id: advertisement.instanceId, v: String(advertisement.protocol) },
      },
      ...(advertisement.address
        ? [
            {
              name: target,
              type: TYPE_A as typeof TYPE_A,
              class: CLASS_IN | FLUSH,
              ttl: TTL,
              address: advertisement.address,
            },
          ]
        : []),
    ],
  };
}

// The reverse: what a browser can learn from a response. Returns nothing rather
// than a partial when the response is not one of ours.
export function instanceFrom(
  message: Message,
  fallbackAddress: string,
): DiscoveredInstance | undefined {
  const pointer = message.answers.find(
    (record) => record.type === TYPE_PTR && record.name === SERVICE_TYPE,
  );
  if (pointer?.type !== TYPE_PTR) return undefined;
  const records = [...message.answers, ...message.additionals];
  const srv = records.find((record) => record.type === TYPE_SRV && record.name === pointer.ptr);
  const txt = records.find((record) => record.type === TYPE_TXT && record.name === pointer.ptr);
  if (srv?.type !== TYPE_SRV || txt?.type !== TYPE_TXT) return undefined;
  const instanceId = txt.txt.id;
  const protocol = Number(txt.txt.v);
  if (!instanceId || !Number.isInteger(protocol)) return undefined;
  const a = records.find((record) => record.type === TYPE_A && record.name === srv.target);
  return {
    instanceId,
    protocol,
    address: a?.type === TYPE_A ? a.address : fallbackAddress,
    port: srv.port,
  };
}

export function queryMessage(): Uint8Array {
  return encodeMessage({
    id: 0,
    flags: 0,
    questions: [{ name: SERVICE_TYPE, type: TYPE_PTR, class: CLASS_IN }],
    answers: [],
    additionals: [],
  });
}

export function responseMessage(advertisement: Advertisement): Uint8Array {
  const { answers, additionals } = advertisementRecords(advertisement);
  // 0x8400: response, authoritative.
  return encodeMessage({ id: 0, flags: 0x8400, questions: [], answers, additionals });
}

export function primaryAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

export interface MdnsOptions {
  // Injected in tests so a socket can be bound to a private port instead of the
  // real multicast group.
  port?: number;
  address?: string;
  bindAddress?: string;
}

function bind(
  options: MdnsOptions,
  onMessage: (bytes: Uint8Array, from: string) => void,
): Promise<Socket> {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const port = options.port ?? MDNS_PORT;
  const group = options.address ?? MDNS_ADDRESS;
  socket.on("message", (bytes, info) => onMessage(new Uint8Array(bytes), info.address));
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, options.bindAddress ?? "0.0.0.0", () => {
      try {
        socket.addMembership(group);
        socket.setMulticastLoopback(true);
      } catch {
        // A machine with no multicast-capable interface still gets a working
        // socket for the loopback case; discovery simply finds nothing.
      }
      resolve(socket);
    });
  });
}

export interface Advertiser {
  stop: () => void;
}

// Answers queries for _mu._tcp.local and announces once on start. Sharing is
// opt-in per instance, so nothing calls this unless `mu share` did.
export async function advertise(
  advertisement: Advertisement,
  options: MdnsOptions = {},
): Promise<Advertiser> {
  const port = options.port ?? MDNS_PORT;
  const group = options.address ?? MDNS_ADDRESS;
  const response = responseMessage(advertisement);

  const socket = await bind(options, (bytes) => {
    let message: Message;
    try {
      message = decodeMessage(bytes);
    } catch {
      return;
    }
    const asked = message.questions.some(
      (question) =>
        question.name === SERVICE_TYPE &&
        (question.type === TYPE_PTR || question.type === TYPE_ANY),
    );
    if (!asked) return;
    socket.send(response, port, group);
  });

  socket.send(response, port, group);
  return {
    stop: () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}

export interface Browser {
  stop: () => void;
  query: () => void;
}

export async function browse(
  onFound: (instance: DiscoveredInstance) => void,
  options: MdnsOptions = {},
): Promise<Browser> {
  const port = options.port ?? MDNS_PORT;
  const group = options.address ?? MDNS_ADDRESS;
  const query = queryMessage();

  const socket = await bind(options, (bytes, from) => {
    let message: Message;
    try {
      message = decodeMessage(bytes);
    } catch {
      return;
    }
    const instance = instanceFrom(message, from);
    if (instance) onFound(instance);
  });

  const send = () => socket.send(query, port, group);
  send();
  return {
    query: send,
    stop: () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}
