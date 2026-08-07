import { afterEach, describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import {
  type ClientFrame,
  decodeServerFrame,
  encodeFrame,
  type Op,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "@mu/protocol";
import { Agent } from "mu";
import { type RunningServer, serve } from "./server.ts";
import { SessionHost } from "./session-host.ts";

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

const gatedTool = {
  name: "gated",
  description: "needs approval",
  inputSchema: { type: "object" },
  execute: async () => ({ content: [{ type: "text" as const, text: "ran" }] }),
};

function start(provider: FakeProvider, permissions?: { ask: boolean }) {
  let host: SessionHost | undefined;
  const agent = new Agent({
    provider,
    model: fakeModel,
    tools: [gatedTool as never],
    ...(permissions?.ask
      ? { permissions: [{ permission: "*", pattern: "*", action: "ask" as const }] }
      : {}),
    onPermission: (request: PermissionRequest) =>
      host ? host.onPermission(request) : Promise.resolve<"allow" | "deny">("deny"),
  });
  host = new SessionHost({ agent, workspace: { name: "app", root: "/home/x/app" } });
  const server = serve({ host, hostName: "workstation", version: "0.0.4" });
  running.push(server);
  return { agent, host, server };
}

// A client that speaks the wire, so the test exercises the socket rather than
// the host it wraps.
async function connect(server: RunningServer) {
  const socket = new WebSocket(server.url);
  const frames: ServerFrame[] = [];
  socket.addEventListener("message", (event) => {
    const decoded = decodeServerFrame(String(event.data));
    if (!decoded.ok) throw new Error(`unparseable: ${event.data} (${decoded.message})`);
    frames.push(decoded.value);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("could not connect")));
  });

  const send = (frame: ClientFrame) => socket.send(encodeFrame(frame));
  const until = async <T>(pick: () => T | undefined, label: string): Promise<T> => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const found = pick();
      if (found !== undefined) return found;
      await Bun.sleep(5);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(frames)}`);
  };

  return {
    socket,
    frames,
    send,
    until,
    op: (id: string, op: Op, session?: string) =>
      send({ t: "op", id, op, ...(session ? { session } : {}) }),
    reply: (id: string) =>
      until(() => frames.find((frame) => frame.t === "reply" && frame.id === id), `reply ${id}`),
    events: () => frames.flatMap((frame) => (frame.t === "event" ? [frame.event] : [])),
    close: () => socket.close(),
  };
}

describe("loopback WebSocket endpoint", () => {
  test("binds loopback on an ephemeral port and greets with hello and sessions", async () => {
    const { server } = start(new FakeProvider([]));
    expect(server.hostname).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);

    const client = await connect(server);
    const hello = await client.until(
      () => client.frames.find((frame) => frame.t === "hello"),
      "hello",
    );

    expect(hello.t === "hello" && hello.protocol).toBe(PROTOCOL_VERSION);
    expect(hello.t === "hello" && hello.host.name).toBe("workstation");
    expect(hello.t === "hello" && hello.host.workspace).toEqual({
      name: "app",
      root: "/home/x/app",
    });
    const sessions = await client.until(
      () => client.frames.find((frame) => frame.t === "sessions"),
      "sessions",
    );
    expect(sessions.t === "sessions" && sessions.sessions).toHaveLength(1);
    client.close();
  });

  test("nothing but the WebSocket upgrade is served", async () => {
    const { server } = start(new FakeProvider([]));
    const response = await fetch(`http://${server.hostname}:${server.port}/`);
    expect(response.status).toBe(426);
  });

  test("attaching returns a snapshot and then streams the run", async () => {
    const { agent, server } = start(
      new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]),
    );
    const client = await connect(server);
    client.send({ t: "attach", session: agent.sessionId, policy: { updates: "full" } });

    const state = await client.until(
      () => client.frames.find((frame) => frame.t === "state"),
      "state",
    );
    expect(state.t === "state" && state.state.sessionId).toBe(agent.sessionId);

    client.op("1", { k: "input", text: "go" });
    const accepted = await client.reply("1");
    expect(accepted.t === "reply" && accepted.ok).toBe(true);

    await client.until(
      () => client.events().find((event) => event.type === "agent_end"),
      "agent_end",
    );
    expect(client.events().map((event) => event.type)).toContain("message_end");
    client.close();
  });

  test("an unknown session is refused rather than silently attached", async () => {
    const { server } = start(new FakeProvider([]));
    const client = await connect(server);
    client.send({ t: "attach", session: "s-nope", policy: { updates: "full" } });

    const refusal = await client.until(
      () => client.frames.find((frame) => frame.t === "reply" && frame.ok === false),
      "refusal",
    );
    expect(refusal.t === "reply" && refusal.ok === false && refusal.error.code).toBe(
      "unknown_session",
    );
    client.close();
  });

  test("two clients over the socket see one stream and first-responder-wins", async () => {
    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "gated", arguments: {} }], delayMs: 5 },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const { agent, server } = start(provider, { ask: true });
    const terminal = await connect(server);
    const phone = await connect(server);
    for (const client of [terminal, phone]) {
      client.send({ t: "attach", session: agent.sessionId, policy: { updates: "full" } });
    }
    await phone.until(() => phone.frames.find((frame) => frame.t === "state"), "state");

    terminal.op("1", { k: "input", text: "go" });
    const asked = await phone.until(
      () => phone.events().find((event) => event.type === "permission_asked"),
      "permission_asked",
    );
    const requestId = asked.type === "permission_asked" ? asked.request.id : "";

    terminal.op("2", { k: "permission_reply", requestId, outcome: "allow" });
    const first = await terminal.reply("2");
    expect(first.t === "reply" && first.ok).toBe(true);

    phone.op("3", { k: "permission_reply", requestId, outcome: "deny" });
    const second = await phone.reply("3");
    expect(second.t === "reply" && second.ok === false && second.error.code).toBe(
      "unknown_request",
    );

    // The resolution reached the client that did not answer.
    const resolved = await phone.until(
      () => phone.events().find((event) => event.type === "permission_resolved"),
      "permission_resolved",
    );
    expect(resolved).toEqual({ type: "permission_resolved", requestId, outcome: "allow" });

    await terminal.until(
      () => terminal.events().find((event) => event.type === "agent_end"),
      "agent_end",
    );
    expect(phone.events().map((event) => event.type)).toEqual(
      terminal.events().map((event) => event.type),
    );
    terminal.close();
    phone.close();
  });

  test("re-attaching with sinceSeq replays only what was missed", async () => {
    const { agent, server } = start(
      new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]),
    );
    const first = await connect(server);
    first.send({ t: "attach", session: agent.sessionId, policy: { updates: "full" } });
    await first.until(() => first.frames.find((frame) => frame.t === "state"), "state");
    first.op("1", { k: "input", text: "go" });
    await first.until(
      () => first.events().find((event) => event.type === "agent_end"),
      "agent_end",
    );
    const all = first.frames.filter((frame) => frame.t === "event");
    first.close();

    const second = await connect(server);
    second.send({
      t: "attach",
      session: agent.sessionId,
      policy: { updates: "full" },
      sinceSeq: 3,
    });
    await second.until(() => second.frames.find((frame) => frame.t === "state"), "state");

    const replayed = second.frames.filter((frame) => frame.t === "event");
    expect(replayed).toEqual(all.slice(3));
    second.close();
  });

  test("an out-of-range sinceSeq sends gap and then a fresh snapshot", async () => {
    let host: SessionHost | undefined;
    const agent = new Agent({
      provider: new FakeProvider([{ content: [{ type: "text", text: "hi" }] }]),
      model: fakeModel,
      onPermission: (request: PermissionRequest) =>
        host ? host.onPermission(request) : Promise.resolve<"allow" | "deny">("deny"),
    });
    host = new SessionHost({
      agent,
      workspace: { name: "app", root: "/home/x/app" },
      ringEntries: 2,
    });
    const server = serve({ host, hostName: "workstation", version: "0.0.4" });
    running.push(server);

    const warm = await connect(server);
    warm.op("1", { k: "input", text: "go" });
    await warm.reply("1");
    await Bun.sleep(50);
    warm.close();

    const late = await connect(server);
    late.send({ t: "attach", session: agent.sessionId, policy: { updates: "full" }, sinceSeq: 0 });

    const gap = await late.until(() => late.frames.find((frame) => frame.t === "gap"), "gap");
    expect(gap.t === "gap" && gap.from).toBe(1);
    const state = await late.until(() => late.frames.find((frame) => frame.t === "state"), "state");
    // The fallback is complete: the snapshot has the whole transcript.
    expect(state.t === "state" && state.state.messages.length).toBeGreaterThan(0);
    late.close();
  });

  test("a malformed frame is refused without dropping the connection", async () => {
    const { agent, server } = start(new FakeProvider([]));
    const client = await connect(server);
    client.socket.send("{ not json");

    const refusal = await client.until(
      () => client.frames.find((frame) => frame.t === "reply" && frame.ok === false),
      "refusal",
    );
    expect(refusal.t === "reply" && refusal.ok === false && refusal.error.code).toBe("unsupported");

    client.send({ t: "attach", session: agent.sessionId, policy: { updates: "full" } });
    expect(
      (await client.until(() => client.frames.find((frame) => frame.t === "state"), "state")).t,
    ).toBe("state");
    client.close();
  });

  test("stopping the server says bye first", async () => {
    const { server } = start(new FakeProvider([]));
    const client = await connect(server);
    await client.until(() => client.frames.find((frame) => frame.t === "hello"), "hello");

    await server.stop();

    const bye = await client.until(() => client.frames.find((frame) => frame.t === "bye"), "bye");
    expect(bye).toEqual({ t: "bye", reason: "shutdown" });
  });

  test("a refused peer never reaches the handshake", async () => {
    let host: SessionHost | undefined;
    const agent = new Agent({
      provider: new FakeProvider([]),
      model: fakeModel,
      onPermission: (request: PermissionRequest) =>
        host ? host.onPermission(request) : Promise.resolve<"allow" | "deny">("deny"),
    });
    host = new SessionHost({ agent, workspace: { name: "app", root: "/home/x/app" } });
    const server = serve({
      host,
      hostName: "workstation",
      version: "0.0.4",
      admit: () => ({ ok: false, reason: "too many attempts" }),
    });
    running.push(server);

    const response = await fetch(`http://${server.hostname}:${server.port}/`);
    expect(response.status).toBe(429);
  });
});
