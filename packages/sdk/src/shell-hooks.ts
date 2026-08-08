import { type Extension, type ExtensionAPI, OutputBuffer } from "@mu/core";

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "SessionStart" | "Stop";

export interface HookSpec {
  event: HookEvent;
  command: string;
  // Only run for tool names matching this glob (PreToolUse/PostToolUse).
  matcher?: string;
  timeoutMs?: number;
}

export type HookRunner = (
  command: string,
  input: string,
  timeoutMs: number,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const DEFAULT_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;

async function boundedStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const output = new OutputBuffer();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output.append(decoder.decode(value, { stream: true }));
  }
  output.append(decoder.decode());
  return output.read();
}

function killHookTree(proc: Bun.Subprocess, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      Bun.spawn(["taskkill.exe", "/PID", String(proc.pid), "/T", "/F"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      });
    } catch {
      proc.kill(signal);
    }
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal);
  }
}

async function defaultRunner(
  command: string,
  input: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    killHookTree(proc, "SIGTERM");
    escalation = setTimeout(() => killHookTree(proc, "SIGKILL"), TERMINATION_GRACE_MS);
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedStream(proc.stdout),
      boundedStream(proc.stderr),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
  }
}

function matches(pattern: string | undefined, value: string): boolean {
  if (!pattern || pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function parseJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function shellHooksExtension(
  hooks: HookSpec[],
  runner: HookRunner = defaultRunner,
): Extension {
  const forEvent = (event: HookEvent) => hooks.filter((hook) => hook.event === event);

  return {
    name: "shell-hooks",
    activate(api: ExtensionAPI) {
      const preToolUse = forEvent("PreToolUse");
      if (preToolUse.length > 0) {
        api.onToolCall(async (info) => {
          for (const hook of preToolUse) {
            if (!matches(hook.matcher, info.toolName)) continue;
            const payload = JSON.stringify({
              event: "PreToolUse",
              tool_name: info.toolName,
              tool_call_id: info.toolCallId,
              tool_input: info.args,
            });
            const result = await runner(
              hook.command,
              payload,
              hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            );
            const json = parseJson(result.stdout);

            if (result.exitCode === 2) {
              const reason =
                (typeof json?.reason === "string" ? json.reason : undefined) ??
                result.stderr.trim() ??
                `Blocked by ${hook.command}`;
              return { block: true, reason };
            }
            if (result.exitCode === 0 && json?.tool_input && typeof json.tool_input === "object") {
              return { args: json.tool_input as Record<string, unknown> };
            }
          }
          return undefined;
        });
      }

      const postToolUse = forEvent("PostToolUse");
      if (postToolUse.length > 0) {
        api.onToolResult(async (info) => {
          for (const hook of postToolUse) {
            if (!matches(hook.matcher, info.toolName)) continue;
            const text = info.result.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
            const payload = JSON.stringify({
              event: "PostToolUse",
              tool_name: info.toolName,
              tool_call_id: info.toolCallId,
              tool_output: text,
              is_error: info.isError,
            });
            const result = await runner(
              hook.command,
              payload,
              hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            );
            const json = parseJson(result.stdout);
            if (typeof json?.tool_output === "string") {
              return { content: [{ type: "text", text: json.tool_output }] };
            }
          }
          return undefined;
        });
      }

      const onSubmit = forEvent("UserPromptSubmit");
      if (onSubmit.length > 0) {
        api.onInput(async (text) => {
          for (const hook of onSubmit) {
            const result = await runner(
              hook.command,
              JSON.stringify({ event: "UserPromptSubmit", prompt: text }),
              hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            );
            if (result.exitCode === 2) return { consume: true };
            const json = parseJson(result.stdout);
            if (typeof json?.prompt === "string") return { text: json.prompt };
          }
          return undefined;
        });
      }

      for (const event of ["SessionStart", "Stop"] as const) {
        const specs = forEvent(event);
        if (specs.length === 0) continue;
        const lifecycle = event === "SessionStart" ? "session_start" : "agent_end";
        api.on(lifecycle, () => {
          for (const hook of specs) {
            void runner(
              hook.command,
              JSON.stringify({ event }),
              hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            ).catch((error: unknown) =>
              api.log(
                `${event} hook failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        });
      }
    },
  };
}
