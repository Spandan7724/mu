import { describe, expect, test } from "bun:test";
import { CommandRegistry } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import {
  type ClientFrame,
  decodeServerFrame,
  encodeFrame,
  type Op,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "@mu/protocol";
import { SessionHost } from "@mu/server";
import { Agent, parseMarkdownCommand, toCommand } from "mu";
import { linesFrom, parseFrame, runRpc } from "./rpc.ts";

// Drives the RPC surface exactly as an external script would: frames in,
// NDJSON frames out. Stdin closing is how the transport ends.
function harness(frames: ClientFrame[], gap = 0) {
  const written: string[] = [];
  const io = {
    write: (line: string) => written.push(line),
    lines: (async function* () {
      for (const frame of frames) {
        if (gap) await Bun.sleep(gap);
        yield encodeFrame(frame);
      }
    })(),
  };
  return { io, written };
}

function raw(lines: string[], gap = 0) {
  const written: string[] = [];
  return {
    written,
    io: {
      write: (line: string) => written.push(line),
      lines: (async function* () {
        for (const line of lines) {
          if (gap) await Bun.sleep(gap);
          yield line;
        }
      })(),
    },
  };
}

function parsed(written: string[]): ServerFrame[] {
  return written.map((line) => {
    const decoded = decodeServerFrame(line);
    if (!decoded.ok) throw new Error(`unparseable frame: ${line} (${decoded.message})`);
    return decoded.value;
  });
}

function eventTypes(frames: ServerFrame[]): string[] {
  return frames.flatMap((frame) => (frame.t === "event" ? [frame.event.type] : []));
}

function hostFor(agent: Agent, commands?: CommandRegistry) {
  return new SessionHost({
    agent,
    workspace: { name: "mu", root: "/home/x/mu" },
    ...(commands ? { commands } : {}),
  });
}

const op = (id: string, op: Op): ClientFrame => ({ t: "op", id, op });

describe("parseFrame", () => {
  test("parses a valid frame", () => {
    expect(parseFrame('{"t":"op","id":"1","op":{"k":"input","text":"hi"}}')).toEqual({
      t: "op",
      id: "1",
      op: { k: "input", text: "hi" },
    });
  });

  test("malformed JSON reports a parse error rather than throwing", () => {
    expect(parseFrame("{not json").t).toBe("parse_error");
    expect(parseFrame('"a string"').t).toBe("parse_error");
    expect(parseFrame('{"t":"op","id":"1","op":{"k":"read_file"}}').t).toBe("parse_error");
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
  test("opens with hello and a snapshot, streams seq'd events, then says bye", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "hello rpc" }] }]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness([op("1", { k: "input", text: "hi" })]);

    await runRpc(io, { host: hostFor(agent), version: "9.9.9", name: "workstation" });
    const out = parsed(written);

    expect(out[0]).toEqual({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      host: {
        hostId: expect.any(String),
        instanceId: expect.any(String),
        name: "workstation",
        version: "9.9.9",
        workspace: { name: "mu", root: "/home/x/mu" },
      },
    });
    expect(out[1]?.t).toBe("state");
    expect(out[out.length - 1]).toEqual({ t: "bye", reason: "shutdown" });

    const events = out.filter((frame) => frame.t === "event");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.t === "event" && events[0].event.type).toBe("agent_start");
    // Sequence numbers are per session, monotonic and gap-free.
    const seqs = events.map((frame) => (frame.t === "event" ? frame.seq : 0));
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    // Every line is independently parseable — that is the wire contract.
    for (const line of written) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("a full session: input, steering, permission reply and abort", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "gated", arguments: {} }], delayMs: 15 },
      { content: [{ type: "text", text: "done" }] },
    ]);

    let host: SessionHost | undefined;
    const agent = new Agent({
      provider,
      model: fakeModel,
      permissions: [{ permission: "*", pattern: "*", action: "ask" }],
      onPermission: (request) =>
        host ? host.onPermission(request) : Promise.resolve<"allow" | "deny">("deny"),
      tools: [
        {
          name: "gated",
          description: "needs approval",
          inputSchema: { type: "object" },
          execute: async () => ({ content: [{ type: "text", text: "ran" }] }),
        },
      ],
    });
    host = hostFor(agent);

    // The reply carries the id the host handed out, which the driver reads off
    // the permission_asked event rather than guessing.
    const written: string[] = [];
    const io = {
      write: (line: string) => written.push(line),
      lines: (async function* () {
        yield encodeFrame(op("1", { k: "input", text: "go" }));
        await Bun.sleep(25);
        yield encodeFrame(op("2", { k: "steer", text: "and also this" }));
        while (agent.pendingPermissions.length === 0) await Bun.sleep(1);
        const requestId = agent.pendingPermissions[0]?.id as string;
        yield encodeFrame(op("3", { k: "permission_reply", requestId, outcome: "allow" }));
      })(),
    };

    await runRpc(io, { host });

    const out = parsed(written);
    expect(eventTypes(out)).toContain("permission_asked");
    expect(eventTypes(out)).toContain("permission_resolved");
    expect(out.filter((frame) => frame.t === "reply").every((frame) => frame.ok)).toBe(true);
    expect(out[out.length - 1]?.t).toBe("bye");
  });

  test("an unknown permission id is refused with unknown_request", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "x" }] }]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness([
      op("1", { k: "permission_reply", requestId: "nope", outcome: "allow" }),
    ]);
    await runRpc(io, { host: hostFor(agent) });

    const replies = parsed(written).filter((frame) => frame.t === "reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.t === "reply" && replies[0].ok === false && replies[0].error.code).toBe(
      "unknown_request",
    );
  });

  test("malformed input lines produce an error reply but keep the session alive", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "still here" }] }]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = raw([
      "{ this is not json",
      encodeFrame(op("1", { k: "input", text: "hi" })),
    ]);
    await runRpc(io, { host: hostFor(agent) });

    const out = parsed(written);
    expect(out.some((frame) => frame.t === "reply" && frame.ok === false)).toBe(true);
    expect(out.some((frame) => frame.t === "event")).toBe(true);
    expect(out[out.length - 1]?.t).toBe("bye");
  });

  test("commands are invocable over the op vocabulary", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "x" }] }]);
    const agent = new Agent({ provider, model: fakeModel });
    const commands = new CommandRegistry();
    commands.register({
      name: "model",
      description: "echo",
      run: (ctx) => ({ handled: true, message: `ran /model ${ctx.args}`.trim() }),
    });
    const { io, written } = harness([op("1", { k: "command", text: "/model" })]);
    await runRpc(io, { host: hostFor(agent, commands) });

    const reply = parsed(written).find((frame) => frame.t === "reply");
    expect(reply?.t === "reply" && reply.ok && (reply.data as { message: string }).message).toBe(
      "ran /model",
    );
  });

  test("a second input is rejected as busy instead of overlapping the active run", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "only answer" }], delayMs: 40 },
      { content: [{ type: "text", text: "must not run" }] },
    ]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness([
      op("1", { k: "input", text: "first" }),
      op("2", { k: "input", text: "second" }),
    ]);
    await runRpc(io, { host: hostFor(agent) });

    expect(provider.callCount).toBe(1);
    const replies = parsed(written).filter((frame) => frame.t === "reply");
    expect(replies.some((frame) => frame.t === "reply" && frame.ok === false)).toBe(true);
    const busy = replies.find((frame) => frame.t === "reply" && frame.ok === false);
    expect(busy?.t === "reply" && busy.ok === false && busy.error.code).toBe("busy");
    expect(JSON.stringify(provider.requests[0])).toContain("first");
    expect(JSON.stringify(provider.requests[0])).not.toContain("second");
  });

  test("markdown commands stream through the managed run with model and tool restrictions", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "reviewed" }] }]);
    const agent = new Agent({
      provider,
      model: fakeModel,
      tools: [
        {
          name: "read",
          description: "read",
          inputSchema: { type: "object" },
          execute: async () => ({ content: [{ type: "text" as const, text: "read" }] }),
        },
        {
          name: "write",
          description: "write",
          inputSchema: { type: "object" },
          execute: async () => ({ content: [{ type: "text" as const, text: "write" }] }),
        },
      ],
    });
    const commands = new CommandRegistry();
    commands.register(
      toCommand(
        parseMarkdownCommand(
          "review",
          [
            "---",
            "model: openai/gpt-5.1",
            "allowed-tools: [read]",
            "---",
            "Review $ARGUMENTS carefully.",
          ].join("\n"),
        ),
      ),
    );
    const { io, written } = harness([op("1", { k: "command", text: "/review src/a.ts" })]);
    await runRpc(io, { host: hostFor(agent, commands) });

    const reply = parsed(written).find((frame) => frame.t === "reply");
    const data = reply?.t === "reply" && reply.ok ? (reply.data as { data?: unknown }) : undefined;
    expect(data?.data).toMatchObject({ kind: "markdown-command", model: "openai/gpt-5.1" });
    expect(agent.modelRef).toBe("fake/fake-1");
  });

  test("abort stops an in-flight run", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "slow" }], delayMs: 80 }]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness(
      [op("1", { k: "input", text: "go" }), op("2", { k: "abort" })],
      20,
    );
    await runRpc(io, { host: hostFor(agent) });

    const end = parsed(written).find(
      (frame) => frame.t === "event" && frame.event.type === "agent_end",
    );
    expect(end?.t === "event" && end.event.type === "agent_end" && end.event.reason).toBe(
      "aborted",
    );
  });

  test("attach re-sends the snapshot without disturbing the stream", async () => {
    const provider = new FakeProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const agent = new Agent({ provider, model: fakeModel, sessionId: "s-attach" });
    const { io, written } = harness([
      op("1", { k: "input", text: "go" }),
      { t: "attach", session: "s-attach", policy: { updates: "full" } },
    ]);
    await runRpc(io, { host: hostFor(agent) });

    const states = parsed(written).filter((frame) => frame.t === "state");
    expect(states).toHaveLength(2);
    expect(states[1]?.t === "state" && states[1].state.sessionId).toBe("s-attach");
  });
});

