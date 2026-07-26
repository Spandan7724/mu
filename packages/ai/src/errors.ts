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
    return RETRYABLE.has(this.kind);
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

function parseRetryAfter(headers: Headers): number | undefined {
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
