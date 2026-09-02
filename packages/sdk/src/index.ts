export type {
  Credential,
  ModelDiscoveryOptions,
  ModelInfo,
  Provider,
  ProviderModelDiscoveryOptions,
  ThinkingLevel,
  Usage,
  WebSearchAction,
  WebSearchCitation,
  WebSearchContent,
} from "@mu/ai";
export {
  builtinProviderConfigs,
  defaultModelId,
  defaultModelRef,
  defaultThinkingLevel,
  discoverModels,
  findModel,
  listModels,
  providerConfig,
  providerHasCredentials,
  refreshModels,
  registerModels,
  registerProvider,
  supportedThinkingLevels,
  thinkingLevelForModel,
} from "@mu/ai";
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
  ExtensionEvent,
  ExtensionEventFor,
  ExtensionEventType,
  LifecycleEvent,
  LifecycleNotification,
  PermissionMode,
  PermissionModeTone,
  PermissionRequest,
  PermissionRule,
  ProfileRuntime,
  ProfileRuntimeHost,
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
export type {
  AgentOptions,
  AgentRunOptions,
  CheckpointActionData,
  CheckpointActionResult,
  ChildAgentOptions,
  HaltReason,
  ManualCompactionResult,
  RunResult,
  UndoPoint,
} from "./agent.ts";
export { Agent } from "./agent.ts";
export type {
  AuthFile,
  AuthStoreOptions,
  OpenAiCallbackServer,
  OpenAiLoginOptions,
  OpenAiLoginResult,
  PlanLoginCallbackServer,
  PlanLoginOptions,
  PlanLoginResult,
  StoredApiKey,
  StoredCredential,
  StoredOpenAiOAuth,
  StoredPlanOAuth,
} from "./auth.ts";
export {
  createCredentialResolver,
  defaultAuthFile,
  loginGitHubCopilot,
  loginKimiCoding,
  loginOpenAI,
  loginOpenRouter,
  loginXai,
  preferredAuthProvider,
  readAuthFile,
  removeStoredCredential,
  saveApiKey,
  storedAuthProviders,
} from "./auth.ts";
export type { AuthPageOptions } from "./auth-page.ts";
export { authErrorPage, authSuccessPage, renderAuthPage } from "./auth-page.ts";
export type { Budget, BudgetBreach } from "./budget.ts";
export { checkBudget, totalTokens } from "./budget.ts";
export type { DiffCommandData, ForkPoint, UndoPointsCommandData } from "./commands.ts";
export { coreCommands, registryWithCoreCommands } from "./commands.ts";
export type { LoadOptions, LoadReport } from "./extension-loader.ts";
export { loadExtensions, resolveExtensionFiles } from "./extension-loader.ts";
export type { FileSessionStoreOptions } from "./file-store.ts";
export { FileSessionStore } from "./file-store.ts";
export type {
  MarkdownCommand,
  MarkdownCommandOptions,
  MarkdownCommandRun,
} from "./markdown-commands.ts";
export {
  loadMarkdownCommands,
  parseFrontmatter,
  parseMarkdownCommand,
  substituteArguments,
  toCommand,
} from "./markdown-commands.ts";
export type {
  LoadMcpConfigOptions,
  McpConfigReport,
  McpStdioServerConfig,
} from "./mcp.ts";
export { loadMcpConfig, mcpExtension } from "./mcp.ts";
export type { Profile, ProfileImporter } from "./profile.ts";
export { loadProfile, optionsFromProfile } from "./profile.ts";
export type { HookEvent, HookRunner, HookSpec } from "./shell-hooks.ts";
export { shellHooksExtension } from "./shell-hooks.ts";
export type { SideConversation, SideConversationInput } from "./side.ts";
export { startSideConversation } from "./side.ts";
export type { Skill } from "./skills.ts";
export {
  defaultSkillRoots,
  discoverSkills,
  loadSkill,
  skillListing,
  skillsExtension,
} from "./skills.ts";
export {
  STRUCTURED_OUTPUT_TOOL,
  structuredOutputPrompt,
  structuredOutputTool,
} from "./structured-output.ts";
export type {
  SubagentDetails,
  SubagentExtensionOptions,
  SubagentKind,
  SubagentProgressUpdate,
} from "./subagents.ts";
export { subagentsExtension } from "./subagents.ts";
export type { ToolDefinition, ToolResult } from "./tool.ts";
export { tool } from "./tool.ts";
export type {
  MarkdownTranscript,
  TranscriptMarkdownOptions,
} from "./transcript-markdown.ts";
export { sessionToMarkdown } from "./transcript-markdown.ts";
