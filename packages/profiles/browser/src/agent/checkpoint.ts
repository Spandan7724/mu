import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_CHECKPOINT = 40_000;

export function checkpointDir(home: string): string {
  return join(home, ".mu", "browser", "checkpoints");
}

const text = (body: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: body }],
  ...(isError ? { isError: true } : {}),
});

// Progress of long work over many items, kept on disk so a later session can
// continue where this one stopped instead of redoing finished items.
export function checkpointTool(home: string) {
  const dir = checkpointDir(home);
  const pathFor = (name: string) => join(dir, `${name}.md`);
  return tool({
    name: "checkpoint",
    description:
      "Durable progress file for long work over many items (applying to several jobs, working through a list), kept across sessions. save overwrites the whole checkpoint: what is done (with outcome), what is next, and reusable facts. load reads one back; list shows saved checkpoints. Save after every finished item.",
    inputSchema: z.object({
      action: z.enum(["save", "load", "list"]),
      name: z.string().regex(NAME).optional().describe('Checkpoint name, e.g. "job-applications"'),
      text: z.string().max(MAX_CHECKPOINT).optional().describe("Full checkpoint (save)"),
    }),
    execute: ({ action, name, text: body }): ToolResult => {
      if (action === "list") {
        let files: string[] = [];
        try {
          files = readdirSync(dir).filter((file) => file.endsWith(".md"));
        } catch {}
        if (files.length === 0) return text("no checkpoints saved");
        const rows = files
          .map((file) => ({ file, at: statSync(join(dir, file)).mtime }))
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .map(({ file, at }) => {
            const first = readFileSync(join(dir, file), "utf8").split("\n")[0]?.slice(0, 100);
            return `- ${file.slice(0, -3)} (saved ${at.toISOString().slice(0, 16).replace("T", " ")}): ${first}`;
          });
        return text(`checkpoints:\n${rows.join("\n")}`);
      }
      if (!name) return text(`checkpoint ${action} needs a name`, true);
      if (action === "load") {
        try {
          // Saved progress may quote pages: a record to continue from, not instructions.
          return text(
            `checkpoint "${name}":\n<saved_checkpoint untrusted="true">\n${readFileSync(pathFor(name), "utf8")}\n</saved_checkpoint>`,
          );
        } catch {
          return text(`no checkpoint named "${name}"; use list`, true);
        }
      }
      if (body === undefined) return text("checkpoint save needs text", true);
      mkdirSync(dir, { recursive: true });
      const temp = `${pathFor(name)}.tmp`;
      writeFileSync(temp, body);
      renameSync(temp, pathFor(name));
      const summary = `saved checkpoint "${name}" (${body.length} chars)`;
      return {
        content: [{ type: "text", text: summary }],
        retention: { key: `browser:checkpoint:${name}`, summary },
      };
    },
  });
}
