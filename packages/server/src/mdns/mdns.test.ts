import { afterEach, describe, expect, test } from "bun:test";
import {
  CLASS_IN,
  decodeMessage,
  encodeMessage,
  type Message,
  TYPE_A,
  TYPE_PTR,
  TYPE_SRV,
  TYPE_TXT,
} from "./dns.ts";
import {
  type Advertiser,
  advertise,
  advertisementRecords,
  type Browser,
  browse,
  type DiscoveredInstance,
  instanceFrom,
  queryMessage,
  responseMessage,
  SERVICE_TYPE,
} from "./service.ts";

const stoppable: (Advertiser | Browser)[] = [];
afterEach(() => {
  for (const item of stoppable.splice(0)) item.stop();
});

describe("dns wire format", () => {
  test("a query round-trips", () => {
    const decoded = decodeMessage(queryMessage());
    expect(decoded.questions).toEqual([{ name: SERVICE_TYPE, type: TYPE_PTR, class: CLASS_IN }]);
    expect(decoded.answers).toEqual([]);
  });

  test("every record type this needs round-trips", () => {
    const message: Message = {
      id: 0,
      flags: 0x8400,
      questions: [],
      answers: [
        {
          name: SERVICE_TYPE,
          type: TYPE_PTR,
          class: CLASS_IN,
          ttl: 120,
          ptr: `i1.${SERVICE_TYPE}`,
        },
      ],
      additionals: [
        {
          name: `i1.${SERVICE_TYPE}`,
          type: TYPE_SRV,
          class: CLASS_IN,
          ttl: 120,
          priority: 0,
          weight: 0,
          port: 51820,
          target: "i1.local",
        },
        {
          name: `i1.${SERVICE_TYPE}`,
          type: TYPE_TXT,
          class: CLASS_IN,
          ttl: 120,
          txt: { id: "i1", v: "1" },
        },
        {
          name: "i1.local",
          type: TYPE_A,
          class: CLASS_IN,
          ttl: 120,
          address: "192.168.1.20",
        },
      ],
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  test("a compression pointer written by someone else is followed", () => {
    const name = [
      3, 0x5f, 0x6d, 0x75, 4, 0x5f, 0x74, 0x63, 0x70, 5, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0,
    ];
    // One question and one answer, with the answer's name and its PTR target
    // both written as pointers back to the question's name at offset 12.
    const header = [0, 0, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0];
    const question = [...name, 0, TYPE_PTR, 0, CLASS_IN];
    const rdata = [2, 0x69, 0x31, 0xc0, 12];
    const answer = [0xc0, 12, 0, TYPE_PTR, 0, CLASS_IN, 0, 0, 0, 120, 0, rdata.length, ...rdata];

    const decoded = decodeMessage(Uint8Array.from([...header, ...question, ...answer]));

    expect(decoded.questions[0]?.name).toBe("_mu._tcp.local");
    const record = decoded.answers[0];
    expect(record?.name).toBe("_mu._tcp.local");
    expect(record?.type === TYPE_PTR && record.ptr).toBe("i1._mu._tcp.local");
  });

  test("a malformed message is refused rather than crashing the listener", () => {
    expect(() => decodeMessage(Uint8Array.from([0, 0, 0, 0, 0, 1]))).toThrow();
    expect(() => decodeMessage(Uint8Array.from([]))).toThrow();
  });
});

describe("the advertisement", () => {
  const advertisement = { instanceId: "i-opaque", port: 51820, protocol: 1, address: "10.0.0.5" };

  test("carries an opaque id and a version, and nothing else", () => {
    const { answers, additionals } = advertisementRecords(advertisement);
    const txt = additionals.find((record) => record.type === TYPE_TXT);

    expect(txt?.type === TYPE_TXT && txt.txt).toEqual({ id: "i-opaque", v: "1" });
    // Asserted against the records themselves: no project name, no path, no
    // machine name anywhere in the advertisement.
    const serialized = JSON.stringify([...answers, ...additionals]);
    for (const leak of ["project", "workspace", "/home", "/Users", "branch", "session"]) {
      expect(serialized).not.toContain(leak);
    }
    expect(Object.keys(txt?.type === TYPE_TXT ? txt.txt : {})).toEqual(["id", "v"]);
  });

  test("names the service type the browser asks for", () => {
    const { answers } = advertisementRecords(advertisement);
    expect(answers[0]?.name).toBe("_mu._tcp.local");
    expect(answers[0]?.type === TYPE_PTR && answers[0].ptr).toBe("i-opaque._mu._tcp.local");
  });

  test("a browser reads back exactly what was advertised", () => {
    const instance = instanceFrom(decodeMessage(responseMessage(advertisement)), "1.2.3.4");
    expect(instance).toEqual({
      instanceId: "i-opaque",
      protocol: 1,
      address: "10.0.0.5",
      port: 51820,
    });
  });

  test("without an A record the sender's address is used", () => {
    const message = decodeMessage(responseMessage({ instanceId: "i2", port: 40000, protocol: 1 }));
    expect(instanceFrom(message, "192.168.0.9")?.address).toBe("192.168.0.9");
  });

  test("someone else's service on the same network is ignored", () => {
    const other: Message = {
      id: 0,
      flags: 0x8400,
      questions: [],
      answers: [
        {
          name: "_http._tcp.local",
          type: TYPE_PTR,
          class: CLASS_IN,
          ttl: 120,
          ptr: "printer._http._tcp.local",
        },
      ],
      additionals: [],
    };
    expect(instanceFrom(other, "1.2.3.4")).toBeUndefined();
  });
});

describe("over a real socket", () => {
  // Bound to a private multicast group and port so the test never touches the
  // machine's actual mDNS traffic.
  const options = { port: 53531, address: "239.255.41.98" };

  test("a browser discovers an advertising instance and learns only its id", async () => {
    const found: DiscoveredInstance[] = [];
    const advertiser = await advertise(
      { instanceId: "i-live", port: 51820, protocol: 1, address: "127.0.0.1" },
      options,
    );
    stoppable.push(advertiser);

    const browser = await browse((instance) => found.push(instance), options);
    stoppable.push(browser);

    for (let attempt = 0; attempt < 60 && found.length === 0; attempt++) {
      browser.query();
      await Bun.sleep(25);
    }

    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toEqual({
      instanceId: "i-live",
      protocol: 1,
      address: "127.0.0.1",
      port: 51820,
    });
  }, 10_000);

  test("nothing is advertised until something advertises", async () => {
    const found: DiscoveredInstance[] = [];
    const browser = await browse((instance) => found.push(instance), {
      port: 53532,
      address: "239.255.41.99",
    });
    stoppable.push(browser);

    for (let attempt = 0; attempt < 8; attempt++) {
      browser.query();
      await Bun.sleep(25);
    }
    expect(found).toEqual([]);
  }, 10_000);
});
