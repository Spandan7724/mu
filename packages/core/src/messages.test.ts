import { describe, expect, test } from "bun:test";
import {
  customMessage,
  isCustomMessage,
  renderCustomMessage,
  toAiMessages,
  userMessage,
} from "./messages.ts";
import { evaluate, type PermissionRule } from "./permission.ts";

describe("messages", () => {
  test("custom messages render as tagged user content, never system prompt edits", () => {
    const message = customMessage("system-reminder", "be careful");
    const rendered = renderCustomMessage(message);
    expect(rendered.role).toBe("user");
    expect(rendered.content[0]?.type === "text" && rendered.content[0].text).toBe(
      "<system-reminder>\nbe careful\n</system-reminder>",
    );
  });

  test("toAiMessages converts custom entries and leaves the rest alone", () => {
    const user = userMessage("hello");
    const converted = toAiMessages([user, customMessage("task-notification", "build done")]);
    expect(converted[0]).toBe(user);
    expect(converted[1]?.role).toBe("user");
    expect(converted.every((m) => m.role !== ("custom" as never))).toBe(true);
  });

  test("images pass through custom message rendering unchanged", () => {
    const message = {
      role: "custom" as const,
      customType: "attachment",
      content: [{ type: "image" as const, mimeType: "image/png", data: "aWJvcg==" }],
      timestamp: 1,
    };
    expect(renderCustomMessage(message).content[0]).toEqual(message.content[0]);
  });

  test("isCustomMessage narrows correctly", () => {
    expect(isCustomMessage(customMessage("x", "y"))).toBe(true);
    expect(isCustomMessage(userMessage("y"))).toBe(false);
  });
});

describe("permission engine", () => {
  const rules: PermissionRule[] = [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm *", action: "deny" },
    { permission: "bash", pattern: "publish *", action: "ask" },
  ];

  test("last matching rule wins", () => {
    expect(evaluate(rules, "bash", "rm -rf /")).toBe("deny");
    expect(evaluate(rules, "bash", "publish to remote")).toBe("ask");
    expect(evaluate(rules, "bash", "ls")).toBe("allow");
  });

  test("defaults to ask when nothing matches", () => {
    expect(evaluate([], "bash", "ls")).toBe("ask");
    expect(evaluate([{ permission: "read", pattern: "*", action: "allow" }], "bash", "ls")).toBe(
      "ask",
    );
  });

  test("wildcards match permission categories", () => {
    const mcp: PermissionRule[] = [{ permission: "mcp_*", pattern: "*", action: "deny" }];
    expect(evaluate(mcp, "mcp_github", "anything")).toBe("deny");
    expect(evaluate(mcp, "bash", "anything")).toBe("ask");
  });

  test("derived scopes and concrete tool names are both rule targets", () => {
    const scoped: PermissionRule[] = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "bash:inspect", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "special status", action: "deny" },
    ];
    expect(evaluate(scoped, ["bash", "bash:inspect"], "rg --files")).toBe("allow");
    expect(evaluate(scoped, ["bash", "bash:inspect"], "special status")).toBe("deny");
  });

  test("patterns are anchored, not substring matches", () => {
    const anchored: PermissionRule[] = [{ permission: "bash", pattern: "ls", action: "allow" }];
    expect(evaluate(anchored, "bash", "ls")).toBe("allow");
    expect(evaluate(anchored, "bash", "ls -la")).toBe("ask");
  });

  test("regex metacharacters in patterns are literal", () => {
    const dotted: PermissionRule[] = [{ permission: "read", pattern: "a.txt", action: "allow" }];
    expect(evaluate(dotted, "read", "a.txt")).toBe("allow");
    expect(evaluate(dotted, "read", "axtxt")).toBe("ask");
  });

  test("wildcards span newlines in multi-line commands", () => {
    const multi: PermissionRule[] = [{ permission: "bash", pattern: "rm *", action: "deny" }];
    expect(evaluate(multi, "bash", "rm -rf x\ny")).toBe("deny");
  });
});
