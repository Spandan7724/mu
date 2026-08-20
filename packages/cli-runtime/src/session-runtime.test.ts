import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { FileSessionStore } from "mu";
import { createCliSessionRuntime } from "./session-runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared CLI session runtime", () => {
  test("a managed session is an ordinary Agent persisted through the normal JSONL store", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-session-runtime-"));
    roots.push(root);
    const store = new FileSessionStore({ root });
    const provider = new FakeProvider([{ content: [{ type: "text", text: "finished" }] }]);
    const runtime = await createCliSessionRuntime({
      cwd: root,
      sessionId: "managed-session",
      permissions: "deny",
      agentOptions: { provider, model: fakeModel, tools: [], session: store },
    });
    try {
      const result = await runtime.agent.run("ordinary prompt");
      expect(result.sessionId).toBe("managed-session");
      const saved = await store.load("managed-session");
      expect(saved?.header?.id).toBe("managed-session");
      expect(saved?.messagesAt().map((message) => message.role)).toEqual(["user", "assistant"]);
    } finally {
      await runtime.agent.shutdown();
    }
  });
});
