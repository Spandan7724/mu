import { z } from "zod";

export const REDACTED = "[redacted]";

// The value lives only here, so a BrowserSecret has no own property to spread,
// enumerate, structured-clone or stringify. Combined with the class prototype —
// which findSerializationViolations rejects — a token cannot reach an event,
// session entry or receipt even if a later lane forgets to strip it.
const values = new WeakMap<BrowserSecret, string>();

export class BrowserSecret {
  constructor(value: string) {
    if (value.length === 0) throw new TypeError("browser secret must not be empty");
    values.set(this, value);
  }

  reveal(): string {
    const value = values.get(this);
    if (value === undefined) throw new TypeError("browser secret has no value");
    return value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return "BrowserSecret";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

export function isBrowserSecret(value: unknown): value is BrowserSecret {
  return value instanceof BrowserSecret;
}

export const browserSecretSchema: z.ZodType<BrowserSecret, string> = z
  .string()
  .min(1)
  .transform((value) => new BrowserSecret(value));
