import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

// Bounds every browser value that can reach a transcript, event, session entry or
// receipt. BD22 requires explicit limits; without them a hostile page controls how
// much of the context window and how many artifact bytes it consumes.
export const BROWSER_LIMITS = {
  maxSummaryChars: 4_000,
  maxSnapshotChars: 200_000,
  maxElements: 2_000,
  maxElementTextChars: 2_000,
  maxOptionsPerElement: 500,
  maxFrames: 200,
  maxTabs: 200,
  maxScreenshotBase64Chars: 8_000_000,
  maxSerializableDepth: 64,
} as const;

export interface SerializationViolation {
  path: string;
  reason:
    | "undefined"
    | "function"
    | "symbol"
    | "bigint"
    | "non-finite-number"
    | "class-instance"
    | "cycle"
    | "too-deep";
}

function describe(
  path: string[],
  reason: SerializationViolation["reason"],
): SerializationViolation {
  return { path: path.length === 0 ? "(root)" : path.join("."), reason };
}

function walk(
  value: unknown,
  path: string[],
  ancestors: Set<object>,
  out: SerializationViolation[],
): void {
  if (path.length > BROWSER_LIMITS.maxSerializableDepth) {
    out.push(describe(path, "too-deep"));
    return;
  }
  switch (typeof value) {
    case "undefined":
      out.push(describe(path, "undefined"));
      return;
    case "function":
      out.push(describe(path, "function"));
      return;
    case "symbol":
      out.push(describe(path, "symbol"));
      return;
    case "bigint":
      out.push(describe(path, "bigint"));
      return;
    case "number":
      if (!Number.isFinite(value)) out.push(describe(path, "non-finite-number"));
      return;
    case "string":
    case "boolean":
      return;
    default:
      break;
  }
  if (value === null) return;
  const object = value as object;
  if (ancestors.has(object)) {
    out.push(describe(path, "cycle"));
    return;
  }
  if (Array.isArray(object)) {
    ancestors.add(object);
    for (const [index, entry] of object.entries()) {
      walk(entry, [...path, String(index)], ancestors, out);
    }
    ancestors.delete(object);
    return;
  }
  // A plain object is the only remaining shape a receipt or event may carry: Date,
  // Map, Error, BrowserSecret, DOM handles and Playwright objects all fail here.
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) {
    out.push(describe(path, "class-instance"));
    return;
  }
  ancestors.add(object);
  for (const [key, entry] of Object.entries(object)) {
    walk(entry, [...path, key], ancestors, out);
  }
  ancestors.delete(object);
}

export function findSerializationViolations(value: unknown): SerializationViolation[] {
  const out: SerializationViolation[] = [];
  walk(value, [], new Set(), out);
  return out;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return findSerializationViolations(value).length === 0;
}

export function assertJsonSerializable(
  value: unknown,
  label = "value",
): asserts value is JsonValue {
  const violations = findSerializationViolations(value);
  if (violations.length === 0) return;
  const detail = violations
    .slice(0, 5)
    .map((violation) => `${violation.path}: ${violation.reason}`)
    .join("; ");
  throw new TypeError(`${label} is not JSON-serializable (${detail})`);
}
