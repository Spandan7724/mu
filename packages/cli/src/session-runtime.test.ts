import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { FileSessionStore, MemorySessionStore } from "mu";
import { createCliSessionRuntime, SESSION_RULES } from "./session-runtime.ts";

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

  test("approvals keep configured denies last and session rules can be forgotten", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-session-runtime-"));
    const home = await mkdtemp(join(tmpdir(), "mu-session-home-"));
    roots.push(root, home);
    await mkdir(join(root, ".mu"), { recursive: true });
    await writeFile(
      join(root, ".mu", "config.json"),
      JSON.stringify({
        permissions: [{ permission: "bash", pattern: "git push *", action: "deny" }],
      }),
    );
    const call = (id: string, command: string) => ({
      content: [{ type: "toolCall" as const, id, name: "bash", arguments: { command } }],
    });
    const ran: string[] = [];
    const runtime = await createCliSessionRuntime({
      cwd: root,
      model: "anthropic/claude-haiku-4-5",
      permissions: "forward",
      permissionMode: "default",
      profileOptions: {
        root,
        home,
        checkpoints: false,
        spawn: async (command: string) => {
          ran.push(command);
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        },
      },
      agentOptions: {
        provider: new FakeProvider([
          call("c1", "npm test --silent"),
          call("c2", "npm test -- unit"),
          { content: [{ type: "text", text: "done" }] },
        ]),
        getCredentials: async () => ({ type: "apiKey", apiKey: "test" }),
        session: new MemorySessionStore(),
      },
    });
    try {
      const asked: string[] = [];
      runtime.agent.subscribe((event) => {
        if (event.type !== "permission_asked") return;
        asked.push(event.request.pattern);
        setTimeout(() => runtime.resolvePermission(event.request.id, "allow", "session"));
      });
      await runtime.agent.run("test it");
      expect(asked).toEqual(["npm test --silent"]);
      expect(ran).toEqual(["npm test --silent", "npm test -- unit"]);

      expect(runtime.setPermissionMode("yolo")).toBe("full access");
      expect(evaluate(runtime.agent.permissions, "bash", "git push origin main")).toBe("deny");
      expect(evaluate(runtime.agent.permissions, "bash", "rm -rf build")).toBe("allow");

      runtime.setPermissionMode("default");
      const session = (await runtime.permissionRules()).filter(
        (rule) => rule.source === SESSION_RULES,
      );
      expect(session).toEqual([
        { permission: "bash", pattern: "npm test *", action: "allow", source: SESSION_RULES },
      ]);
      expect(evaluate(runtime.agent.permissions, "bash", "npm test")).toBe("allow");
      const [rule] = session;
      if (!rule) throw new Error("missing session rule");
      await runtime.forgetPermissionRule(rule);
      expect(evaluate(runtime.agent.permissions, "bash", "npm test")).toBe("ask");
      expect(await runtime.permissionRules()).toEqual([
        {
          permission: "bash",
          pattern: "git push *",
          action: "deny",
          source: join(root, ".mu", "config.json"),
        },
      ]);
    } finally {
      await runtime.agent.shutdown();
    }
  });
});
