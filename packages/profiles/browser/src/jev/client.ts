import { AiError, classifyHttpError, withRetries } from "@mu/ai";

// TypeSafe's System One API (https://docs.typesafe.ai/api), called with plain fetch.
export const JEV_BASE_URL = "https://api.typesafe.ai";
export const JEV_MODEL = "jev-latest";
export const MAX_CHOICE_OPTIONS = 255;
const ATTEMPT_TIMEOUT_MS = 10_000;

export type Criterion = string | Record<string, unknown> | unknown[] | null;

export type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: Criterion; false?: Criterion } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, Criterion> }
  | { type: "score"; instructions: unknown; criteria: Criterion[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      probabilities: Record<string, number>;
      legend: Record<string, string>;
      confidence: number;
    };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface JevUsage {
  calls: number;
  ms: number;
  inputTokens: number;
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
}

export class JevClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: JevClientOptions) {
    this.model = options.model ?? JEV_MODEL;
    this.baseUrl = (options.baseUrl ?? JEV_BASE_URL).replace(/\/+$/, "");
    this.fetch = options.fetch ?? fetch;
  }

  // Answers every question against one state in a single request.
  async ask(
    state: unknown,
    questions: Record<string, JevQuestion>,
    signal: AbortSignal,
    usage?: JevUsage,
  ): Promise<JevResponse> {
    const started = performance.now();
    const body = JSON.stringify({ state, model: this.model, questions });
    const response = await withRetries(() => this.attempt(body, signal), {
      maxRetries: this.options.maxRetries ?? 2,
      maxRetryDelayMs: 5_000,
      signal,
    });
    if (usage) {
      usage.calls++;
      usage.ms += performance.now() - started;
      usage.inputTokens += response.usage?.input_tokens ?? 0;
    }
    for (const id of Object.keys(questions)) {
      if (!response.answers?.[id]) throw new AiError("api", `Jev returned no answer for "${id}"`);
    }
    return response;
  }

  private async attempt(body: string, signal: AbortSignal): Promise<JevResponse> {
    const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = timeout.aborted
        ? `timed out after ${ATTEMPT_TIMEOUT_MS} ms`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new AiError("network", `Jev request failed: ${reason}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = classifyHttpError(response.status, text.slice(0, 500), response.headers);
      throw new AiError(error.kind, `Jev HTTP ${response.status}: ${error.message}`, {
        status: response.status,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      });
    }
    return (await response.json()) as JevResponse;
  }
}

export function jevKey(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.JEV_API_KEY || env.TYPESAFE_API_KEY || undefined;
}

export function jevFromEnv(
  env: Record<string, string | undefined> = process.env,
): JevClient | undefined {
  const apiKey = jevKey(env);
  if (!apiKey) return undefined;
  return new JevClient({
    apiKey,
    ...(env.TYPESAFE_BASE_URL ? { baseUrl: env.TYPESAFE_BASE_URL } : {}),
    ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}),
  });
}

export const choice = (
  instructions: unknown,
  criteria: Record<string, Criterion>,
): JevQuestion => ({ type: "choice", instructions, criteria });

export const noul = (
  instructions: unknown,
  criteria?: { true?: Criterion; false?: Criterion },
): JevQuestion => ({ type: "noul", instructions, ...(criteria ? { criteria } : {}) });

export function choiceOf(answer: JevAnswer | undefined) {
  if (answer?.type !== "choice")
    throw new AiError("api", "Jev answered a choice with another type");
  return answer;
}

export function noulOf(answer: JevAnswer | undefined): number {
  if (answer?.type !== "noul") throw new AiError("api", "Jev answered a noul with another type");
  return answer.noul;
}
