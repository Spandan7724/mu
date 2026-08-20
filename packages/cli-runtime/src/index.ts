// Product-neutral interactive/headless/RPC runtime. Nothing here imports a
// profile package or branches on a concrete product.
export type { ParsedArgs } from "./args.ts";
export { HELP_DESCRIPTION_COLUMN, helpText, parseArgs, usageLine } from "./args.ts";
export { withStoredCredentials } from "./auth.ts";
export type { UserConfig } from "./config.ts";
export { loadUserConfig, resolveCliModel, saveDefaultModel } from "./config.ts";
export type { TranscriptExportCommandOptions } from "./export-command.ts";
export { transcriptExportCommand } from "./export-command.ts";
export type { BuiltInExtensions } from "./extensions.ts";
export { loadBuiltInExtensions } from "./extensions.ts";
export type { HeadlessIo } from "./headless.ts";
export { EXIT, runHeadless } from "./headless.ts";
export type { InteractiveOptions, SessionOwnershipGuard } from "./interactive.ts";
export {
  formatAuthUrl,
  formatPermissionMode,
  formatResumeHint,
  initializeInteractiveSession,
  registerDeclaredRenderers,
  registerProductRenderers,
  renderCheckpointCommand,
  renderDiffCommand,
  runInteractive,
  startNewInteractiveSession,
} from "./interactive.ts";
export type {
  AccountLoginOptions,
  AccountLoginProvider,
  ApiKeyLoginProvider,
  LoginMethod,
  LogoutProvider,
} from "./login.ts";
export {
  accountLoginProviders,
  apiKeyLoginProviders,
  loginMethods,
  logoutProviders,
  providerName,
} from "./login.ts";
export type { ModelCatalog, ModelCatalogRefreshResult } from "./model-catalog.ts";
export { initializeModelCatalog, modelCatalogDiagnostics } from "./model-catalog.ts";
export type { ModelCredentialSource, ModelPickerItem } from "./model-picker.ts";
export {
  availableModels,
  modelPickerDescription,
  modelPickerItems,
} from "./model-picker.ts";
export { nextPermissionMode, permissionModeFor, rulesForPermissionMode } from "./permissions.ts";
export type {
  DirectShellAdapter,
  FileMentionAdapter,
  ProductArgResult,
  ProductCapabilities,
  ProductCommandContext,
  ProductDataNamespace,
  ProductDescriptor,
  ProductHelp,
  ProductLaunchContext,
  ProfileRequest,
} from "./product.ts";
export { diagnosticPrefix } from "./product.ts";
export { profileModuleSpecifier, sessionStoreForProfile } from "./profiles.ts";
export type { RpcDeps, RpcIo, RpcOp, RpcOut, RpcRuntimeMetadata, RpcSnapshot } from "./rpc.ts";
export { linesFrom, parseOp, runRpc } from "./rpc.ts";
export type { ResumePickerItem } from "./session-picker.ts";
export { resumePickerItems, sessionPickerLabel } from "./session-picker.ts";
export type { CliSessionRuntime, SessionRuntimeOptions } from "./session-runtime.ts";
export { createCliSessionRuntime } from "./session-runtime.ts";
export type { SaveTranscriptOptions } from "./transcript-file.ts";
export { saveTranscriptMarkdown, transcriptPath } from "./transcript-file.ts";
export type { UserShellEventSink, UserShellRunOptions } from "./user-shell.ts";
export { formatUserShellRecord, runUserShellCommand } from "./user-shell.ts";
