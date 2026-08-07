// The slice of DNS that mDNS service discovery needs: PTR, SRV, TXT and A, over
// the multicast wire format. Hand-written because mu adds no runtime
// dependencies, and deliberately narrow — this is not a resolver.

export const TYPE_A = 1;
export const TYPE_PTR = 12;
export const TYPE_TXT = 16;
export const TYPE_SRV = 33;
export const TYPE_ANY = 255;
export const CLASS_IN = 1;
// Top bit of the class field: on a query it means "unicast reply welcome", on a
// record it means "this is the only authority for this name".
export const FLUSH = 0x8000;

export interface Question {
  name: string;
  type: number;
  class: number;
}

export type Record =
  | { name: string; type: typeof TYPE_PTR; ttl: number; class: number; ptr: string }
  | { name: string; type: typeof TYPE_TXT; ttl: number; class: number; txt: Record$Txt }
  | {
      name: string;
      type: typeof TYPE_SRV;
      ttl: number;
      class: number;
      priority: number;
      weight: number;
      port: number;
      target: string;
    }
  | { name: string; type: typeof TYPE_A; ttl: number; class: number; address: string };

export type Record$Txt = globalThis.Record<string, string>;

export interface Message {
  id: number;
  flags: number;
  questions: Question[];
  answers: Record[];
  additionals: Record[];
}

