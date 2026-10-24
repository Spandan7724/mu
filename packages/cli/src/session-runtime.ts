import {
  Agent,
  type AgentOptions,
  type CommandRegistry,
  ExtensionHost,
  findModel,
  loadMarkdownCommands,
  optionsFromProfile,
  type PermissionMode,
  type PermissionReply,
  type PermissionRequest,
  type PermissionRule,
  type Profile,
  registryWithCoreCommands,
  type SavedPermissionRule,
  subagentsExtension,
  toCommand,
} from "mu";
import { withStoredCredentials } from "./auth.ts";
import { loadUserConfig, resolveCliModel, savedThinkingLevel } from "./config.ts";
import { loadBuiltInExtensions } from "./extensions.ts";
import {
  nextPermissionMode,
  permissionModeFor,
  rulesForPermissionMode,
  savedPermissionMode,
} from "./permissions.ts";
import {
  type BrowserFlags,
  DEFAULT_PROFILE,
  profileOptionsFromArgs,
  resolveProfile,
  sessionStoreForProfile,
} from "./profiles.ts";
import { subagentRouteOverride, usableModels } from "./subagent-routes.ts";

export interface SessionRuntimeOptions {
  cwd: string;
  profile?: string | undefined;
  model?: string | undefined;
  permissionMode?: string | undefined;
  allowAll?: boolean | undefined;
  // Start in the permission mode last chosen in the app when none is given.
  savedPermissionMode?: boolean | undefined;
  noInstructions?: boolean | undefined;
  noCheckpoints?: boolean | undefined;
  browser?: BrowserFlags | undefined;
  // Merged over the options derived from flags (tests and embedders).
  profileOptions?: Record<string, unknown> | undefined;
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
  // `true` saves the allow rules through the profile; "session" keeps them
  // until the process exits. A message reaches the model with a denial.
  resolvePermission(
    requestId: string,
    outcome: "allow" | "deny",
    remember?: PermissionRemember,
    message?: string,
  ): boolean;
  // Saved rules followed by this session's, whose source is SESSION_RULES.
  permissionRules(): Promise<SavedPermissionRule[]>;
  forgetPermissionRule(rule: SavedPermissionRule): Promise<void>;
  cyclePermissionMode(): string | undefined;
  setPermissionMode(id: string): string | undefined;
  cancelPermissions(): void;
}

export type PermissionRemember = boolean | "session";

