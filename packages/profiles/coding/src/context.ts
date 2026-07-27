import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type AgentMessage, customMessage } from "@mu/core";

export const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md", ".mu/AGENTS.md"];

// Walks up from the session root collecting project context files. Nearest
// file wins on conflicts, so the deepest one is listed last.
export async function discoverContextFiles(root: string, stopAt?: string): Promise<string[]> {
  const found: string[] = [];
  const ceiling = stopAt ? resolve(stopAt) : undefined;
  let current = resolve(root);

  for (;;) {
    for (const name of CONTEXT_FILE_NAMES) {
      const candidate = join(current, name);
      try {
        const info = await stat(candidate);
        if (info.isFile()) found.push(candidate);
      } catch {
        // absent — keep walking
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    if (ceiling && current === ceiling) break;
    current = parent;
  }

  return found.reverse(); // outermost first, nearest last
}

export async function contextMessages(root: string): Promise<AgentMessage[]> {
  const files = await discoverContextFiles(root);
  const messages: AgentMessage[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      if (content.trim().length === 0) continue;
      messages.push(
        customMessage("project-context", `Project instructions from ${file}:\n\n${content.trim()}`),
      );
    } catch {
      // unreadable — skip
    }
  }
  return messages;
}

async function gitOutput(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

// The opaque environment map handed to the kernel. Every key here is a coding
// concern — the kernel never interprets it.
export async function codingEnvironment(root: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    directory: resolve(root),
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
  };

  const branchOutput = await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const branch = branchOutput?.trim().split(/\r?\n/)[0];
  if (branch) {
    env.branch = branch;
    const status = await gitOutput(["status", "--porcelain"], root);
    if (status !== undefined) {
      env.uncommittedFiles = String(status.split(/\r?\n/).filter(Boolean).length);
    }
  }

  try {
    const entries = await readdir(root);
    env.topLevelEntries = entries
      .filter((name) => !name.startsWith("."))
      .sort()
      .slice(0, 40)
      .join(", ");
  } catch {
    // unreadable root — leave it out
  }

  return env;
}

// Rendered as a typed message so the system prompt stays byte-stable and
// cacheable across turns and sessions.
export function environmentMessage(env: Record<string, string>): AgentMessage {
  const lines = Object.entries(env).map(([key, value]) => `${key}: ${value}`);
  return customMessage("environment", `Session environment:\n${lines.join("\n")}`);
}
