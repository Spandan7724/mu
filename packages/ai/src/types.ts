export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  // Providers (Anthropic) require thinking blocks preserved + signed across
  // tool-use turns. Must round-trip through session storage.
  signature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  mimeType: string;
  data: string; // base64
  evictable?: boolean; // compaction evicts these first; default true for tool-result images
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  // Gemini thought signatures must round-trip on function calls.
  signature?: string;
}

export type UserContent = TextContent | ImageContent;
export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;
export type ToolResultContent = TextContent | ImageContent;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number; // computed from pricing catalog at receive time
}

export type StopReason = "end" | "toolUse" | "length" | "aborted" | "error";

export interface UserMessage {
  role: "user";
  content: UserContent[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  model: string; // "provider/model-id"
  usage: Usage; // ALWAYS present (zeroed on error)
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ToolResultContent[]; // model-visible
  details?: unknown; // renderer/session-visible only
  isError: boolean;
  evicted?: boolean; // microcompaction replaced content with tombstone
  timestamp: number;
}

export type AiMessage = UserMessage | AssistantMessage | ToolResultMessage;

// System prompt section. Static sections come first; the Anthropic client
// places a cache breakpoint at the last static section.
export interface PromptSection {
  text: string;
  dynamic?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface LlmContext {
  systemPrompt?: PromptSection[];
  messages: AiMessage[];
  tools?: ToolSpec[];
}

export interface ModelPricing {
  input: number; // $/Mtok
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelInfo {
  provider: string; // "anthropic" | "openai" | "google" | custom
  id: string;
  name?: string;
  baseUrl?: string;
  contextWindow: number;
  maxOutput: number;
  modalities: ("text" | "image")[];
  thinking?: boolean;
  // Anthropic: "adaptive" (effort-based, 4.6+) vs "budget" (budget_tokens, older).
  thinkingMode?: "adaptive" | "budget";
  pricing: ModelPricing;
}

export type ThinkingLevel = "off" | "low" | "medium" | "high";

// Per : resolved before every request; clients never cache tokens.
export type Credential =
  | { type: "apiKey"; apiKey: string }
  | { type: "oauth"; accessToken: string; accountId: string };

// Returning undefined falls through to explicit/env API-key resolution. This
// lets one provider-aware resolver serve a multi-provider Agent.
export type CredentialResolver = () => Promise<Credential | undefined>;

export interface ProviderModelDiscoveryOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  getCredentials?: CredentialResolver;
  clientVersion?: string;
  currentModels: readonly ModelInfo[];
}

export interface StreamOpts {
  apiKey?: string;
  getCredentials?: CredentialResolver;
  baseUrl?: string;
  sessionId?: string;
  maxTokens?: number;
  temperature?: number;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  maxRetries?: number;
  headers?: Record<string, string>;
  // Injectable for the record/replay test harness.
  fetch?: typeof fetch;
}

export type ProviderStreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCallContent;
      partial: AssistantMessage;
    }
  | { type: "done"; message: AssistantMessage }
  | {
      type: "error";
      reason: Extract<StopReason, "aborted" | "error">;
      // Typed error classification for consumers (reactive compaction keys on
      // "context_too_long"). String, so events stay serializable.
      errorKind?: string;
      error: AssistantMessage;
    };

import type { AssistantStream } from "./stream.ts";

export interface Provider {
  id: string;
  stream(model: ModelInfo, ctx: LlmContext, opts?: StreamOpts): AssistantStream;
  // Return undefined when discovery is not applicable (for example, before
  // login). A returned array is authoritative for this provider.
  discoverModels?(options: ProviderModelDiscoveryOptions): Promise<ModelInfo[] | undefined>;
}
