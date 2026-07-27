// Markdown custom commands: ~/.mu/commands/*.md and project .mu/commands/*.md.
// The non-programmer authoring tier — a file with YAML frontmatter becomes a
// slash command.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Command } from "@mu/core";

export interface MarkdownCommand {
  name: string;
  description: string;
  body: string;
  model?: string;
  allowedTools?: string[];
}

export interface MarkdownCommandRun {
  kind: "markdown-command";
  prompt: string;
  model?: string;
  allowedTools?: string[];
}

// Minimal YAML: `key: value` and `key: [a, b]`. A real YAML parser would be a
// new dependency for a format we deliberately keep this small.
export function parseFrontmatter(source: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { meta: {}, body: normalized.trim() };

  const meta: Record<string, string | string[]> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (key.length === 0) continue;
    meta[key] =
      raw.startsWith("[") && raw.endsWith("]")
        ? raw
            .slice(1, -1)
            .split(",")
            .map((item) => item.trim().replace(/^["']|["']$/g, ""))
            .filter((item) => item.length > 0)
        : raw.replace(/^["']|["']$/g, "");
  }
  return { meta, body: normalized.slice(match[0].length).trim() };
}

// $ARGUMENTS is everything after the command; $1..$9 are whitespace-separated
// positionals. Unreferenced arguments are appended so nothing is silently lost.
export function substituteArguments(body: string, args: string): string {
  const positionals = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  let used = false;

  let out = body.replace(/\$ARGUMENTS\b/g, () => {
    used = true;
    return args.trim();
  });
  out = out.replace(/\$([1-9])\b/g, (_match, index: string) => {
    used = true;
    return positionals[Number(index) - 1] ?? "";
  });

  if (!used && args.trim().length > 0) return `${out}\n\n${args.trim()}`;
  return out;
}

export function parseMarkdownCommand(name: string, source: string): MarkdownCommand {
  const { meta, body } = parseFrontmatter(source);
  const description =
    typeof meta.description === "string" ? meta.description : `Run the ${name} command`;
  const model = typeof meta.model === "string" ? meta.model : undefined;
  const allowed = meta["allowed-tools"];
  const allowedTools = Array.isArray(allowed)
    ? allowed
    : typeof allowed === "string" && allowed.length > 0
      ? allowed.split(",").map((t) => t.trim())
      : undefined;

  return {
    name,
    description,
    body,
    ...(model ? { model } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  };
}

async function loadFrom(dir: string): Promise<MarkdownCommand[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const commands: MarkdownCommand[] = [];
  for (const file of names.filter((n) => n.endsWith(".md")).sort()) {
    try {
      const source = await readFile(join(dir, file), "utf8");
      commands.push(parseMarkdownCommand(basename(file, ".md"), source));
    } catch {
      // An unreadable command file is skipped, not fatal.
    }
  }
  return commands;
}

export interface MarkdownCommandOptions {
  userDir?: string;
  projectDir?: string;
}

// Project commands override user commands of the same name.
export async function loadMarkdownCommands(
  options: MarkdownCommandOptions = {},
): Promise<MarkdownCommand[]> {
  const user = await loadFrom(options.userDir ?? join(homedir(), ".mu", "commands"));
  const project = options.projectDir
    ? await loadFrom(join(options.projectDir, ".mu", "commands"))
    : [];

  const byName = new Map<string, MarkdownCommand>();
  for (const command of [...user, ...project]) byName.set(command.name, command);
  return [...byName.values()];
}

// Turns a markdown command into a registry Command that submits its expanded
// body as a prompt.
export function toCommand(
  markdown: MarkdownCommand,
  submit?: (
    prompt: string,
    options: { model?: string; allowedTools?: string[] },
  ) => unknown | Promise<unknown>,
): Command {
  return {
    name: markdown.name,
    description: markdown.description,
    run: async (ctx) => {
      const request: MarkdownCommandRun = {
        kind: "markdown-command",
        prompt: substituteArguments(markdown.body, ctx.args),
        ...(markdown.model ? { model: markdown.model } : {}),
        ...(markdown.allowedTools ? { allowedTools: markdown.allowedTools } : {}),
      };
      if (submit) {
        await submit(request.prompt, {
          ...(request.model ? { model: request.model } : {}),
          ...(request.allowedTools ? { allowedTools: request.allowedTools } : {}),
        });
        return { handled: true };
      }
      return { handled: true, data: request };
    },
  };
}
