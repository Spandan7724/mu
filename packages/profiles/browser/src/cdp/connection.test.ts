import { describe, expect, test } from "bun:test";
import { CdpConnection, CdpError, type CdpTransport, classifyProtocolError } from "./connection.ts";
import { CdpSession } from "./session.ts";

class FakeSocket implements CdpTransport {
  sent: { id: number; method: string; params: unknown; sessionId?: string }[] = [];
  closed = false;
  private messageHandler: (data: string) => void = () => {};
  private closeHandler: (reason: string) => void = () => {};

  send(message: string): void {
    this.sent.push(JSON.parse(message));
  }
  close(): void {
    this.closed = true;
  }
  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }
  deliver(message: unknown): void {
    this.messageHandler(JSON.stringify(message));
  }
  drop(reason: string): void {
    this.closeHandler(reason);
  }
  last() {
    const message = this.sent.at(-1);
    if (!message) throw new Error("nothing sent");
    return message;
  }
}

function setup() {
  const socket = new FakeSocket();
  return { socket, connection: new CdpConnection(socket) };
}

describe("CdpConnection", () => {
  test("routes responses to their requests by id, out of order", async () => {
    const { socket, connection } = setup();
    const version = connection.send("Browser.getVersion");
    const targets = connection.send("Target.getTargets");
    const [first, second] = socket.sent;
    expect(first).toMatchObject({ method: "Browser.getVersion", params: {} });
    socket.deliver({ id: second?.id, result: { targetInfos: [] } });
    socket.deliver({ id: first?.id, result: { product: "Chrome/154" } });
    expect(await targets).toEqual({ targetInfos: [] });
    expect((await version).product).toBe("Chrome/154");
  });

  test("tags session commands and filters session events", async () => {
    const { socket, connection } = setup();
    const session = new CdpSession(connection, "S1", "T1");
    const reply = session.send("Runtime.evaluate", { expression: "1+1" });
    expect(socket.last()).toMatchObject({ method: "Runtime.evaluate", sessionId: "S1" });
    socket.deliver({
      id: socket.last().id,
      sessionId: "S1",
      result: { result: { type: "number" } },
    });
    expect((await reply).result.type).toBe("number");

    const seen: string[] = [];
    session.on("Page.loadEventFired", () => seen.push("S1"));
    const offAll = connection.on("Page.loadEventFired", (_params, sessionId) =>
      seen.push(`any:${sessionId}`),
    );
    socket.deliver({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S2" });
    socket.deliver({ method: "Page.loadEventFired", params: { timestamp: 2 }, sessionId: "S1" });
    offAll();
    socket.deliver({ method: "Page.loadEventFired", params: { timestamp: 3 }, sessionId: "S1" });
    expect(seen).toEqual(["any:S2", "S1", "any:S1", "S1"]);
  });

  test("maps protocol errors to typed kinds", async () => {
    const { socket, connection } = setup();
    const pending = connection.send("DOM.describeNode", { backendNodeId: 7 });
    socket.deliver({
      id: socket.last().id,
      error: { code: -32000, message: "No node with given id found" },
    });
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CdpError);
    expect(error).toMatchObject({ kind: "stale-node", method: "DOM.describeNode", code: -32000 });
    expect(classifyProtocolError("Cannot find context with specified id")).toBe("context-gone");
    expect(classifyProtocolError("Session with given id not found.")).toBe("target-closed");
    expect(classifyProtocolError("Invalid parameters")).toBe("protocol");
  });

  test("times out a call that never answers", async () => {
    const { connection } = setup();
    const error = await connection
      .send("Browser.getVersion", undefined, { timeoutMs: 5 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "timeout" });
  });

  test("an abort rejects the in-flight call immediately and a late reply is ignored", async () => {
    const { socket, connection } = setup();
    const controller = new AbortController();
    const pending = connection.send("Browser.getVersion", undefined, { signal: controller.signal });
    const id = socket.last().id;
    controller.abort();
    expect(await pending.catch((caught: unknown) => caught)).toMatchObject({ kind: "aborted" });
    socket.deliver({ id, result: {} });
    const already = await connection
      .send("Browser.getVersion", undefined, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(already).toMatchObject({ kind: "aborted" });
  });

  test("detaching a session rejects its pending calls and drops its listeners", async () => {
    const { socket, connection } = setup();
    const session = new CdpSession(connection, "S1", "T1");
    const other = connection.send("Browser.getVersion");
    const pending = session.send("Page.navigate", { url: "about:blank" });
    let events = 0;
    session.on("Page.loadEventFired", () => events++);
    socket.deliver({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } });
    expect(await pending.catch((caught: unknown) => caught)).toMatchObject({
      kind: "target-closed",
    });
    expect(session.detached).toBe(true);
    socket.deliver({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" });
    expect(events).toBe(0);
    socket.deliver({ id: socket.sent[0]?.id, result: { product: "x" } });
    expect((await other).product).toBe("x");
  });

  test("socket close rejects everything pending and resolves closed", async () => {
    const { socket, connection } = setup();
    const pending = connection.send("Browser.getVersion");
    const waiting = connection.waitFor("Target.targetCreated", { timeoutMs: 1000 });
    socket.drop("browser exited");
    expect(await pending.catch((caught: unknown) => caught)).toMatchObject({
      kind: "target-closed",
    });
    expect(await waiting.catch((caught: unknown) => caught)).toMatchObject({
      kind: "target-closed",
    });
    expect(await connection.closed).toEqual({ reason: "browser exited" });
    expect(
      await connection.send("Browser.getVersion").catch((caught: unknown) => caught),
    ).toMatchObject({ kind: "target-closed" });
  });

  test("waitFor matches a predicate and cleans up its listener", async () => {
    const { socket, connection } = setup();
    const waiting = connection.waitFor("Page.lifecycleEvent", {
      sessionId: "S1",
      predicate: (params) => params.name === "load",
    });
    socket.deliver({
      method: "Page.lifecycleEvent",
      params: { name: "DOMContentLoaded" },
      sessionId: "S1",
    });
    socket.deliver({ method: "Page.lifecycleEvent", params: { name: "load" }, sessionId: "S2" });
    socket.deliver({ method: "Page.lifecycleEvent", params: { name: "load" }, sessionId: "S1" });
    expect((await waiting).name).toBe("load");
  });

  test("close is idempotent and closes the transport", async () => {
    const { socket, connection } = setup();
    await connection.close();
    await connection.close();
    expect(socket.closed).toBe(true);
    expect(connection.isClosed).toBe(true);
  });
});
