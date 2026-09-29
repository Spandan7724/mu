// Stands in for `mu -p --json` in delegate tests: echoes its argv and cwd back as the answer.
const argv = process.argv.slice(2);
const task = argv[argv.indexOf("-p") + 1] ?? "";
const emit = (event: unknown) => console.log(JSON.stringify(event));
if (task.includes("hang")) await new Promise(() => {});
emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "/r.pdf" } });
if (task.includes("needs a command"))
  emit({ type: "permission_asked", request: { permission: "bash", description: "Run pdftotext" } });
emit({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "working on it" }] },
});
emit({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify({ argv, cwd: process.cwd() }) }],
  },
});
process.exit(task.includes("fail") ? 1 : 0);
