import { readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { bashTool } from "@mu/profile-coding";
import {
  App,
  type ColorDepth,
  checkpointCell,
  codingRenderers,
  detectColorDepth,
  diffCell,
  diffLinesFromHunks,
  FullScreenRenderer,
  formatCwdForFooter,
  hyperlink,
  InputDecoder,
  RendererRegistry,
  styleText,
  Terminal,
  type ToolRendererFn,
} from "@mu/tui";
import {
  Agent,
  type AgentOptions,
  type AgentRunOptions,
  type CheckpointActionData,
  type Command,
  customMessage,
  type DiffCommandData,
  ExtensionHost,
  listModels,
  loadMarkdownCommands,
  type MarkdownCommandRun,
  type ModelInfo,
  optionsFromProfile,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRule,
  type Profile,
  readAuthFile,
  registryWithCoreCommands,
  removeStoredCredential,
  saveApiKey,
  type ThinkingLevel,
  type ToolRenderer,
  toCommand,
} from "mu";
import type { ParsedArgs } from "./args.ts";
import { withStoredCredentials } from "./auth.ts";
import { resolveCliModel, saveDefaultModel } from "./config.ts";
import { transcriptExportCommand } from "./export-command.ts";
import { loadBuiltInExtensions } from "./extensions.ts";
import {
  type AccountLoginProvider,
  accountLoginProviders,
  apiKeyLoginProviders,
  loginMethods,
  logoutProviders,
} from "./login.ts";
import type { ModelCatalog, ModelCatalogRefreshResult } from "./model-catalog.ts";
import { permissionModeFor, rulesForPermissionMode } from "./permissions.ts";
import {
  DEFAULT_PROFILE,
  profileOptionsFromArgs,
  resolveProfile,
  sessionStoreForProfile,
} from "./profiles.ts";
import { resumePickerItems } from "./session-picker.ts";
import { saveTranscriptMarkdown } from "./transcript-file.ts";
import { formatUserShellRecord, runUserShellCommand } from "./user-shell.ts";

const SPINNER_INTERVAL_MS = 120;

export function formatTerminalTitle(cwd: string): string {
  return `mu - ${basename(cwd) || cwd}`;
}

export function renderDiffCommand(
  data: DiffCommandData,
  width: number,
  depth: ColorDepth,
): string[] {
  return data.files.flatMap((file, index) => [
    ...(index > 0 ? [""] : []),
    ...diffCell(
      {
        path: file.path,
        added: file.added,
        removed: file.removed,
        lines: diffLinesFromHunks(file.hunks),
      },
      { width, depth },
    ),
  ]);
}

export function renderCheckpointCommand(
  data: CheckpointActionData,
  width: number,
  depth: ColorDepth,
): string[] {
  return checkpointCell(
    {
      action: data.action,
      files: data.files,
      messageCount: data.messageCount,
      promptRestored: data.action === "undo" && data.prompt !== undefined,
    },
    { width, depth },
  );
}

// The authorization URL is far wider than any terminal, so it always wraps.
// An OSC 8 hyperlink keeps every wrapped row part of one clickable link;
// terminals without OSC 8 still show the complete URL as plain text.
export function formatAuthUrl(
  url: string,
  opened: boolean,
  provider: string,
  depth: ColorDepth,
  platform: string = process.platform,
): string[] {
  const modifier = platform === "darwin" ? "cmd" : "ctrl";
  return [
    opened
      ? `  Complete the ${provider} sign-in in your browser, or open this URL:`
      : `  Could not open a browser. Open this URL to continue:`,
    `  ${styleText(hyperlink(url), { link: true }, depth)}`,
    `  ${styleText(hyperlink(url, `${modifier}+click to open`), { dim: true }, depth)}`,
  ];
}

export function formatResumeHint(sessionId: string, depth: ColorDepth): string {
  const label = styleText("To resume this session:", { resumeHint: true }, depth);
  return `  ${label} mu --resume ${sessionId}`;
}

export async function initializeInteractiveSession(
  agent: Pick<Agent, "sessionStore" | "resume">,
  sessionId: string | undefined,
): Promise<boolean> {
  if (!sessionId) return false;
  const session = await agent.sessionStore.load(sessionId);
  if (!session) throw new Error(`no such session: ${sessionId}`);
  agent.resume(session);
  return true;
}

export function startNewInteractiveSession(
  agent: Pick<
    Agent,
    "newSession" | "sessionId" | "modelRef" | "contextWindow" | "thinking" | "thinkingLevels"
  >,
  app: Pick<
    App,
    "setModel" | "setThinking" | "handleEvent" | "replaceTranscript" | "banner" | "renderScreen"
  >,
  renderer: Pick<FullScreenRenderer, "clear" | "renderNow">,
): string {
  agent.newSession();
  app.setModel(agent.modelRef, agent.contextWindow);
  app.setThinking(agent.thinking, agent.thinkingLevels);
  app.handleEvent({
    type: "usage_updated",
    sessionTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
    contextTokens: 0,
    contextPercent: 0,
  });
  app.replaceTranscript([], app.banner());
  renderer.clear();
  renderer.renderNow(app.renderScreen());
  return agent.sessionId;
}

export function availableModels(
  extensions: ExtensionHost,
  authenticatedProviders?: ReadonlySet<string>,
): ModelInfo[] {
  const models = new Map<string, ModelInfo>(
    listModels()
      .filter((model) => !authenticatedProviders || authenticatedProviders.has(model.provider))
      .map((model) => [`${model.provider}/${model.id}`, model] as const),
  );
  for (const [ref, model] of extensions.models) models.set(ref, model);
  return [...models.values()];
}

export function modelPickerDescription(
  model: ModelInfo,
  source: "apiKey" | "oauth" | "extension",
): string {
  const authentication =
    source === "oauth"
      ? (accountLoginProviders.find((provider) => provider.id === model.provider)?.description ??
        "account")
      : source === "apiKey"
        ? "API key"
        : "extension";
  return model.name ? `${model.name} · ${authentication}` : authentication;
}

const PREFERRED_ACCOUNT_MODELS: Readonly<Record<string, string>> = {
  "openai-codex": "gpt-5.6-sol",
  "github-copilot": "gpt-5.3-codex",
  "kimi-coding": "kimi-for-coding",
  openrouter: "auto",
  xai: "grok-4.3",
};

export function preferredProviderModel(
  provider: string,
  models: readonly ModelInfo[],
): ModelInfo | undefined {
  const providerModels = models.filter((model) => model.provider === provider);
  const preferred = PREFERRED_ACCOUNT_MODELS[provider];
  return (
    (preferred ? providerModels.find((model) => model.id === preferred) : undefined) ??
    providerModels[0]
  );
}

function isMarkdownCommandRun(data: unknown): data is MarkdownCommandRun {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "markdown-command" &&
    typeof (data as { prompt?: unknown }).prompt === "string"
  );
}

