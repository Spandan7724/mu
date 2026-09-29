import type { ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { type BrowserState, DEFAULT_NOTE_KEY, formatNotes } from "./state.ts";

const MAX_NOTE_OUTPUT = 8_000;

export function notesTool(state: BrowserState) {
  return tool({
    name: "notes",
    description:
      "Your scratchpad for data you collect (names, prices, IDs, links, partial results). Notes survive when older page states are collapsed and when the conversation is compacted. append adds a line to a note, replace overwrites it, read shows notes, clear deletes one (with key) or all.",
    inputSchema: z.object({
      action: z.enum(["append", "replace", "read", "clear"]),
      key: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe(`Note name (default "${DEFAULT_NOTE_KEY}")`),
      text: z.string().optional(),
    }),
    execute: ({ action, key, text }): ToolResult => {
      const name = key ?? DEFAULT_NOTE_KEY;
      const { notes } = state;
      if ((action === "append" || action === "replace") && text === undefined) {
        return { content: [{ type: "text", text: `notes ${action} needs text` }], isError: true };
      }
      if (action === "append") notes.append(name, text as string);
      else if (action === "replace") notes.replace(name, text as string);
      else if (action === "clear") notes.clear(key);
      const shown =
        action === "read" && key
          ? notes.entries().filter((entry) => entry.key === key)
          : notes.entries();
      let body = formatNotes(shown);
      if (body.length > MAX_NOTE_OUTPUT)
        body = `${body.slice(0, MAX_NOTE_OUTPUT)}\n… (${body.length} chars; read one key at a time)`;
      const verb = { append: "appended to", replace: "replaced", read: "read", clear: "cleared" }[
        action
      ];
      const summary = `${verb} ${action === "clear" && !key ? "all notes" : `note "${name}"`} (${notes.entries().length} note${notes.entries().length === 1 ? "" : "s"})`;
      return {
        content: [{ type: "text", text: `${summary}\n\n${body}` }],
        details: { notes: notes.entries() },
        retention: { key: "browser:notes", summary },
      };
    },
  });
}
