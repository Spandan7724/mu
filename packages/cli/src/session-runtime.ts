import {
  Agent,
  type AgentOptions,
  type CommandRegistry,
  ExtensionHost,
  loadMarkdownCommands,
  optionsFromProfile,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRule,
  type Profile,
  registryWithCoreCommands,
  subagentsExtension,
  toCommand,
  type WebSearchMode,
} from "mu";
import { withStoredCredentials } from "./auth.ts";
import { resolveCliModel } from "./config.ts";
import { loadBuiltInExtensions } from "./extensions.ts";
import { nextPermissionMode, permissionModeFor, rulesForPermissionMode } from "./permissions.ts";
import {
  DEFAULT_PROFILE,
  profileOptionsFromArgs,
  resolveProfile,
  sessionStoreForProfile,
} from "./profiles.ts";

export interface SessionRuntimeOptions {
  cwd: string;
  profile?: string | undefined;
  model?: string | undefined;
  permissionMode?: string | undefined;
  webSearch?: WebSearchMode | undefined;
  allowAll?: boolean | undefined;
  noInstructions?: boolean | undefined;
  resumeSessionId?: string | undefined;
  sessionId?: string | undefined;
  maxTurns?: number | undefined;
  maxCostUsd?: number | undefined;
  agentOptions?: AgentOptions | undefined;
  onDiagnostic?: ((message: string) => void) | undefined;
  permissions: "forward" | "deny";
}

export interface CliSessionRuntime {
  agent: Agent;
  profile: Profile | undefined;
  extensions: ExtensionHost;
  commands: CommandRegistry;
  agentOptions: AgentOptions;
  basePermissions: PermissionRule[];
  permissionMode: PermissionMode | undefined;
  permissionModes: readonly PermissionMode[];
  warnings: string[];
  pendingPermissions: ReadonlyMap<string, PermissionRequest>;
  resolvePermission(requestId: string, outcome: "allow" | "deny", remember?: boolean): boolean;
  cyclePermissionMode(): string | undefined;
  setPermissionMode(id: string): string | undefined;
  cancelPermissions(): void;
}

