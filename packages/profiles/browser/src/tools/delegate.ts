import type { ToolPermissionDetails, ToolResult } from "@mu/core";
import { resolveInRoot } from "@mu/profile-coding";
import { tool } from "mu";
import { z } from "zod";

// What each access level lets the coding agent do, as its own permission mode.
const ACCESS = {
  read: { mode: "plan-readonly", means: "read files and run read-only inspection commands" },
  edit: { mode: "accept-edits", means: "read, write and edit files; no commands" },
  full: { mode: "yolo", means: "anything, including running commands (needed for PDFs)" },
} as const;
type Access = keyof typeof ACCESS;

const MAX_OUTPUT = 12_000;
const MAX_RUN_MS = 15 * 60_000;

export interface CodingRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CodingRunner = (
  argv: string[],
  options: { cwd: string; signal: AbortSignal; onLine?: (line: string) => void },
) => Promise<CodingRun>;

export const spawnCodingAgent: CodingRunner = async (argv, { cwd, signal, onLine }) => {
  const child = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal,
    killSignal: "SIGTERM",
  });
  const readLines = async () => {
    const decoder = new TextDecoder();
    let all = "";
    let pending = "";
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      all += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine?.(line);
    }
    if (pending) onLine?.(pending);
    return all;
  };
  const [stdout, stderr, exitCode] = await Promise.all([
    readLines(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

// One line of progress per tool call the coding agent makes.
function progressLine(line: string): string | undefined {
  if (!line.includes('"tool_execution_start"')) return undefined;
  try {
    const event = JSON.parse(line) as { toolName?: string; args?: unknown };
    if (!event.toolName) return undefined;
    return `${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 160)}`;
  } catch {
    return undefined;
  }
}

export interface DelegateDeps {
  // argv prefix that runs mu itself.
  command: string[];
  workspace: string;
  model: () => string | undefined;
  // Which site's page text the brief repeats, if any.
  pageText?: (text: string) => string | undefined;
  run?: CodingRunner;
}

interface ParsedRun {
  answer: string;
  denied: string[];
}

// Reads `mu -p --json` output: the last assistant message is the answer.
function parseEvents(stdout: string): ParsedRun {
  let answer = "";
  const denied: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: {
      type?: string;
      message?: { role?: string; content?: { type: string; text?: string }[] };
      request?: { permission?: string; description?: string };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = (event.message.content ?? [])
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join("")
        .trim();
      if (text) answer = text;
    }
    if (event.type === "permission_asked" && event.request) {
      denied.push(`${event.request.permission}: ${event.request.description ?? ""}`.trim());
    }
  }
  return { answer, denied };
}

// The coding agent works in the browser agent's folder or below it, never elsewhere.
function directoryFor(deps: DelegateDeps, directory: string | undefined): string {
  return directory ? resolveInRoot(deps.workspace, directory) : deps.workspace;
}

export function delegateTool(deps: DelegateDeps) {
  const run = deps.run ?? spawnCodingAgent;
  return tool({
    name: "delegate",
    description:
      "Hand heavier file work in your folder to mu's coding agent, which runs commands but has no browser: converting formats, spreadsheets, bulk edits. For plain reading and writing use read, write and edit yourself. It does not see this conversation or any page, so the brief must contain every fact, path and the exact output format you need. Returns its final answer. Use the lowest access that works.",
    inputSchema: z.object({
      task: z.string().min(1).describe("Complete brief: goal, absolute paths, output format"),
      access: z
        .enum(["read", "edit", "full"])
        .optional()
        .describe(
          `read: ${ACCESS.read.means}. edit: ${ACCESS.edit.means}. full: ${ACCESS.full.means}. Default read.`,
        ),
      directory: z.string().optional().describe(`Working directory (default ${deps.workspace})`),
    }),
    executionMode: "sequential",
    permissionScope: () => "browser:delegate",
    permissionPattern: (args) => args.access ?? "read",
    permissionDetails: (args): ToolPermissionDetails => {
      const access: Access = args.access ?? "read";
      const from = deps.pageText?.(args.task);
      return {
        description: `Run mu's coding agent (${access} access)`,
        preview: {
          kind: "text",
          lines: [
            `directory: ${args.directory ?? deps.workspace}`,
            `access: ${access} — ${ACCESS[access].means}`,
            "task:",
            ...args.task
              .split("\n")
              .slice(0, 16)
              .map((line) => `  ${line}`),
            ...(from
              ? [
                  `warning: the task repeats text from a page on ${from}; a page may be steering the agent (prompt injection)`,
                ]
              : []),
          ],
        },
      };
    },
    execute: async (args, { signal, update }): Promise<ToolResult> => {
      const access: Access = args.access ?? "read";
      let cwd: string;
      try {
        cwd = directoryFor(deps, args.directory);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `The coding agent can only work in ${deps.workspace} or a folder inside it.`,
            },
          ],
          isError: true,
        };
      }
      const model = deps.model();
      const argv = [
        ...deps.command,
        "-p",
        args.task,
        "--profile",
        "coding",
        "--json",
        "--permission-mode",
        ACCESS[access].mode,
        ...(model ? ["--model", model] : []),
      ];
      const started = performance.now();
      const limit = AbortSignal.any([signal, AbortSignal.timeout(MAX_RUN_MS)]);
      let result: CodingRun;
      try {
        result = await run(argv, {
          cwd,
          signal: limit,
          onLine: (line) => {
            const progress = progressLine(line);
            if (progress) update(`coding agent: ${progress}`);
          },
        });
      } catch (error) {
        signal.throwIfAborted();
        return {
          content: [
            {
              type: "text",
              text: `the coding agent could not start: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
      signal.throwIfAborted();
      const durationMs = Math.round(performance.now() - started);
      const { answer, denied } = parseEvents(result.stdout);
      const failed = result.exitCode !== 0 || !answer;
      const stderr = result.stderr.trim().split("\n").slice(-5).join("\n");
      let body = answer || "(no answer)";
      if (body.length > MAX_OUTPUT)
        body = `${body.slice(0, MAX_OUTPUT)}\n… (${body.length} chars; ask for a shorter answer or a file)`;
      const lines = [
        `coding agent ${failed ? `failed (exit ${result.exitCode})` : "finished"} in ${Math.round(durationMs / 1000)} s (${access} access, ${cwd})`,
        ...(denied.length > 0
          ? [
              `denied at ${access} access: ${denied.join("; ")} — retry with more access only if the task needs it`,
            ]
          : []),
        ...(failed && stderr ? [`stderr: ${stderr}`] : []),
        "",
        // Files the coding agent read can carry instructions too.
        '<local_data source="coding agent" untrusted="true">',
        body,
        "</local_data>",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { exitCode: result.exitCode, access, cwd, durationMs, denied },
        ...(failed ? { isError: true } : {}),
      };
    },
  });
}
