import { describe, expect, test } from "bun:test";
import type { AnyTool, ToolResult } from "@mu/core";
import { renderTodos, TodoStore, todoTool } from "./todo.ts";

const signal = new AbortController().signal;

async function run(tool: unknown, args: Record<string, unknown>): Promise<string> {
  const result: ToolResult = await (tool as AnyTool).execute("t1", args, signal);
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

describe("todo", () => {
  test("renders the list and stores it", async () => {
    const store = new TodoStore();
    const text = await run(todoTool(store), {
      items: [
        { content: "write tests", status: "completed" },
        { content: "ship it", status: "in_progress" },
        { content: "celebrate", status: "pending" },
      ],
    });
    expect(text).toContain("[x] write tests");
    expect(text).toContain("[~] ship it");
    expect(text).toContain("[ ] celebrate");
    expect(store.all().length).toBe(3);
  });

  test("warns when more than one task is in progress", async () => {
    const text = await run(todoTool(new TodoStore()), {
      items: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    });
    expect(text).toContain("one at a time");
  });

  test("renders an empty list", () => {
    expect(renderTodos([])).toBe("(no tasks)");
  });
});
