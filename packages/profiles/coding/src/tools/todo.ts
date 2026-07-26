import type { ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

// Session-scoped task list. It exists to keep the model honest about multi-step
// work — the list is echoed back so it stays in context.
export class TodoStore {
  private items: TodoItem[] = [];

  replace(items: TodoItem[]): void {
    this.items = items;
  }

  all(): TodoItem[] {
    return [...this.items];
  }
}

const MARKS: Record<TodoItem["status"], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

export function renderTodos(items: TodoItem[]): string {
  if (items.length === 0) return "(no tasks)";
  return items.map((item) => `${MARKS[item.status]} ${item.content}`).join("\n");
}

export function todoTool(store: TodoStore) {
  return tool({
    name: "todo",
    description:
      "Record and update the task list for multi-step work. Send the complete list every time; it replaces the previous one. Mark exactly one task in_progress while you work on it.",
    inputSchema: z.object({
      items: z
        .array(
          z.object({
            content: z.string().describe("What needs doing"),
            status: z.enum(["pending", "in_progress", "completed"]),
          }),
        )
        .describe("The complete task list"),
    }),
    execute: ({ items }): ToolResult => {
      const inProgress = items.filter((item) => item.status === "in_progress").length;
      store.replace(items);
      const rendered = renderTodos(items);
      const warning =
        inProgress > 1
          ? "\n\n[note: more than one task is in_progress — work on one at a time]"
          : "";
      return {
        content: [{ type: "text", text: `${rendered}${warning}` }],
        details: { items },
      };
    },
  });
}
