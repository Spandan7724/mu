import type {
  AgentMessage,
  AssistantMessage,
  CustomMessage,
  SessionTree,
  ToolResultMessage,
  UserMessage,
} from "@mu/core";

export interface TranscriptMarkdownOptions {
  sessionId?: string;
  model?: string;
  exportedAt?: Date;
}

export interface MarkdownTranscript {
  markdown: string;
  messageCount: number;
}

function textFence(text: string, language = "text"): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function timestampLine(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : `_${date.toISOString()}_\n`;
}

function imageLine(mimeType: string): string {
  return `> [Image omitted from text export: ${mimeType}]`;
}

function contentText(message: UserMessage | CustomMessage): string[] {
  return message.content.map((block) =>
    block.type === "text" ? block.text : imageLine(block.mimeType),
  );
}

function renderUser(message: UserMessage): string {
  return ["## User", timestampLine(message.timestamp), ...contentText(message)]
    .filter(Boolean)
    .join("\n");
}

function renderAssistant(message: AssistantMessage): string {
  const blocks = message.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "thinking") {
      return [
        "<details>",
        "<summary>Thinking</summary>",
        "",
        block.thinking,
        "",
        "</details>",
      ].join("\n");
    }
    return [
      "<details>",
      `<summary>Tool call: <code>${escapeHtml(block.name)}</code></summary>`,
      "",
      textFence(JSON.stringify(block.arguments, null, 2) ?? "null", "json"),
      "",
      "</details>",
    ].join("\n");
  });
  if (message.errorMessage) blocks.push(`> Error: ${message.errorMessage}`);
  return ["## Mu", timestampLine(message.timestamp), ...blocks].filter(Boolean).join("\n");
}

function renderToolResult(message: ToolResultMessage): string {
  const content = message.content
    .map((block) => (block.type === "text" ? block.text : imageLine(block.mimeType)))
    .join("\n");
  const details =
    message.details === undefined
      ? []
      : [
          "",
          "**Details**",
          "",
          textFence(JSON.stringify(message.details, null, 2) ?? "null", "json"),
        ];
  return [
    "<details>",
    `<summary>Tool result: <code>${escapeHtml(message.toolName)}</code>${message.isError ? " (error)" : ""}</summary>`,
    "",
    timestampLine(message.timestamp),
    textFence(content || "(no output)"),
    ...details,
    "",
    "</details>",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderCustom(message: CustomMessage): string {
  const safeCustomType = message.customType.replaceAll(/[^\p{L}\p{N} _-]/gu, "").trim();
  const label =
    message.customType === "user_shell_command" ? "User shell" : safeCustomType || "Context";
  return [
    `## ${label}`,
    timestampLine(message.timestamp),
    ...contentText(message).map((content) => textFence(content)),
  ]
    .filter(Boolean)
    .join("\n");
}

function includedMessage(message: AgentMessage): boolean {
  return (
    message.role !== "custom" ||
    message.display === true ||
    message.customType === "user_shell_command"
  );
}

function renderMessage(message: AgentMessage): string {
  if (message.role === "user") return renderUser(message);
  if (message.role === "assistant") return renderAssistant(message);
  if (message.role === "toolResult") return renderToolResult(message);
  return renderCustom(message);
}

export function sessionToMarkdown(
  session: SessionTree,
  options: TranscriptMarkdownOptions = {},
): MarkdownTranscript {
  const messages = session
    .activePath()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message)
    .filter(includedMessage);
  const exportedAt = options.exportedAt ?? new Date();
  const metadata = [
    options.sessionId ? `- Session: \`${options.sessionId}\`` : undefined,
    options.model ? `- Model: \`${options.model}\`` : undefined,
    `- Exported: ${exportedAt.toISOString()}`,
  ].filter((line): line is string => line !== undefined);
  const sections = messages.map(renderMessage);
  return {
    markdown: [
      "# Mu chat transcript",
      "",
      ...metadata,
      ...(sections.length > 0 ? ["", sections.join("\n\n")] : []),
      "",
    ].join("\n"),
    messageCount: messages.length,
  };
}