class Writer {
  private bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  u16(value: number): void {
    this.bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  u32(value: number): void {
    this.bytes.push(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    );
  }

  raw(values: Uint8Array): void {
    for (const value of values) this.bytes.push(value);
  }

  // Names are written uncompressed. A service announcement is a few hundred
  // bytes either way, and pointers are the one part of this format that is
  // genuinely easy to get subtly wrong.
  name(value: string): void {
    for (const label of value.split(".")) {
      if (label.length === 0) continue;
      const encoded = new TextEncoder().encode(label);
      if (encoded.length > 63) throw new Error(`dns: label too long: ${label}`);
      this.u8(encoded.length);
      this.raw(encoded);
    }
    this.u8(0);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  get position(): number {
    return this.offset;
  }

  seek(offset: number): void {
    this.offset = offset;
  }

  u8(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) throw new Error("dns: truncated");
    this.offset += 1;
    return value;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    return ((this.u16() << 16) >>> 0) + this.u16();
  }

  slice(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) throw new Error("dns: truncated");
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  // Compression pointers are followed on read: other implementations use them
  // even though we do not write them.
  name(): string {
    const labels: string[] = [];
    let cursor = this.offset;
    let jumped = false;
    let guard = 0;
    for (;;) {
      if (guard++ > 128) throw new Error("dns: name loop");
      const length = this.bytes[cursor];
      if (length === undefined) throw new Error("dns: truncated");
      if (length === 0) {
        cursor += 1;
        break;
      }
      if ((length & 0xc0) === 0xc0) {
        const next = this.bytes[cursor + 1];
        if (next === undefined) throw new Error("dns: truncated");
        const pointer = ((length & 0x3f) << 8) | next;
        if (!jumped) {
          this.offset = cursor + 2;
          jumped = true;
        }
        cursor = pointer;
        continue;
      }
      const start = cursor + 1;
      if (start + length > this.bytes.length) throw new Error("dns: truncated");
      labels.push(new TextDecoder().decode(this.bytes.subarray(start, start + length)));
      cursor = start + length;
    }
    if (!jumped) this.offset = cursor;
    return labels.join(".");
  }
}

function writeRecord(writer: Writer, record: Record): void {
  writer.name(record.name);
  writer.u16(record.type);
  writer.u16(record.class);
  writer.u32(record.ttl);

  const body = new Writer();
  switch (record.type) {
    case TYPE_PTR:
      body.name(record.ptr);
      break;
    case TYPE_SRV:
      body.u16(record.priority);
      body.u16(record.weight);
      body.u16(record.port);
      body.name(record.target);
      break;
    case TYPE_TXT: {
      const entries = Object.entries(record.txt);
      if (entries.length === 0) body.u8(0);
      for (const [key, value] of entries) {
        const encoded = new TextEncoder().encode(`${key}=${value}`);
        if (encoded.length > 255) throw new Error("dns: txt entry too long");
        body.u8(encoded.length);
        body.raw(encoded);
      }
      break;
    }
    case TYPE_A: {
      for (const part of record.address.split(".")) body.u8(Number(part));
      break;
    }
  }
  const encoded = body.finish();
  writer.u16(encoded.length);
  writer.raw(encoded);
}

function readRecord(reader: Reader): Record {
  const name = reader.name();
  const type = reader.u16();
  const klass = reader.u16();
  const ttl = reader.u32();
  const length = reader.u16();
  // Read the body from the message reader, not from a copy of the body: names
  // inside rdata are compressed against the whole message, and a slice has no
  // way to follow a pointer out of itself.
  const start = reader.position;
  const end = start + length;
  const record = readBody(reader, { name, type, class: klass, ttl }, end);
  reader.seek(end);
  return record;
}

function readBody(
  reader: Reader,
  header: { name: string; type: number; class: number; ttl: number },
  end: number,
): Record {
  const { name, class: klass, ttl } = header;
  switch (header.type) {
    case TYPE_PTR:
      return { name, type: TYPE_PTR, class: klass, ttl, ptr: reader.name() };
    case TYPE_SRV: {
      const priority = reader.u16();
      const weight = reader.u16();
      const port = reader.u16();
      return {
        name,
        type: TYPE_SRV,
        class: klass,
        ttl,
        priority,
        weight,
        port,
        target: reader.name(),
      };
    }
    case TYPE_TXT: {
      const txt: Record$Txt = {};
      while (reader.position < end) {
        const size = reader.u8();
        if (size === 0) continue;
        const text = new TextDecoder().decode(reader.slice(size));
        const split = text.indexOf("=");
        if (split === -1) txt[text] = "";
        else txt[text.slice(0, split)] = text.slice(split + 1);
      }
      return { name, type: TYPE_TXT, class: klass, ttl, txt };
    }
    case TYPE_A: {
      const parts = [reader.u8(), reader.u8(), reader.u8(), reader.u8()];
      return { name, type: TYPE_A, class: klass, ttl, address: parts.join(".") };
    }
    default:
      // Anything else is skipped rather than refused: a shared network carries
      // plenty of record types that are not ours.
      return { name, type: TYPE_PTR, class: klass, ttl, ptr: "" };
  }
}

export function encodeMessage(message: Message): Uint8Array {
  const writer = new Writer();
  writer.u16(message.id);
  writer.u16(message.flags);
  writer.u16(message.questions.length);
  writer.u16(message.answers.length);
  writer.u16(0);
  writer.u16(message.additionals.length);
  for (const question of message.questions) {
    writer.name(question.name);
    writer.u16(question.type);
    writer.u16(question.class);
  }
  for (const answer of message.answers) writeRecord(writer, answer);
  for (const additional of message.additionals) writeRecord(writer, additional);
  return writer.finish();
}

export function decodeMessage(bytes: Uint8Array): Message {
  const reader = new Reader(bytes);
  const id = reader.u16();
  const flags = reader.u16();
  const questionCount = reader.u16();
  const answerCount = reader.u16();
  const authorityCount = reader.u16();
  const additionalCount = reader.u16();

  const questions: Question[] = [];
  for (let index = 0; index < questionCount; index++) {
    questions.push({ name: reader.name(), type: reader.u16(), class: reader.u16() });
  }
  const answers: Record[] = [];
  for (let index = 0; index < answerCount; index++) answers.push(readRecord(reader));
  for (let index = 0; index < authorityCount; index++) readRecord(reader);
  const additionals: Record[] = [];
  for (let index = 0; index < additionalCount; index++) additionals.push(readRecord(reader));

  return { id, flags, questions, answers, additionals };
}