export const SESSION_RULES = "session";

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
    const profileName = options.profile ?? DEFAULT_PROFILE;
    profile = await resolveProfile(profileName, {
      ...profileOptionsFromArgs(
        {
          noInstructions: options.noInstructions === true,
          noCheckpoints: options.noCheckpoints === true,
          browser: options.browser,
        },
        profileName,
      ),
      ...(options.profileOptions ?? {}),
    });
    for (const diagnostic of profile.diagnostics ?? [])
      options.onDiagnostic?.(`instruction warning: ${diagnostic}`);
    if (typeof model !== "string") throw new Error("profile loading requires a model reference");
    resolved = await optionsFromProfile(profile, model, overrides);
    if (!resolved.session)
      resolved = { ...resolved, session: await sessionStoreForProfile(profile) };
  }

  const basePermissions: PermissionRule[] = [...(resolved.permissions ?? [])];
  const sessionRules: PermissionRule[] = [];
  let activePermissionMode: PermissionMode | undefined;
  // Rebuilt rather than appended to, so a mode's final rules (configured denies
  // among them) stay last when an approval adds an allow.
  const currentRules = (): PermissionRule[] =>
    options.allowAll && !activePermissionMode
      ? [...basePermissions, { permission: "*", pattern: "*", action: "allow" }]
      : rulesForPermissionMode(basePermissions, activePermissionMode);
  if (profile) {
    activePermissionMode = options.allowAll
      ? profile.permissionModes?.find((candidate) => candidate.tone === "unrestricted")
      : permissionModeFor(
          profile,
          options.permissionMode ??
            (options.savedPermissionMode
              ? savedPermissionMode(profile, await loadUserConfig(undefined, () => {}))
              : undefined),
        );
    resolved = { ...resolved, permissions: currentRules() };
  } else if (options.permissionMode) {
    throw new Error("--permission-mode requires a profile with permission modes");
  }

  resolved = withStoredCredentials(resolved);
  const loaded = useBuiltIns
    ? await loadBuiltInExtensions(
        options.cwd,
        resolved.extensions,
        {},
        {},
        {
          project: profile?.name !== "browser",
        },
      )
    : { host: resolved.extensions ?? new ExtensionHost(), warnings: [] };
  for (const warning of loaded.warnings) options.onDiagnostic?.(warning);

  const pending = new Map<
    string,
    { request: PermissionRequest; resolve: (reply: PermissionReply) => void }
  >();
  const modelInfo = typeof model === "string" ? findModel(model) : model;
  const thinkingLevel =
    resolved.thinkingLevel ??
    (useBuiltIns && modelInfo
      ? savedThinkingLevel(await loadUserConfig(undefined, () => {}), modelInfo)
      : undefined);
  const agent = new Agent({
    ...resolved,
    ...(thinkingLevel ? { thinkingLevel } : {}),
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
            new Promise<PermissionReply>((resolve) =>
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
      ...(profile?.subagents?.taskSession ? { taskSession: profile.subagents.taskSession } : {}),
      ...(profile?.name === "coding" && profile.subagents ? { coding: profile.subagents } : {}),
      inspectionPermissions: rulesForPermissionMode(basePermissions, restrictiveMode),
      excludeTools: existingTools,
      modelChoices: () => usableModels({ extensions: loaded.host }),
      ...(profile?.name === "coding"
        ? {
            routeOverride: subagentRouteOverride({
              profile: profile.name,
              extensions: loaded.host,
            }),
          }
        : {}),
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
    ...(agent.checkpointUnavailable ? { checkpointUnavailable: agent.checkpointUnavailable } : {}),
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
    resolvePermission: (requestId, outcome, remember, message) => {
      const item = pending.get(requestId);
      if (!item) return false;
      pending.delete(requestId);
      if (outcome === "allow" && remember) {
        const rules = (
          item.request.allowRules ?? [
            { permission: item.request.permission, pattern: item.request.pattern },
          ]
        ).map((rule) => ({ ...rule, action: "allow" as const }));
        basePermissions.push(...rules);
        if (remember === "session") sessionRules.push(...rules);
        agent.setPermissions(currentRules());
        if (remember === true) {
          void (async () => {
            for (const rule of rules) {
              await profile?.rememberPermission?.(rule.permission, rule.pattern);
            }
          })().catch((error) =>
            options.onDiagnostic?.(
              `could not remember permission: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      }
      item.resolve(message && outcome === "deny" ? { outcome, message } : outcome);
      return true;
    },
    permissionRules: async () => [
      ...((await profile?.savedPermissions?.()) ?? []),
      ...sessionRules.map((rule) => ({ ...rule, source: SESSION_RULES })),
    ],
    forgetPermissionRule: async (rule) => {
      const same = (candidate: PermissionRule) =>
        candidate.permission === rule.permission &&
        candidate.pattern === rule.pattern &&
        candidate.action === rule.action;
      if (rule.source === SESSION_RULES) {
        const index = sessionRules.findLastIndex(same);
        if (index !== -1) sessionRules.splice(index, 1);
      } else {
        await profile?.forgetPermission?.(rule);
      }
      const index = basePermissions.findLastIndex(same);
      if (index !== -1) basePermissions.splice(index, 1);
      agent.setPermissions(currentRules());
    },
    cyclePermissionMode: () => {
      if (!profile) return undefined;
      const next = nextPermissionMode(profile.permissionModes ?? [], activePermissionMode);
      if (!next) return undefined;
      activePermissionMode = next;
      agent.setPermissions(currentRules());
      return next.label;
    },
    setPermissionMode: (id) => {
      if (!profile) return undefined;
      const next = (profile.permissionModes ?? []).find((mode) => mode.id === id);
      if (!next) return undefined;
      activePermissionMode = next;
      agent.setPermissions(currentRules());
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
