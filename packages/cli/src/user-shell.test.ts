import { describe, expect, test } from "bun:test";
import type { AgentEvent, AnyTool } from "@mu/core";
import { formatUserShellRecord, runUserShellCommand } from "./user-shell.ts";

const signal = new AbortController().signal;

describe("user shell", () => {
  test("runs directly and emits the ordinary streaming tool lifecycle", async () => {
    const events: AgentEvent[] = [];
    const tool = {
      name: "bash",
      description: "",
      inputSchema: {},
      execute: async (
        _toolCallId: string,
        args: { command: string },
        _signal: AbortSignal,
        onUpdate?: (partial: { type: "text"; text: string }[]) => void,
      ) => {
        expect(args.command).toBe("printf ok");
        onUpdate?.([{ type: "text", text: "ok" }]);
        return {
          content: [{ type: "text" as const, text: "ok" }],
          details: { exitCode: 0, durationMs: 25 },
        };
      },
    } as AnyTool;

    const result = await runUserShellCommand(
      tool,
      "printf ok",
      signal,
      (event) => {
        events.push(event);
      },
      { toolCallId: "shell-1" },
    );

    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
    expect(events[0]).toEqual({
      type: "tool_execution_start",
      toolCallId: "shell-1",
      toolName: "bash",
      args: { command: "printf ok", userShell: true },
    });
    expect(result.isError).toBe(false);
  });

  test("records the command result in model-readable session context", () => {
    const record = formatUserShellRecord("false", {
      role: "toolResult",
      toolCallId: "shell-1",
      toolName: "bash",
      content: [{ type: "text", text: "failure output" }],
      details: { exitCode: 1, durationMs: 120 },
      isError: true,
      timestamp: 1,
    });

    expect(record).toContain("<command>\nfalse\n</command>");
    expect(record).toContain("Exit code: 1");
    expect(record).toContain("Duration: 0.1200s");
    expect(record).toContain("failure output");
  });

  test("turns a thrown shell error into a completed error event", async () => {
    const events: AgentEvent[] = [];
    const tool = {
      name: "bash",
      description: "",
      inputSchema: {},
      execute: async () => {
        throw new Error("shell unavailable");
      },
    } as unknown as AnyTool;

    const result = await runUserShellCommand(
      tool,
      "echo hi",
      signal,
      (event) => events.push(event),
      { toolCallId: "shell-2" },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "shell unavailable" });
    expect(events.at(-1)?.type).toBe("tool_execution_end");
  });
});
