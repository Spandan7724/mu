const args = process.argv.slice(2);
const valueAfter = (flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const sessionId = valueAfter("--session-id") ?? valueAfter("--resume") ?? "missing";
const profile = valueAfter("--profile");
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};
let messages: unknown[] = [];
let running = false;
let permissionPrompt: string | undefined;

if (profile !== "hang") {
  write({
    type: "ready",
    sessionId,
    model: "fake/fake-1",
    contextWindow: 10_000,
    thinking: "off",
    thinkingLevels: ["off"],
  });
}

const finish = (prompt: string) => {
  const user = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() };
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: `finished ${prompt}` }],
    model: "fake/fake-1",
    usage,
    stopReason: "end",
    timestamp: Date.now(),
  };
  messages = [...messages, user, assistant];
  write({ type: "event", event: { type: "message_end", message: user } });
  write({ type: "event", event: { type: "message_end", message: assistant } });
  write({ type: "event", event: { type: "agent_end", messages, reason: "done" } });
  running = false;
};

let buffer = "";
for await (const chunk of process.stdin) {
  buffer += String(chunk);
  let end = buffer.indexOf("\n");
  while (end !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    const op = JSON.parse(line);
    if (op.type === "input" || op.type === "follow_up") {
      running = true;
      write({ type: "event", event: { type: "agent_start" } });
      if (op.text.includes("malformed")) {
        write({ type: "event", event: { type: "task_started", taskId: 42 } });
      } else if (op.text.includes("crash")) {
        process.exit(7);
      } else if (op.text.includes("permission")) {
        permissionPrompt = op.text;
        write({
          type: "event",
          event: {
            type: "permission_asked",
            request: {
              id: "permission-1",
              toolCallId: "tool-1",
              toolName: "bash",
              permission: "bash",
              pattern: "bun test",
              description: "Run bun test",
            },
          },
        });
      } else {
        setTimeout(() => finish(op.text), op.text.includes("slow") ? 120 : 5);
      }
    } else if (op.type === "permission_reply" && permissionPrompt) {
      write({
        type: "event",
        event: {
          type: "permission_resolved",
          requestId: op.requestId,
          outcome: op.outcome,
          remembered: op.remember,
        },
      });
      const prompt = permissionPrompt;
      permissionPrompt = undefined;
      finish(prompt);
    } else if (op.type === "snapshot") {
      write({
        type: "snapshot",
        snapshot: {
          sessionId,
          messages,
          model: "fake/fake-1",
          contextWindow: 10_000,
          thinking: "off",
          thinkingLevels: ["off"],
          usage,
          contextPercent: 0,
          isRunning: running,
          commands: [{ label: "cost", description: "Show usage" }],
        },
      });
    } else if (op.type === "shutdown") {
      write({ type: "shutdown" });
      process.exit(0);
    }
    end = buffer.indexOf("\n");
  }
}
