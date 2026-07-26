export type { ModelInfo, Provider, ThinkingLevel, Usage } from "@mu/ai";
export { findModel, listModels, registerModels, registerProvider } from "@mu/ai";
// Re-exported so SDK users never need to reach into the kernel packages.
export type {
  AgentEvent,
  AgentMessage,
  AnyTool,
  Command,
  CommandContext,
  CommandResult,
  CustomMessage,
  Extension,
  ExtensionAPI,
  PermissionRequest,
  PermissionRule,
  SessionStore,
  StreamDelta,
  Tool,
  ToolRenderer,
  UserContent,
} from "@mu/core";
export {
  CommandRegistry,
  customMessage,
  ExtensionHost,
  errorResult,
  MemorySessionStore,
  SessionTree,
  textResult,
  userMessage,
} from "@mu/core";
export type { AgentOptions, HaltReason, RunResult } from "./agent.ts";
export { Agent } from "./agent.ts";
export type { Budget, BudgetBreach } from "./budget.ts";
export { checkBudget, totalTokens } from "./budget.ts";
export { coreCommands, registryWithCoreCommands } from "./commands.ts";
export type { LoadOptions, LoadReport } from "./extension-loader.ts";
export { loadExtensions, resolveExtensionFiles } from "./extension-loader.ts";
export type { FileSessionStoreOptions } from "./file-store.ts";
export { FileSessionStore } from "./file-store.ts";
export type { Profile, ProfileImporter } from "./profile.ts";
export { loadProfile, optionsFromProfile } from "./profile.ts";
export type { HookEvent, HookRunner, HookSpec } from "./shell-hooks.ts";
export { shellHooksExtension } from "./shell-hooks.ts";
export {
  STRUCTURED_OUTPUT_TOOL,
  structuredOutputPrompt,
  structuredOutputTool,
} from "./structured-output.ts";
export type { ToolDefinition, ToolResult } from "./tool.ts";
export { tool } from "./tool.ts";