describe("shutdown semantics", () => {
  test("stdin closing lets an in-flight run finish rather than cutting it off", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "completed answer" }], delayMs: 30 },
    ]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness([op("1", { k: "input", text: "go" })]);
    await runRpc(io, { host: hostFor(agent) });

    const end = parsed(written).find(
      (frame) => frame.t === "event" && frame.event.type === "agent_end",
    );
    expect(end?.t === "event" && end.event.type === "agent_end" && end.event.reason).toBe("done");
    const assistant = parsed(written).find(
      (frame) =>
        frame.t === "event" &&
        frame.event.type === "message_end" &&
        frame.event.message.role === "assistant",
    );
    expect(assistant).toBeDefined();
  });

  test("abort before the stream ends still cuts the run short", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "text", text: "never finishes" }], delayMs: 80 },
    ]);
    const agent = new Agent({ provider, model: fakeModel });
    const { io, written } = harness(
      [op("1", { k: "input", text: "go" }), op("2", { k: "abort" })],
      15,
    );
    await runRpc(io, { host: hostFor(agent) });

    const end = parsed(written).find(
      (frame) => frame.t === "event" && frame.event.type === "agent_end",
    );
    expect(end?.t === "event" && end.event.type === "agent_end" && end.event.reason).toBe(
      "aborted",
    );
  });
});