export function registerDeclaredRenderers(
  registry: RendererRegistry,
  renderers: Iterable<readonly [string, ToolRenderer]>,
): void {
  for (const [name, renderer] of renderers) {
    const adapter: ToolRendererFn = (info) =>
      renderer.render({
        toolName: info.toolName,
        args: info.args,
        ...(info.result
          ? {
              result: {
                content: info.result.content,
                ...(info.result.details !== undefined ? { details: info.result.details } : {}),
                ...(info.result.isError ? { isError: true } : {}),
              },
            }
          : {}),
      });
    registry.register(name, adapter);
  }
}

export async function runInteractive(
  args: ParsedArgs,
  options: AgentOptions = {},
  modelCatalog?: ModelCatalog,
): Promise<number> {
  const terminal = new Terminal();
  if (!terminal.isTty) {
    process.stderr.write("mu: not a terminal — use -p for headless mode\n");
    return 2;
  }

  const modelRef = await resolveCliModel(args.model);
  const useBuiltIns = !options.tools;
  let profileCommands: Command[] = [];
  let profileRenderers: Record<string, ToolRenderer> = {};
  let profile: Profile | undefined;
  let resolved = options;
  if (!options.tools) {
    profile = await resolveProfile(args.profile ?? DEFAULT_PROFILE, profileOptionsFromArgs(args));
    for (const diagnostic of profile.diagnostics ?? []) {
      process.stderr.write(`mu: instruction warning: ${diagnostic}\n`);
    }
    profileCommands = profile.commands ?? [];
    profileRenderers = profile.renderers ?? {};
    resolved = await optionsFromProfile(profile, modelRef, options);
    if (!resolved.session) {
      resolved = { ...resolved, session: await sessionStoreForProfile(profile) };
    }
  }
  resolved = withStoredCredentials(resolved);

  const basePermissions: PermissionRule[] = [...(resolved.permissions ?? [])];
  let activePermissionMode: PermissionMode | undefined;
  if (profile) {
    try {
      activePermissionMode = args.allowAll
        ? profile.permissionModes?.find((mode) => mode.id === "yolo")
        : permissionModeFor(profile, args.permissionMode);
    } catch (error) {
      process.stderr.write(`mu: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  } else if (args.permissionMode) {
    process.stderr.write("mu: --permission-mode requires a profile with permission modes\n");
    return 2;
  }
  resolved = {
    ...resolved,
    permissions: args.allowAll
      ? [...basePermissions, { permission: "*", pattern: "*", action: "allow" }]
      : rulesForPermissionMode(basePermissions, activePermissionMode),
  };

  const builtIns = useBuiltIns
    ? await loadBuiltInExtensions(process.cwd(), resolved.extensions)
    : { host: resolved.extensions ?? new ExtensionHost(), warnings: [] };
  const extensions = builtIns.host;

  const pendingPermissions = new Map<
    string,
    {
      request: PermissionRequest;
      resolve: (outcome: "allow" | "deny") => void;
    }
  >();
  const agent = new Agent({
    ...resolved,
    extensions,
    model: modelRef,
    onPermission: (request) =>
      new Promise<"allow" | "deny">((resolve) =>
        pendingPermissions.set(request.id, { request, resolve }),
      ),
  });
  let sessionResumable = false;
  try {
    sessionResumable = await initializeInteractiveSession(agent, args.resumeSessionId);
  } catch (error) {
    await agent.shutdown();
    process.stderr.write(
      `mu: could not resume ${args.resumeSessionId}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 2;
  }

  const registry = new RendererRegistry();
  registry.registerAll(codingRenderers);
  registerDeclaredRenderers(registry, Object.entries(profileRenderers));
  registerDeclaredRenderers(registry, extensions.renderers);
  const depth = detectColorDepth();
  let app: App;
  const commands = registryWithCoreCommands({
    requestCompaction: (focus) => agent.compactNow(focus),
    usage: () => ({
      ...agent.usage,
      contextPercent: agent.contextPercent,
    }),
    undo: () => agent.undo(),
    redo: () => agent.redo(),
    fork: (entryId) => agent.fork(entryId),
    forkPoints: () => agent.forkPoints(),
    diff: () => agent.sessionDiff(),
  });
  for (const command of profileCommands) commands.register(command);
  for (const command of extensions.commands.list()) commands.register(command);

  const renderer = new FullScreenRenderer(terminal);
  let exiting = false;
  let activeRun: Promise<void> | undefined;
  let activeShell: Promise<void> | undefined;
  let shellController: AbortController | undefined;
  let loginController: AbortController | undefined;
  const shellTool =
    resolved.tools?.find((candidate) => candidate.name === "bash") ??
    bashTool({ root: process.cwd() });

  // Leaving must not strand an in-flight run or a permission promise: abort the
  // run and deny anything still waiting, or the process lingers after the UI
  // is gone.
  const shutdown = () => {
    loginController?.abort();
    shellController?.abort();
    modelCatalog?.stop();
    agent.stop();
    for (const [id, pending] of pendingPermissions) {
      pending.resolve("deny");
      pendingPermissions.delete(id);
    }
  };

  app = new App({
    width: terminal.columns,
    height: terminal.rows,
    depth,
    model: modelRef,
    cwd: formatCwdForFooter(process.cwd(), process.env.HOME ?? process.env.USERPROFILE),
    contextWindow: agent.contextWindow,
    thinkingLevels: agent.thinkingLevels,
    registry,
    callbacks: {
      onSubmit: (text) => {
        // A second concurrent run would share the Agent's abort controller,
        // session and usage totals. Mid-run input is steering, which is what
        // the loop's steering queue exists for.
        if (activeShell) {
          commitLines(["  A shell command is already running; press Esc to cancel it."]);
          paint();
        } else if (activeRun || agent.isRunning) agent.send(text);
        else beginRun(text);
      },
      onSteer: (text) => {
        if (activeShell) {
          commitLines(["  A shell command is already running; press Esc to cancel it."]);
          paint();
          return false;
        }
        agent.send(text);
        return true;
      },
      onFollowUp: (text) => {
        if (activeShell) {
          commitLines(["  A shell command is already running; press Esc to cancel it."]);
          paint();
          return false;
        }
        agent.followUp(text);
        return true;
      },
      onEditQueued: (kind, text) => agent.removeQueuedMessage(kind, text),
      onShell: (command) => beginUserShell(command),
      onAbort: () => {
        if (shellController) shellController.abort();
        else agent.abort();
      },
      onExit: () => {
        exiting = true;
        shutdown();
      },
      onCommand: (text) => {
        if (activeShell) {
          commitLines(["  Wait for the shell command to finish, or press Esc to cancel it."]);
          paint();
          return;
        }
        void runCommand(text);
      },
      onMentionQuery: (query) => mentionCandidates(query),
      onThinkingChange: (level) => agent.setThinking(level as ThinkingLevel),
      onPermissionReply: (id, outcome, remember) => {
        const pending = pendingPermissions.get(id);
        if (!pending) return;
        if (outcome === "allow" && remember) {
          const rule: PermissionRule = {
            permission: pending.request.permission,
            pattern: pending.request.pattern,
            action: "allow",
          };
          basePermissions.push(rule);
          agent.addPermissionRule(rule);
          void Promise.resolve(profile?.rememberPermission?.(rule.permission, rule.pattern)).catch(
            (error) => {
              commitLines([
                `  could not remember permission: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ]);
              paint();
            },
          );
        }
        pending.resolve(outcome);
        pendingPermissions.delete(id);
      },
    },
  });
  // User- and project-authored markdown commands join the built-ins.
  for (const markdown of await loadMarkdownCommands({ projectDir: process.cwd() })) {
    commands.register(toCommand(markdown));
  }
  // /model and /resume open selection lists rather than needing exact typing.
  commands.register({
    name: "model",
    description: "Switch the active model",
    run: async () => {
      if (activeRun || agent.isRunning) {
        return { handled: true, message: "Cannot switch models during a run." };
      }
      let refresh: ModelCatalogRefreshResult | undefined;
      if (modelCatalog && !modelCatalog.hasFreshModels) {
        commitLines(["  refreshing model catalog…"]);
        paint();
        refresh = await modelCatalog.ensureFresh();
        if (!refresh.ok) {
          commitLines([
            `  model discovery failed · showing ${refresh.fallback} catalog`,
            `  ${refresh.error}`,
          ]);
        } else if (refresh.cacheWarning) {
          commitLines([`  ${refresh.cacheWarning}`]);
        }
      }
      let auth: Awaited<ReturnType<typeof readAuthFile>>;
      try {
        auth = await readAuthFile();
      } catch (error) {
        return {
          handled: true,
          message: `Could not read saved authentication: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      const authenticatedProviders = new Set(Object.keys(auth.providers));
      const models = availableModels(extensions, authenticatedProviders);
      if (models.length === 0) {
        return { handled: true, message: "No authenticated models. Run /login first." };
      }
      const source = refresh && !refresh.ok ? ` · ${refresh.fallback}` : "";
      app.openPicker({
        title: `select a model · ${models.length} available${source}`,
        filterable: true,
        items: models.map((model) => {
          const ref = `${model.provider}/${model.id}`;
          const credential = auth.providers[model.provider];
          return {
            label: ref,
            description: modelPickerDescription(
              model,
              credential?.type ?? (extensions.models.has(ref) ? "extension" : "apiKey"),
            ),
          };
        }),
        onChoose: async (label) => {
          agent.setModel(label);
          app.setModel(label, agent.contextWindow);
          app.setThinking(agent.thinking, agent.thinkingLevels);
          try {
            await saveDefaultModel(label);
            commitLines([`  model set to ${label} · saved as default`]);
          } catch (error) {
            commitLines([
              `  model set to ${label}`,
              `  could not save default: ${error instanceof Error ? error.message : String(error)}`,
            ]);
          }
          paint();
        },
        onBack: () => app.openCommandMenu(),
      });
      return { handled: true };
    },
  });
  commands.register({
    name: "login",
    description: "Configure provider authentication",
    run: (ctx) => {
      if (ctx.args.trim()) {
        return { handled: true, message: "Run /login, then choose an authentication method." };
      }
      if (activeRun || agent.isRunning) {
        return { handled: true, message: "Cannot change authentication during a run." };
      }
      openLoginMethodPicker();
      return { handled: true };
    },
  });
  commands.register({
    name: "logout",
    description: "Remove provider authentication",
    run: async (ctx) => {
      if (ctx.args.trim()) {
        return { handled: true, message: "Run /logout, then choose a provider." };
      }
      if (activeRun || agent.isRunning) {
        return { handled: true, message: "Cannot change authentication during a run." };
      }
      let auth: Awaited<ReturnType<typeof readAuthFile>>;
      try {
        auth = await readAuthFile();
      } catch (error) {
        return {
          handled: true,
          message: `Could not read saved authentication: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      const providers = logoutProviders(auth);
      if (providers.length === 0) {
        return {
          handled: true,
          message:
            "No stored credentials to remove. /logout only removes credentials saved by /login; environment variables are unchanged.",
        };
      }
      app.openPicker({
        title: "Select provider to log out:",
        filterable: true,
        items: providers.map((provider) => ({
          label: provider.name,
          description: provider.description,
          value: provider.id,
        })),
        onChoose: (provider) => void logoutProvider(provider, providers),
        onBack: () => app.openCommandMenu(),
      });
      return { handled: true };
    },
  });
  commands.register({
    name: "permissions",
    description: "Choose what mu is allowed to do",
    run: () => {
      const modes = profile?.permissionModes ?? [];
      if (modes.length === 0) {
        return { handled: true, message: "This profile does not define permission modes." };
      }
      app.openPicker({
        title: "update permissions",
        items: modes.map((mode) => ({
          label: mode.label,
          description: `${mode.description}${mode.id === activePermissionMode?.id ? " · current" : ""}`,
        })),
        onChoose: (label) => {
          const mode = modes.find((candidate) => candidate.label === label);
          if (!mode || !profile) return;
          agent.setPermissions(rulesForPermissionMode(basePermissions, mode));
          activePermissionMode = mode;
          commitLines([`  permissions set to ${mode.label} · this session`]);
          paint();
        },
        onBack: () => app.openCommandMenu(),
      });
      return { handled: true };
    },
  });
  commands.register({
    name: "resume",
    description: "Resume an earlier session",
    run: async () => {
      if (activeRun || agent.isRunning) {
        return { handled: true, message: "Cannot resume during a run." };
      }
      const sessions = await resumePickerItems(agent.sessionStore);
      if (sessions.length === 0) return { handled: true, message: "No saved sessions." };
      app.openPicker({
        title: "resume a session",
        filterable: true,
        items: sessions,
        onChoose: (sessionId) => {
          void (async () => {
            try {
              if (activeRun || agent.isRunning) {
                commitLines(["  Cannot resume during a run."]);
                paint();
                return;
              }
              const tree = await agent.sessionStore.load(sessionId);
              if (!tree) {
                commitLines([`  no such session: ${sessionId}`]);
                paint();
                return;
              }
              if (activeRun || agent.isRunning) {
                commitLines(["  Cannot resume during a run."]);
                paint();
                return;
              }
              agent.resume(tree);
              sessionResumable = true;
              app.setModel(agent.modelRef, agent.contextWindow);
              app.setThinking(agent.thinking, agent.thinkingLevels);
              app.replaceTranscript(tree.messagesAt(), app.banner());
              commitLines([`  resumed ${sessionId}`]);
            } catch (error) {
              commitLines([
                `  Could not resume ${sessionId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ]);
            }
            paint();
          })();
        },
        onBack: () => app.openCommandMenu(),
      });
      return { handled: true };
    },
  });
  commands.register({
    name: "new",
    description: "Clear the terminal and start a new chat",
    run: () => {
      if (activeRun || agent.isRunning) {
        return { handled: true, message: "Cannot start a new chat during a run." };
      }
      startNewInteractiveSession(agent, app, renderer);
      sessionResumable = false;
      return { handled: true };
    },
  });
  commands.register(
    transcriptExportCommand({
      getSession: () => agent.session,
      getSessionId: () => agent.sessionId,
      getModel: () => agent.modelRef,
      isRunning: () => Boolean(activeRun || agent.isRunning),
      save: async (markdown, requestedPath, now) =>
        (
          await saveTranscriptMarkdown(markdown, {
            cwd: process.cwd(),
            requestedPath,
            now,
          })
        ).displayPath,
    }),
  );

  app.setCommands(commands.list().map((c) => ({ label: c.name, description: c.description })));

  // Layout is intentionally deferred into the renderer's throttled frame.
  // Provider streams often deliver several deltas in one frame interval; an
  // eager app.renderScreen() here would parse and wrap every discarded state.
  const paint = () => renderer.requestRender(() => app.renderScreen());
  const commitLines = (lines: string[]) => {
    app.appendTranscript(lines);
    paint();
  };
  const unsubscribe = agent.subscribe((event) => {
    app.handleEvent(event);
    paint();
  });

  // Shallow file listing for the `@` popup — bounded so a huge tree cannot
  // stall a keystroke.
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next"]);
  function mentionCandidates(query: string): { label: string }[] {
    const root = process.cwd();
    const out: { label: string }[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3 || out.length >= 50) return;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names.sort()) {
        if (name.startsWith(".") || SKIP.has(name)) continue;
        const full = join(dir, name);
        try {
          if (statSync(full).isDirectory()) walk(full, depth + 1);
          else {
            const rel = relative(root, full);
            if (query.length === 0 || rel.includes(query)) out.push({ label: rel });
          }
        } catch {
          // unreadable entry — skip
        }
        if (out.length >= 50) return;
      }
    };
    walk(root, 0);
    return out;
  }

  function beginRun(text: string, options?: AgentRunOptions): void {
    if (activeShell) {
      commitLines(["  A shell command is already running; press Esc to cancel it."]);
      paint();
      return;
    }
    if (activeRun || agent.isRunning) {
      commitLines(["  A run is already active; submit text to steer it."]);
      paint();
      return;
    }
    activeRun = startRun(text, options).finally(() => {
      activeRun = undefined;
    });
  }

  function beginUserShell(command: string): void {
    if (activeRun || agent.isRunning) {
      commitLines(["  Wait for the agent turn to finish before running a shell command."]);
      paint();
      return;
    }
    if (activeShell) {
      commitLines(["  A shell command is already running; press Esc to cancel it."]);
      paint();
      return;
    }

    const controller = new AbortController();
    shellController = controller;
    activeShell = (async () => {
      const dispatch = (event: Parameters<App["handleEvent"]>[0]) => {
        app.handleEvent(event);
        paint();
      };

      dispatch({ type: "agent_start" });
      try {
        const result = await runUserShellCommand(shellTool, command, controller.signal, dispatch);
        agent.session.appendMessage(
          customMessage("user_shell_command", formatUserShellRecord(command, result)),
        );
        try {
          await agent.sessionStore.save(agent.sessionId, agent.session);
          sessionResumable = true;
        } catch (error) {
          commitLines([
            `  shell result could not be saved to the session: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ]);
        }
      } finally {
        dispatch({ type: "agent_end", messages: [], reason: "done" });
      }
    })().finally(() => {
      if (shellController === controller) shellController = undefined;
      activeShell = undefined;
      paint();
    });
  }

  function openLoginMethodPicker(): void {
    app.openPicker({
      title: "Select authentication method:",
      items: loginMethods.map(({ label, description }) => ({ label, description })),
      onChoose: (label) => {
        const method = loginMethods.find((candidate) => candidate.label === label);
        if (method?.id === "account") openAccountProviderPicker();
        else if (method?.id === "apiKey") openApiKeyProviderPicker();
      },
      onBack: () => app.openCommandMenu(),
    });
  }

  function openAccountProviderPicker(): void {
    app.openPicker({
      title: "Select account provider:",
      items: accountLoginProviders.map((provider) => ({
        label: provider.name,
        description: provider.description,
      })),
      onChoose: (label) => {
        const provider = accountLoginProviders.find((candidate) => candidate.name === label);
        if (provider) void signInWithAccount(provider);
      },
      onBack: openLoginMethodPicker,
    });
  }

  function openApiKeyProviderPicker(): void {
    const providers = apiKeyLoginProviders();
    app.openPicker({
      title: "Select API key provider:",
      items: providers.map(({ name }) => ({ label: name })),
      filterable: true,
      onChoose: (label) => {
        const provider = providers.find((candidate) => candidate.name === label);
        if (!provider) return;
        app.openPrompt({
          title: `Enter API key for ${provider.name}:`,
          secret: true,
          onSubmit: (apiKey) => void storeApiKey(provider.id, provider.name, apiKey),
          onCancel: openApiKeyProviderPicker,
        });
      },
      onBack: openLoginMethodPicker,
    });
  }

  async function selectProviderModel(provider: string): Promise<void> {
    const model = preferredProviderModel(provider, availableModels(extensions));
    if (!model) return;
    const ref = `${model.provider}/${model.id}`;
    agent.setModel(ref);
    app.setModel(ref, agent.contextWindow);
    app.setThinking(agent.thinking, agent.thinkingLevels);
    try {
      await saveDefaultModel(ref);
    } catch (error) {
      commitLines([
        `  could not save ${ref} as the default model: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ]);
    }
  }

  async function storeApiKey(provider: string, label: string, apiKey: string): Promise<void> {
    try {
      await saveApiKey(provider, apiKey);
      await refreshCatalogAfterLogin();
      await selectProviderModel(provider);
      commitLines([`  Saved API key for ${label}.`, `  model set to ${agent.modelRef}`]);
    } catch (error) {
      commitLines([
        `  Could not save API key for ${label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ]);
    }
    paint();
  }

  async function logoutProvider(
    providerId: string,
    providers: ReturnType<typeof logoutProviders>,
  ): Promise<void> {
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    try {
      const removed = await removeStoredCredential(provider.id);
      if (!removed) {
        commitLines([`  No stored credentials found for ${provider.name}.`]);
      } else if (provider.credentialType === "oauth") {
        commitLines([`  Logged out of ${provider.name}.`]);
      } else {
        commitLines([
          `  Removed stored API key for ${provider.name}. Environment variables are unchanged.`,
        ]);
      }
    } catch (error) {
      commitLines([
        `  Could not log out of ${provider.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ]);
    }
    paint();
  }

  function openBrowser(url: string): boolean {
    const command =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    try {
      Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
      return true;
    } catch {
      return false;
    }
  }

  let loginInProgress = false;

  async function refreshCatalogAfterLogin(): Promise<void> {
    if (!modelCatalog) return;
    commitLines(["  refreshing model catalog…"]);
    paint();
    // If startup discovery is still running, let it finish before issuing the
    // credential-aware refresh. Otherwise refresh() would only join the stale
    // unauthenticated request.
    if (modelCatalog.isRefreshing) await modelCatalog.refresh();
    const result = await modelCatalog.refresh();
    if (!result.ok) {
      commitLines([
        `  model discovery failed · using ${result.fallback} catalog`,
        `  ${result.error}`,
      ]);
      return;
    }
    for (const warning of result.warnings ?? []) {
      commitLines([`  model discovery warning · ${warning}`]);
    }
    if (result.cacheWarning) commitLines([`  ${result.cacheWarning}`]);
  }

  async function signInWithAccount(provider: AccountLoginProvider): Promise<void> {
    if (loginInProgress) {
      commitLines(["  A login is already in progress."]);
      paint();
      return;
    }
    loginInProgress = true;
    const controller = new AbortController();
    loginController = controller;
    try {
      await provider.login({
        signal: controller.signal,
        onDeviceCode: (_url, code) => {
          commitLines([`  device code · ${code}`]);
          paint();
        },
        onAuthUrl: (url) => {
          commitLines(formatAuthUrl(url, openBrowser(url), provider.name, depth));
          paint();
        },
      });
      await refreshCatalogAfterLogin();
      await selectProviderModel(provider.id);
      commitLines([`  ${provider.successMessage}`, `  model set to ${agent.modelRef}`]);
    } catch (error) {
      commitLines([
        `  ${provider.name} login failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ]);
    } finally {
      if (loginController === controller) loginController = undefined;
      loginInProgress = false;
      paint();
    }
  }

  async function startRun(text: string, options?: AgentRunOptions): Promise<void> {
    try {
      await agent.run(text, options);
      sessionResumable = true;
    } catch (error) {
      commitLines([`  ${error instanceof Error ? error.message : String(error)}`]);
    }
    paint();
  }

  async function runCommand(text: string): Promise<void> {
    const result = await commands.execute(text, {
      inject: (message) => {
        if (message.role === "custom" && message.content[0]?.type === "text") {
          agent.followUp(message.content[0].text);
        }
      },
      print: (output) => commitLines([`  ${output}`]),
      getModel: () => agent.modelRef,
      setModel: () => {},
    });
    const data = result.data as
      | CheckpointActionData
      | DiffCommandData
      | { kind: "fork-points"; points: { id: string; description: string }[] }
      | { kind: "compaction"; status: string }
      | MarkdownCommandRun
      | undefined;
    if (data?.kind === "checkpoint") {
      if (data.action === "undo" && data.prompt !== undefined) {
        app.editor.setText(data.prompt);
      } else if (data.action === "redo") {
        app.editor.setText("");
      }
      commitLines(renderCheckpointCommand(data, terminal.columns, depth));
    } else if (data?.kind === "diff") {
      commitLines(renderDiffCommand(data, terminal.columns, depth));
    } else if (data?.kind === "fork-points") {
      app.openPicker({
        title: "fork from",
        items: data.points.map((point) => ({
          label: point.id,
          description: point.description,
        })),
        onChoose: (entryId) => {
          void (async () => {
            const forked = await agent.fork(entryId);
            commitLines([`  ${forked.message}`]);
            paint();
          })();
        },
        onBack: () => app.openCommandMenu(),
      });
    } else if (isMarkdownCommandRun(data)) {
      beginRun(data.prompt, {
        ...(data.model ? { model: data.model } : {}),
        ...(data.allowedTools ? { allowedTools: data.allowedTools } : {}),
      });
    } else if (data?.kind === "compaction" && data.status !== "queued") {
      // Standalone compaction reports its durable boundary through AgentEvent;
      // avoid printing the same outcome twice in the interactive transcript.
    } else if (result.message) {
      commitLines([`  ${result.message}`]);
    }
    paint();
  }

  terminal.onExit = () => {
    shutdown();
    if (sessionResumable) {
      terminal.write(`\r\n${formatResumeHint(agent.sessionId, depth)}\r\n`);
    }
  };
  terminal.start();
  terminal.setTitle(formatTerminalTitle(process.cwd()));
  app.setModel(agent.modelRef, agent.contextWindow);
  app.setThinking(agent.thinking, agent.thinkingLevels);
  if (args.resumeSessionId) {
    app.replaceTranscript(agent.session.messagesAt(), app.banner());
  } else {
    commitLines(app.banner());
  }
  if (builtIns.warnings.length > 0) {
    commitLines(builtIns.warnings.map((warning) => `  ${warning}`));
  }
  const stopResize = terminal.onResize(() => {
    app.setSize(terminal.columns, terminal.rows);
    agent.resize(terminal.columns, terminal.rows);
    renderer.renderNow(app.renderScreen());
  });
  agent.resize(terminal.columns, terminal.rows);

  const spinnerTimer = setInterval(() => {
    if (app.isRunning) {
      app.tickSpinner();
      paint();
    }
  }, SPINNER_INTERVAL_MS);

  const decoder = new InputDecoder();
  process.stdin.setEncoding("utf8");

  // A lone ESC is held to disambiguate it from an escape sequence; without an
  // idle flush it would never become an Escape key press, so Esc could not
  // abort a running turn.
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleEscapeFlush = () => {
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = setTimeout(() => {
      const event = decoder.flushPendingEscape();
      if (event) {
        app.handleInput(event);
        paint();
      }
    }, 30);
  };

  paint();

  try {
    for await (const chunk of process.stdin) {
      for (const event of decoder.push(String(chunk))) app.handleInput(event);
      if (decoder.pending.length > 0) scheduleEscapeFlush();
      paint();
      if (exiting) break;
    }
  } finally {
    if (escapeTimer) clearTimeout(escapeTimer);
    shutdown();
    // Let the aborted run unwind before the terminal is handed back, so it
    // cannot repaint over a restored screen.
    await Promise.all([activeRun?.catch(() => {}), activeShell?.catch(() => {})]);
    await agent.shutdown();
    unsubscribe();
    clearInterval(spinnerTimer);
    stopResize();
    renderer.renderNow([
      ...app.renderTranscript(),
      ...(sessionResumable ? ["", formatResumeHint(agent.sessionId, depth), ""] : []),
    ]);
    renderer.stop();
    terminal.restore();
  }
  return 0;
}
