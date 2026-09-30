import { expect, test } from "bun:test";
import { AiError } from "@mu/ai";
import { choice, JevClient, type JevUsage, jevFromEnv, noul } from "./client.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const answer = {
  model: "jev-1.13.0",
  answers: {
    field: { type: "choice", choice: "e2", probabilities: { e2: 0.9, none: 0.1 }, confidence: 0.8 },
    done: { type: "noul", noul: 0.1 },
  },
  usage: { input_tokens: 320, output_tokens: 20 },
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const questions = {
  field: choice("Which field?", { e2: null, none: "No field" }),
  done: noul("Is the goal reached?"),
};

test("posts state and typed questions with the bearer key and model, and counts usage", async () => {
  const { fn, calls } = fakeFetch([() => json(answer)]);
  const client = new JevClient({ apiKey: "k-123", fetch: fn });
  const usage: JevUsage = { calls: 0, ms: 0, inputTokens: 0 };
  const response = await client.ask({ page: "x" }, questions, AbortSignal.timeout(1000), usage);
  expect(response.answers.field).toMatchObject({ choice: "e2" });
  expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer k-123");
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
    state: { page: "x" },
    model: "jev-latest",
    questions: {
      field: {
        type: "choice",
        instructions: "Which field?",
        criteria: { e2: null, none: "No field" },
      },
      done: { type: "noul", instructions: "Is the goal reached?" },
    },
  });
  expect(usage).toMatchObject({ calls: 1, inputTokens: 320 });
});

test("retries rate limits and overload after retry-after, but not bad requests", async () => {
  const { fn, calls } = fakeFetch([
    () => json({ error: "slow down" }, 429, { "retry-after-ms": "5" }),
    () => json({ error: "busy" }, 529, { "retry-after-ms": "5" }),
    () => json(answer),
  ]);
  const client = new JevClient({ apiKey: "k", fetch: fn });
  await client.ask("s", questions, AbortSignal.timeout(5000));
  expect(calls).toHaveLength(3);

  const bad = fakeFetch([() => json({ detail: "questions.field.criteria: too many" }, 422)]);
  const rejected = new JevClient({ apiKey: "k", fetch: bad.fn }).ask(
    "s",
    questions,
    AbortSignal.timeout(1000),
  );
  await expect(rejected).rejects.toThrow("Jev HTTP 422");
  await expect(rejected).rejects.toBeInstanceOf(AiError);
  expect(bad.calls).toHaveLength(1);
});

test("an answer missing for a question is an error, and an abort stops the request", async () => {
  const { fn } = fakeFetch([() => json({ ...answer, answers: { field: answer.answers.field } })]);
  await expect(
    new JevClient({ apiKey: "k", fetch: fn }).ask("s", questions, AbortSignal.timeout(1000)),
  ).rejects.toThrow('no answer for "done"');

  const hanging = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) =>
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
    )) as unknown as typeof fetch;
  const controller = new AbortController();
  const pending = new JevClient({ apiKey: "k", fetch: hanging }).ask(
    "s",
    questions,
    controller.signal,
  );
  controller.abort(new Error("stopped"));
  await expect(pending).rejects.toThrow("aborted");
});

test("the key comes from JEV_API_KEY or TYPESAFE_API_KEY; none means no client", () => {
  expect(jevFromEnv({})).toBeUndefined();
  expect(jevFromEnv({ JEV_API_KEY: "a" })?.model).toBe("jev-latest");
  expect(jevFromEnv({ TYPESAFE_API_KEY: "b", JEV_MODEL: "jev-1.13.0" })?.model).toBe("jev-1.13.0");
});
