import { describe, expect, test } from "bun:test";
import { customMessage, SessionTree } from "@mu/core";
import { sessionToMarkdown } from "./transcript-markdown.ts";

function session(): SessionTree {
  return new SessionTree({
    type: "session",
    version: 1,
    id: "session-1",
    createdAt: "2026-08-03T00:00:00.000Z",
    profile: "coding",
    environment: {},
  });
}

describe("Markdown transcript export", () => {
  test("exports the complete active branch, including history hidden by compaction", () => {
    const tree = session();
    const first = tree.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "Fix **this**." },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
      timestamp: Date.parse("2026-08-03T01:00:00.000Z"),
    });
    tree.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Check the file." },
        { type: "text", text: "I will inspect it." },
        { type: "toolCall", id: "call-1", name: "read<script>", arguments: { path: "a.ts" } },
      ],
      model: "openai/gpt-test",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      stopReason: "toolUse",
      timestamp: Date.parse("2026-08-03T01:01:00.000Z"),
    });
    tree.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "source with ``` inside" }],
      details: { path: "a.ts", lines: 1 },
      isError: false,
      timestamp: Date.parse("2026-08-03T01:02:00.000Z"),
    });
    tree.appendMessage(customMessage("project_instructions", "private context"));
    tree.appendMessage(customMessage("visible_notice", "Shown to the user", true));
    tree.appendMessage(customMessage("user_shell_command", "<command>git status</command>"));
    tree.append({
      type: "compaction",
      summary: "Earlier work happened.",
      firstKeptEntryId: first.id,
    });

    const result = sessionToMarkdown(tree, {
      sessionId: "session-1",
      model: "openai/gpt-test",
      exportedAt: new Date("2026-08-03T02:00:00.000Z"),
    });

    expect(result.messageCount).toBe(5);
    expect(result.markdown).toContain("# Mu chat transcript");
    expect(result.markdown).toContain("Fix **this**.");
    expect(result.markdown).toContain("[Image omitted from text export: image/png]");
    expect(result.markdown).toContain("<summary>Thinking</summary>");
    expect(result.markdown).toContain("read&lt;script&gt;");
    expect(result.markdown).toContain("````text\nsource with ``` inside\n````");
    expect(result.markdown).toContain('"path": "a.ts"');
    expect(result.markdown).toContain("Shown to the user");
    expect(result.markdown).toContain("## User shell");
    expect(result.markdown).not.toContain("private context");
    expect(result.markdown).not.toContain("Earlier work happened.");
  });

  test("excludes messages on an abandoned branch", () => {
    const tree = session();
    const root = tree.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Keep me" }],
      timestamp: 1,
    });
    tree.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Abandoned" }],
      timestamp: 2,
    });
    tree.fork(root.id);
    tree.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Current branch" }],
      timestamp: 3,
    });

    const result = sessionToMarkdown(tree, { exportedAt: new Date(0) });
    expect(result.messageCount).toBe(2);
    expect(result.markdown).toContain("Keep me");
    expect(result.markdown).toContain("Current branch");
    expect(result.markdown).not.toContain("Abandoned");
  });
});
