import { describe, expect, test } from "bun:test";
import { CommandRegistry, SessionTree } from "mu";
import { transcriptExportCommand } from "./export-command.ts";

function session(withMessage: boolean): SessionTree {
  const tree = new SessionTree({
    type: "session",
    version: 1,
    id: "session-1",
    createdAt: "2026-08-03T00:00:00.000Z",
    profile: "coding",
    environment: {},
  });
  if (withMessage) {
    tree.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Export me" }],
      timestamp: 1,
    });
  }
  return tree;
}

function context() {
  return {
    inject: () => {},
    print: () => {},
    getModel: () => "openai/gpt-test",
    setModel: () => {},
  };
}

describe("/export", () => {
  test("saves the session Markdown through the registered slash command", async () => {
    const saved: { markdown: string; requestedPath: string; now: Date }[] = [];
    const registry = new CommandRegistry();
    registry.register(
      transcriptExportCommand({
        getSession: () => session(true),
        getSessionId: () => "session-1",
        getModel: () => "openai/gpt-test",
        isRunning: () => false,
        save: async (markdown, requestedPath, now) => {
          saved.push({ markdown, requestedPath, now });
          return "notes/chat.md";
        },
        now: () => new Date(0),
      }),
    );

    const result = await registry.execute("/export notes/chat.md", context());
    expect(result.message).toBe("Exported 1 transcript entry to notes/chat.md.");
    expect(saved[0]?.requestedPath).toBe("notes/chat.md");
    expect(saved[0]?.now).toEqual(new Date(0));
    expect(saved[0]?.markdown).toContain("## User");
    expect(saved[0]?.markdown).toContain("Export me");
  });

  test("does not save an empty or actively changing transcript", async () => {
    let saves = 0;
    const registry = new CommandRegistry();
    const register = (withMessage: boolean, running: boolean) => {
      registry.register(
        transcriptExportCommand({
          getSession: () => session(withMessage),
          getSessionId: () => "session-1",
          getModel: () => "openai/gpt-test",
          isRunning: () => running,
          save: async () => {
            saves += 1;
            return "chat.md";
          },
        }),
      );
    };

    register(false, false);
    expect((await registry.execute("/export", context())).message).toBe("Nothing to export yet.");
    register(true, true);
    expect((await registry.execute("/export", context())).message).toBe(
      "Cannot export during a run.",
    );
    expect(saves).toBe(0);
  });
});
