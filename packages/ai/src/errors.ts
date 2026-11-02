export type AiErrorKind =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "context_too_long"
  | "bad_request"
  | "not_found"
  | "network"
  | "api";

const RETRYABLE: ReadonlySet<AiErrorKind> = new Set(["rate_limit", "overloaded", "network"]);

export function isRetryableErrorKind(kind: string | undefined): boolean {
  return kind !== undefined && RETRYABLE.has(kind as AiErrorKind);
}

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: AiErrorKind,
    message: string,
    opts?: { status?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }

  get retryable(): boolean {
    return isRetryableErrorKind(this.kind);
  }
}

const CONTEXT_TOO_LONG_PATTERNS = [
  /prompt is too long/i,
  /context window/i,
  /context[_ ]length[_ ]exceeded/i,
  /exceeds the maximum number of tokens/i,
  /input token count.*exceeds/i,
  /too many total text bytes/i,
];

export function isContextTooLongMessage(message: string): boolean {
  return CONTEXT_TOO_LONG_PATTERNS.some((p) => p.test(message));
}

function parseRetryAfter(headers: Headers | Record<string, unknown>): number | undefined {
  if (!(headers instanceof Headers)) {
    const entries = Object.entries(headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return parseRetryAfter(new Headers(entries));
  }
  const ms = headers.get("retry-after-ms");
  if (ms) {
    const v = Number.parseFloat(ms);
    if (!Number.isNaN(v)) return v;
  }
  const s = headers.get("retry-after");
  if (s) {
    const seconds = Number.parseFloat(s);
    if (!Number.isNaN(seconds)) return seconds * 1000;
    const date = Date.parse(s);
    if (!Number.isNaN(date)) return date - Date.now();
  }
  return undefined;
}

export function classifyHttpError(status: number, body: string, headers: Headers): AiError {
  const opts = { status, retryAfterMs: parseRetryAfter(headers) } as {
    status: number;
    retryAfterMs?: number;
  };
  if (status === 401 || status === 403) return new AiError("auth", body, opts);
  if (status === 404) return new AiError("not_found", body, opts);
  if (status === 429) return new AiError("rate_limit", body, opts);
  if (status === 529 || status === 503) return new AiError("overloaded", body, opts);
  if (status >= 500) return new AiError("api", body, opts);
  if (isContextTooLongMessage(body)) return new AiError("context_too_long", body, opts);
  return new AiError("bad_request", body, opts);
}

const OVERLOADED_CODES = new Set([
  "server_is_overloaded",
  "service_unavailable_error",
  "overloaded_error",
  "slow_down",
]);
const RATE_LIMIT_CODES = new Set(["rate_limit_exceeded", "rate_limit_error"]);

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

// An error reported inside an already-accepted stream (OpenAI Responses
// `error` / `response.failed`, Anthropic `error`). The payload may nest the
// details under `error` and carry the HTTP headers the server would have sent.
export function classifyStreamError(payload: unknown, raw: string): AiError {
  let parsed = payload;
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload);
    } catch {}
  }
  const outer = record(parsed);
  const inner = record(outer?.error) ?? outer;
  const code = typeof inner?.code === "string" ? inner.code : undefined;
  const type = typeof inner?.type === "string" ? inner.type : undefined;
  const message =
    (typeof inner?.message === "string" && inner.message) ||
    (typeof outer?.message === "string" && outer.message) ||
    raw;
  const headers = record(inner?.headers) ?? record(outer?.headers);
  const retryAfterMs = headers ? parseRetryAfter(headers) : undefined;
  const opts = retryAfterMs !== undefined ? { retryAfterMs } : undefined;
  const label = code ?? type;
  const text = label && !message.includes(label) ? `${message} (${label})` : message;
  const matches = (codes: ReadonlySet<string>) =>
    (code !== undefined && codes.has(code)) || (type !== undefined && codes.has(type));
  if (matches(OVERLOADED_CODES)) return new AiError("overloaded", text, opts);
  if (matches(RATE_LIMIT_CODES)) return new AiError("rate_limit", text, opts);
  if (code === "context_length_exceeded" || isContextTooLongMessage(message)) {
    return new AiError("context_too_long", text, opts);
  }
  return new AiError("api", text, opts);
}
