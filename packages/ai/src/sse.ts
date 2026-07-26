export interface SseEvent {
  event: string | null;
  data: string;
}

interface SseState {
  event: string | null;
  data: string[];
}

function flush(state: SseState): SseEvent | null {
  if (!state.event && state.data.length === 0) return null;
  const event: SseEvent = { event: state.event, data: state.data.join("\n") };
  state.event = null;
  state.data = [];
  return event;
}

function decodeLine(line: string, state: SseState): SseEvent | null {
  if (line === "") return flush(state);
  if (line.startsWith(":")) return null;
  const i = line.indexOf(":");
  const field = i === -1 ? line : line.slice(0, i);
  let value = i === -1 ? "" : line.slice(i + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  if (field === "event") state.event = value;
  else if (field === "data") state.data.push(value);
  return null;
}

export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: SseState = { event: null, data: [] };
  let buffer = "";

  const drain = function* (): Generator<SseEvent> {
    let idx = buffer.search(/[\r\n]/);
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      let next = idx + 1;
      if (buffer[idx] === "\r" && buffer[next] === "\n") next += 1;
      buffer = buffer.slice(next);
      const event = decodeLine(line, state);
      if (event) yield event;
      idx = buffer.search(/[\r\n]/);
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drain();
    }
    buffer += decoder.decode();
    yield* drain();
    if (buffer.length > 0) {
      const event = decodeLine(buffer, state);
      if (event) yield event;
    }
    const trailing = flush(state);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}
