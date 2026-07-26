import { describe, expect, test } from "bun:test";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "mu";
import { linesFrom, parseOp, type RpcOut, runRpc } from "./rpc.ts";

// Drives the RPC surface exactly as an external script would: ops in, NDJSON out.
function harness(ops: string[], gap = 0) {
  const written: string[] = [];
  const io = {
    write: (line: string) => written.push(line),
    lines: (async function* () {
      for (const op of ops) {
        if (gap) await Bun.sleep(gap);
        yield op;
      }
    })(),
  };
  return { io, written };
}

function parsed(written: string[]): RpcOut[] {
  return written.map((line) => JSON.parse(line) as RpcOut);
}

describe("parseOp", () => {
  test("parses a valid op", () => {
    expect(parseOp('{"type":"input","text":"hi"}')).toEqual({ type: "input", text: "hi" });
  });

  test("malformed JSON reports a parse error rather than throwing", () => {
    expect(parseOp("{not json").type).toBe("parse_error");
    expect(parseOp('"a string"').type).toBe("parse_error");
  });
});

describe("linesFrom", () => {
  test("splits a chunked stream into lines", async () => {
    const stream = (async function* () {
      yield '{"a":';
      yield '1}\n{"b":2}\n';
      yield "trailing";
    })() as unknown as NodeJS.ReadableStream;

    const lines: string[] = [];
    for await (const line of linesFrom(stream)) lines.push(line);
    expect(lines).toEqual(['{"a":1}', '{"b":2}', "trailing"]);
  });
});

describe("runRpc", () => {
  test("announces ready, streams events for an input op, then shuts down", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hello rpc" }] }]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness([
      JSON.stringify({ type: "input", text: "hi" }),
      JSON.stringify({ type: "shutdown" }),
    ]);

    await runRpc(io, { agent });
    const out = parsed(written);

    expect(out[0]).toEqual({ type: "ready" });
    expect(out[out.length - 1]).toEqual({ type: "shutdown" });

    const events = out.filter((o) => o.type === "event");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.type === "event" && events[0].event.type).toBe("agent_start");
    // Every line is independently parseable — that is the wire contract.
    for (const line of written) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("a full session: input, steering, permission reply and abort", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "gated", arguments: {} }], delayMs: 15 },
      { content: [{ type: "text", text: "done" }] },
    ]);

    let resolvePermission: ((outcome: "allow" | "deny") => void) | undefined;
    const agent = new Agent({
      provider,
      model: fakeModel,
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
      onPermission: () =>
        new Promise<"allow" | "deny">((resolve) => {
          resolvePermission = resolve;
        }),
      tools: [
        {
          name: "gated",
          description: "needs approval",
          inputSchema: { type: "object" },
          execute: async () => ({ content: [{ type: "text", text: "ran" }] }),
        },
      ],
    });

    const pending = new Map<string, (outcome: "allow" | "deny") => void>();
    const { io, written } = harness(
      [
        JSON.stringify({ type: "input", text: "go" }),
        JSON.stringify({ type: "steer", text: "and also this" }),
        JSON.stringify({ type: "permission_reply", requestId: "PENDING", outcome: "allow" }),
        JSON.stringify({ type: "shutdown" }),
      ],
      25,
    );

    await runRpc(io, {
      agent,
      resolvePermission: (requestId, outcome) => {
        // The harness sends a placeholder id; resolve whatever ask is open.
        if (requestId === "PENDING" && resolvePermission) {
          resolvePermission(outcome);
          return true;
        }
        return pending.has(requestId);
      },
    });

    const out = parsed(written);
    const eventTypes = out
      .filter((o) => o.type === "event")
      .map((o) => (o.type === "event" ? o.event.type : ""));
    expect(eventTypes).toContain("permission_asked");
    expect(eventTypes).toContain("permission_resolved");
    expect(out[out.length - 1]?.type).toBe("shutdown");
  });

  test("an unknown permission id is reported as an error", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "x" }] }]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness([
      JSON.stringify({ type: "permission_reply", requestId: "nope", outcome: "allow" }),
      JSON.stringify({ type: "shutdown" }),
    ]);
    await runRpc(io, { agent, resolvePermission: () => false });

    const errors = parsed(written).filter((o) => o.type === "error");
    expect(errors.length).toBe(1);
    expect(errors[0]?.type === "error" && errors[0].message).toContain("unknown permission");
  });

  test("malformed input lines produce an error but keep the session alive", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "still here" }] }]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness([
      "{ this is not json",
      JSON.stringify({ type: "input", text: "hi" }),
      JSON.stringify({ type: "shutdown" }),
    ]);
    await runRpc(io, { agent });

    const out = parsed(written);
    expect(out.some((o) => o.type === "error")).toBe(true);
    expect(out.some((o) => o.type === "event")).toBe(true);
    expect(out[out.length - 1]?.type).toBe("shutdown");
  });

  test("commands are invocable over RPC", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "x" }] }]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness([
      JSON.stringify({ type: "command", text: "/model" }),
      JSON.stringify({ type: "shutdown" }),
    ]);
    await runRpc(io, {
      agent,
      runCommand: async (text) => `ran ${text}`,
    });

    const results = parsed(written).filter((o) => o.type === "command_result");
    expect(results[0]?.type === "command_result" && results[0].message).toBe("ran /model");
  });

  test("abort stops an in-flight run", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "slow" }], delayMs: 80 }]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness(
      [
        JSON.stringify({ type: "input", text: "go" }),
        JSON.stringify({ type: "abort" }),
        JSON.stringify({ type: "shutdown" }),
      ],
      20,
    );
    await runRpc(io, { agent });

    const end = parsed(written).find((o) => o.type === "event" && o.event.type === "agent_end");
    expect(end?.type === "event" && end.event.type === "agent_end" && end.event.reason).toBe(
      "aborted",
    );
  });
});

describe("shutdown semantics", () => {
  test("shutdown lets an in-flight run finish rather than cutting it off", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "completed answer" }], delayMs: 30 },
    ]);
    const agent = new Agent({ provider, model: fakeModel });
    // Both ops arrive at once, as a piping script would send them.
    const { io, written } = harness([
      JSON.stringify({ type: "input", text: "go" }),
      JSON.stringify({ type: "shutdown" }),
    ]);
    await runRpc(io, { agent });

    const end = parsed(written).find((o) => o.type === "event" && o.event.type === "agent_end");
    expect(end?.type === "event" && end.event.type === "agent_end" && end.event.reason).toBe(
      "done",
    );
    const assistant = parsed(written).find(
      (o) =>
        o.type === "event" &&
        o.event.type === "message_end" &&
        o.event.message.role === "assistant",
    );
    expect(assistant).toBeDefined();
  });

  test("abort before shutdown still cuts the run short", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "never finishes" }], delayMs: 80 },
    ]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness(
      [
        JSON.stringify({ type: "input", text: "go" }),
        JSON.stringify({ type: "abort" }),
        JSON.stringify({ type: "shutdown" }),
      ],
      15,
    );
    await runRpc(io, { agent });

    const end = parsed(written).find((o) => o.type === "event" && o.event.type === "agent_end");
    expect(end?.type === "event" && end.event.type === "agent_end" && end.event.reason).toBe(
      "aborted",
    );
  });
});