export async function createCliSessionRuntime(
  options: SessionRuntimeOptions,
): Promise<CliSessionRuntime> {
  const overrides = options.agentOptions ?? {};
  const useBuiltIns = !overrides.tools;
  const model =
    useBuiltIns || options.model ? await resolveCliModel(options.model) : overrides.model;
  let profile: Profile | undefined;
  let resolved = overrides;
  if (useBuiltIns) {
    profile = await resolveProfile(
      options.profile ?? DEFAULT_PROFILE,
      profileOptionsFromArgs(options.noInstructions ? { noInstructions: true } : {}),
    );
    for (const diagnostic of profile.diagnostics ?? [])
      options.onDiagnostic?.(`instruction warning: ${diagnostic}`);
    if (typeof model !== "string") throw new Error("profile loading requires a model reference");
    resolved = await optionsFromProfile(profile, model, overrides);
    if (!resolved.session)
      resolved = { ...resolved, session: await sessionStoreForProfile(profile) };
  }

  const basePermissions: PermissionRule[] = [...(resolved.permissions ?? [])];
  let activePermissionMode: PermissionMode | undefined;
  if (profile) {
    activePermissionMode = options.allowAll
      ? profile.permissionModes?.find((candidate) => candidate.id === "yolo")
      : permissionModeFor(profile, options.permissionMode);
    resolved = {
      ...resolved,
      permissions: options.allowAll
        ? [...basePermissions, { permission: "*", pattern: "*", action: "allow" }]
        : rulesForPermissionMode(basePermissions, activePermissionMode),
    };
  } else if (options.permissionMode) {
    throw new Error("--permission-mode requires a profile with permission modes");
  }

  if (options.webSearch) resolved = { ...resolved, webSearch: { mode: options.webSearch } };
  resolved = withStoredCredentials(resolved);
  const loaded = useBuiltIns
    ? await loadBuiltInExtensions(options.cwd, resolved.extensions)
    : { host: resolved.extensions ?? new ExtensionHost(), warnings: [] };
  for (const warning of loaded.warnings) options.onDiagnostic?.(warning);

  const pending = new Map<
    string,
    { request: PermissionRequest; resolve: (outcome: "allow" | "deny") => void }
  >();
  const agent = new Agent({
    ...resolved,
    ...(model ? { model } : {}),
    extensions: loaded.host,
    ...(options.maxTurns !== undefined || options.maxCostUsd !== undefined
      ? {
          budget: {
            ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
            ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
          },
        }
      : {}),
    ...(options.permissions === "forward"
      ? {
          onPermission: (request: PermissionRequest) =>
            new Promise<"allow" | "deny">((resolve) =>
              pending.set(request.id, { request, resolve }),
            ),
        }
      : {}),
  });
  const restrictiveMode = profile?.permissionModes?.find((mode) => mode.tone === "restrictive");
  const existingTools = [
    ...(resolved.tools?.map((candidate) => candidate.name) ?? []),
    ...loaded.host.tools.keys(),
  ];
  await loaded.host.register(
    subagentsExtension({
      parent: () => agent,
      ...(profile?.name === "coding" && profile.subagents ? { coding: profile.subagents } : {}),
      inspectionPermissions: rulesForPermissionMode(basePermissions, restrictiveMode),
      excludeTools: existingTools,
    }),
  );

  if (options.resumeSessionId) {
    const tree = await agent.sessionStore.load(options.resumeSessionId);
    if (!tree) throw new Error(`Session not found: ${options.resumeSessionId}`);
    agent.resume(tree);
  } else if (options.sessionId) {
    agent.newSession(options.sessionId);
    // Establish the scoped session and its profile/environment header before
    // the first operation so a worker crash during startup is still visible
    // and resumable through the same profile scope.
    await agent.sessionStore.save(agent.sessionId, agent.session);
  }

  const commands = registryWithCoreCommands({
    requestCompaction: (focus) => agent.compactNow(focus),
    usage: () => ({ ...agent.usage, contextPercent: agent.contextPercent }),
    undo: (turnCount) => agent.undo(turnCount),
    undoPoints: () => agent.undoPoints(),
    redo: () => agent.redo(),
    fork: (entryId) => agent.fork(entryId),
    forkPoints: () => agent.forkPoints(),
    diff: () => agent.sessionDiff(),
  });
  for (const command of profile?.commands ?? []) commands.register(command);
  for (const command of loaded.host.commands.list()) commands.register(command);
  for (const markdown of await loadMarkdownCommands({ projectDir: options.cwd })) {
    commands.register(toCommand(markdown));
  }

  return {
    agent,
    profile,
    extensions: loaded.host,
    commands,
    agentOptions: { ...resolved, extensions: loaded.host },
    basePermissions,
    get permissionMode() {
      return activePermissionMode;
    },
    permissionModes: profile?.permissionModes ?? [],
    warnings: loaded.warnings,
    get pendingPermissions() {
      return new Map([...pending].map(([id, value]) => [id, value.request]));
    },
    resolvePermission: (requestId, outcome, remember) => {
      const item = pending.get(requestId);
      if (!item) return false;
      pending.delete(requestId);
      if (outcome === "allow" && remember) {
        const rule = {
          permission: item.request.permission,
          pattern: item.request.pattern,
          action: "allow" as const,
        };
        basePermissions.push(rule);
        agent.addPermissionRule(rule);
        void Promise.resolve(profile?.rememberPermission?.(rule.permission, rule.pattern)).catch(
          (error) =>
            options.onDiagnostic?.(
              `could not remember permission: ${error instanceof Error ? error.message : String(error)}`,
            ),
        );
      }
      item.resolve(outcome);
      return true;
    },
    cyclePermissionMode: () => {
      if (!profile) return undefined;
      const next = nextPermissionMode(profile.permissionModes ?? [], activePermissionMode);
      if (!next) return undefined;
      agent.setPermissions(rulesForPermissionMode(basePermissions, next));
      activePermissionMode = next;
      return next.label;
    },
    setPermissionMode: (id) => {
      if (!profile) return undefined;
      const next = (profile.permissionModes ?? []).find((mode) => mode.id === id);
      if (!next) return undefined;
      agent.setPermissions(rulesForPermissionMode(basePermissions, next));
      activePermissionMode = next;
      return next.label;
    },
    cancelPermissions: () => {
      for (const [id, item] of pending) {
        pending.delete(id);
        item.resolve("deny");
      }
    },
  };
}
