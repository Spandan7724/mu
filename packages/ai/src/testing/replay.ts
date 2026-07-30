export interface RecordedInteraction {
  request: { method: string; url: string; body?: string };
  response: { status: number; headers?: Record<string, string>; body: string };
}

export interface Cassette {
  interactions: RecordedInteraction[];
}

export interface ReplayCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ReplayHandle {
  fetch: typeof fetch;
  calls: ReplayCall[];
  assertExhausted(): void;
}

function headersToRecord(init: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function replayFetch(cassette: Cassette): ReplayHandle {
  let index = 0;
  const calls: ReplayCall[] = [];

  const replay = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const interaction = cassette.interactions[index];
    if (!interaction) {
      throw new Error(`replayFetch: no recorded interaction for request #${index + 1} (${url})`);
    }
    index++;
    calls.push({
      method,
      url,
      headers: headersToRecord(init?.headers),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (interaction.request.url !== url) {
      throw new Error(
        `replayFetch: url mismatch — expected ${interaction.request.url}, got ${url}`,
      );
    }
    return new Response(interaction.response.body, {
      status: interaction.response.status,
      headers: interaction.response.headers ?? {},
    });
  }) as typeof fetch;

  return {
    fetch: replay,
    calls,
    assertExhausted() {
      if (index !== cassette.interactions.length) {
        throw new Error(
          `replayFetch: ${cassette.interactions.length - index} recorded interaction(s) unused`,
        );
      }
    },
  };
}

// Response headers kept when recording; everything else (auth echoes, cookies,
// org identifiers, rate-limit state) is dropped so cassettes are committable.
const RECORDED_HEADERS = new Set(["content-type", "retry-after", "retry-after-ms"]);

// Wraps a real fetch, capturing interactions into an in-memory cassette.
export function recordFetch(base: typeof fetch = fetch): {
  fetch: typeof fetch;
  cassette: Cassette;
} {
  const cassette: Cassette = { interactions: [] };
  const recording = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const response = await base(input as string, init);
    const body = await response.clone().text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (RECORDED_HEADERS.has(key.toLowerCase())) headers[key] = value;
    });
    cassette.interactions.push({
      request: {
        method: init?.method ?? "GET",
        url,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      },
      response: { status: response.status, headers, body },
    });
    return response;
  }) as typeof fetch;
  return { fetch: recording, cassette };
}
