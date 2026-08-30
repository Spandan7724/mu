import { readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { bashTool } from "@mu/profile-coding";
import {
  App,
  type ColorDepth,
  type ConversationSource,
  CTRL_C_EXIT_WINDOW_MS,
  checkpointCell,
  codingRenderers,
  detectColorDepth,
  diffCell,
  diffLinesFromHunks,
  FullScreenRenderer,
  formatCwdForFooter,
  formatKeybindings,
  hyperlink,
  InputDecoder,
  type PickerRequest,
  RendererRegistry,
  type RenderFrame,
  type Style,
  styleText,
  subagentRenderers,
  Terminal,
  type ToolRendererFn,
  terminalRows,
} from "@mu/tui";
import {
  type Agent,
  type AgentOptions,
  type AgentRunOptions,
  type CheckpointActionData,
  customMessage,
  type DiffCommandData,
  defaultModelId,
  loadMarkdownCommands,
  type MarkdownCommandRun,
  type ModelInfo,
  type PermissionMode,
  type PermissionModeTone,
  providerConfig,
  readAuthFile,
  removeStoredCredential,
  type SideConversation,
  saveApiKey,
  startSideConversation,
  type ThinkingLevel,
  type ToolRenderer,
  toCommand,
  type UndoPointsCommandData,
} from "mu";
import cliPackage from "../package.json";
import { agentViewPaths, isProcessAlive, readSessionOwnership } from "./agent-view-store.ts";
import type { ParsedArgs } from "./args.ts";
import { saveDefaultModel } from "./config.ts";
import { transcriptExportCommand } from "./export-command.ts";
import { observeGitBranch } from "./git-branch.ts";
import {
  type AccountLoginProvider,
  accountLoginProviders,
  apiKeyLoginProviders,
  loginMethods,
  logoutProviders,
} from "./login.ts";
import type { ModelCatalog } from "./model-catalog.ts";
import { availableModels, modelPickerDescription } from "./model-picker.ts";
import { nextPermissionMode, rulesForPermissionMode } from "./permissions.ts";
import { resumePickerItems } from "./session-picker.ts";
import { createCliSessionRuntime } from "./session-runtime.ts";
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
      turnCount: data.turnCount ?? 1,
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

const PERMISSION_TONE_STYLES: Record<PermissionModeTone, Style> = {
  restrictive: { link: true },
  permissive: { permissive: true },
  unrestricted: { red: true },
};

export function formatPermissionMode(mode: PermissionMode, depth: ColorDepth): string {
  // Bold as well as coloured: the four modes have to stay apart under NO_COLOR
  // and for anyone who does not separate them by hue.
  const style = {
    ...(mode.tone ? PERMISSION_TONE_STYLES[mode.tone] : { accent: true }),
    bold: true,
  };
  const suffix = styleText(" · this session", { dim: true }, depth);
  return `  permissions set to ${styleText(mode.label, style, depth)}${suffix}`;
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
    "setModel" | "setThinking" | "handleEvent" | "replaceTranscript" | "banner" | "renderFrame"
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
  renderer.renderNow(app.renderFrame());
  return agent.sessionId;
}

export { availableModels, modelPickerDescription } from "./model-picker.ts";

// Post-login selection resolves the same default as startup. Keeping a second
// table here let the two drift: providers listed only in the catalog's table
// were picked by refreshed-catalog order after login, which models.dev owns.
export function preferredProviderModel(
  provider: string,
  models: readonly ModelInfo[],
): ModelInfo | undefined {
  const providerModels = models.filter((model) => model.provider === provider);
  const preferred = defaultModelId(provider);
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

  let runtime: Awaited<ReturnType<typeof createCliSessionRuntime>>;
  try {
    runtime = await createCliSessionRuntime({
      cwd: process.cwd(),
      profile: args.profile,
      model: args.model,
      permissionMode: args.permissionMode,
      allowAll: args.allowAll,
      noInstructions: args.noInstructions,
      resumeSessionId: args.resumeSessionId,
      agentOptions: options,
      permissions: "forward",
      onDiagnostic: (message) => process.stderr.write(`mu: ${message}\n`),
    });
  } catch (error) {
    process.stderr.write(
      `mu: could not start interactive session: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const { agent, profile, extensions, commands, basePermissions } = runtime;
  const modelRef = agent.modelRef;
  const resolved = runtime.agentOptions;
  const profileRenderers: Record<string, ToolRenderer> = profile?.renderers ?? {};
  let activePermissionMode: PermissionMode | undefined = runtime.permissionMode;
  let sessionResumable = Boolean(args.resumeSessionId);

  const registry = new RendererRegistry();
  registry.registerAll(subagentRenderers);
  if (profile?.name === "coding") registry.registerAll(codingRenderers);
  registerDeclaredRenderers(registry, Object.entries(profileRenderers));
  registerDeclaredRenderers(registry, extensions.renderers);
  const depth = detectColorDepth();
  let app: App;
  const renderer = new FullScreenRenderer(terminal);
  let stopGitBranch = () => {};
  let exiting = false;
  let activeRun: Promise<void> | undefined;
  let sideRun: Promise<void> | undefined;
  let sideConversation: SideConversation | undefined;
  let unsubscribeSide: (() => void) | undefined;
  let closingSide: Promise<void> | undefined;
  let sidePermissionMode: PermissionMode | undefined;
  const sidePermissions = new Map<
    string,
    {
      request: Parameters<NonNullable<AgentOptions["onPermission"]>>[0];
      resolve: (outcome: "allow" | "deny") => void;
    }
  >();
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
    stopGitBranch();
    loginController?.abort();
    shellController?.abort();
    modelCatalog?.stop();
    agent.stop();
    sideConversation?.agent.stop();
    runtime.cancelPermissions();
    for (const [id, item] of sidePermissions) {
      sidePermissions.delete(id);
      item.resolve("deny");
    }
  };

  const activeAgent = () =>
    app?.activeConversation === "side" && sideConversation ? sideConversation.agent : agent;
  const activeRunPromise = () => (app?.activeConversation === "side" ? sideRun : activeRun);

  app = new App({
    width: terminal.columns,
    height: terminal.rows,
    depth,
    model: modelRef,
    version: cliPackage.version,
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
          return false;
        }
        if (activeRunPromise() || activeAgent().isRunning) activeAgent().send(text);
        else beginRun(text);
        return true;
      },
      onSteer: (text) => {
        if (activeShell) {
          commitLines(["  A shell command is already running; press Esc to cancel it."]);
          paint();
          return false;
        }
        activeAgent().send(text);
        return true;
      },
      onFollowUp: (text) => {
        if (activeShell) {
          commitLines(["  A shell command is already running; press Esc to cancel it."]);
          paint();
          return false;
        }
        activeAgent().followUp(text);
        return true;
      },
      onEditQueued: (kind, text) => activeAgent().removeQueuedMessage(kind, text),
      onShell: (command) => beginUserShell(command),
      onAbort: () => {
        if (shellController) shellController.abort();
        else activeAgent().abort();
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
      onThinkingChange: (level) => activeAgent().setThinking(level as ThinkingLevel),
      onCyclePermissionMode: () => cyclePermissionMode(),
      onPermissionReply: (id, outcome, remember, source) => {
        if (source === "side") {
          const pending = sidePermissions.get(id);
          if (!pending || !sideConversation) return;
          sidePermissions.delete(id);
          if (outcome === "allow" && remember) {
            sideConversation.agent.addPermissionRule({
              permission: pending.request.permission,
              pattern: pending.request.pattern,
              action: "allow",
            });
          }
          pending.resolve(outcome);
          return;
        }
        const pending = runtime.pendingPermissions.get(id);
        if (!pending) return;
        runtime.resolvePermission(id, outcome, remember);
      },
      onCloseSide: () => void closeSideConversation(),
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
      const source = app.activeConversation;
      const target = activeAgent();
      if (activeRunPromise() || target.isRunning) {
        return { handled: true, message: "Cannot switch models during a run." };
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
      const pickerItems = () =>
        availableModels(extensions, authenticatedProviders).map((model) => {
          const ref = `${model.provider}/${model.id}`;
          const credential = auth.providers[model.provider];
          return {
            label: ref,
            description: modelPickerDescription(
              model,
              credential?.type ??
                (extensions.models.has(ref)
                  ? "extension"
                  : providerConfig(model.provider)?.auth === "none"
                    ? "local"
                    : "apiKey"),
            ),
          };
        });
      const items = pickerItems();
      const refreshing = modelCatalog !== undefined && !modelCatalog.hasFreshModels;
      if (items.length === 0 && !refreshing) {
        return { handled: true, message: "No authenticated models. Run /login first." };
      }
      const picker: PickerRequest = {
        title: `select a model · ${items.length} available${refreshing ? " · refreshing" : ""}`,
        filterable: true,
        items,
        onChoose: async (label) => {
          target.setModel(label);
          app.setModel(label, target.contextWindow, source);
          app.setThinking(target.thinking, target.thinkingLevels, source);
          if (source === "side") {
            commitLines([`  side model set to ${label}`], source);
            paint();
            return;
          }
          try {
            await saveDefaultModel(label);
            commitLines([`  model set to ${label} · saved as default`], source);
          } catch (error) {
            commitLines(
              [
                `  model set to ${label}`,
                `  could not save default: ${error instanceof Error ? error.message : String(error)}`,
              ],
              source,
            );
          }
          paint();
        },
        onBack: () => app.openCommandMenu(),
      };
      app.openPicker(picker);
      if (refreshing) {
        void modelCatalog.ensureFresh().then((refresh) => {
          if (exiting) return;
          const refreshedItems = pickerItems();
          const suffix = refresh.ok ? "" : ` · ${refresh.fallback}`;
          const updated = app.updatePicker(picker, {
            title: `select a model · ${refreshedItems.length} available${suffix}`,
            items: refreshedItems,
          });
          let diagnosed = false;
          if (!refresh.ok) {
            commitLines(
              [
                `  model discovery failed · showing ${refresh.fallback} catalog`,
                `  ${refresh.error}`,
              ],
              source,
            );
            diagnosed = true;
          } else if (refresh.cacheWarning) {
            commitLines([`  ${refresh.cacheWarning}`], source);
            diagnosed = true;
          }
          if (updated || diagnosed) paint();
        });
      }
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
      const source = app.activeConversation;
      const currentMode = source === "side" ? sidePermissionMode : activePermissionMode;
      const modes = profile?.permissionModes ?? [];
      if (modes.length === 0) {
        return { handled: true, message: "This profile does not define permission modes." };
      }
      app.openPicker({
        title: "update permissions",
        items: modes.map((mode) => ({
          label: mode.label,
          description: `${mode.description}${mode.id === currentMode?.id ? " · current" : ""}`,
        })),
        onChoose: (label) => {
          const mode = modes.find((candidate) => candidate.label === label);
          if (mode) applyPermissionMode(mode, source);
        },
        onBack: () => app.openCommandMenu(),
      });
      return { handled: true };
    },
  });
  commands.register({
    name: "resume",
    description: "Resume an earlier session",
    sessionScoped: true,
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
              const ownership = await readSessionOwnership(agentViewPaths(), sessionId);
              if (ownership) {
                commitLines([
                  isProcessAlive(ownership.supervisorPid)
                    ? `  ${sessionId} is live in agent view · exit and run mu --resume ${sessionId}`
                    : `  ${sessionId} has a stale runtime owner · open mu agents to recover it safely`,
                ]);
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
              commitLines([`  resumed ${sessionId}`, ""]);
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
    sessionScoped: true,
    run: () => {
      if (activeRun || agent.isRunning) {
        return { handled: true, message: "Cannot start a new chat during a run." };
      }
      startNewInteractiveSession(agent, app, renderer);
      sessionResumable = false;
      return { handled: true };
    },
  });
  commands.register({
    name: "keybindings",
    description: "List every keybinding",
    run: (ctx) => {
      ctx.print(formatKeybindings());
      return { handled: true };
    },
  });
  commands.register(
    transcriptExportCommand({
      getSession: () => activeAgent().session,
      getSessionId: () => activeAgent().sessionId,
      getModel: () => activeAgent().modelRef,
      isRunning: () => Boolean(activeRunPromise() || activeAgent().isRunning),
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
  if (profile?.name === "coding") {
    commands.register({
      name: "btw",
      description: "Start an ephemeral side conversation",
      run: (ctx) => {
        if (sideConversation || closingSide) {
          return { handled: true, message: "A side conversation is already open." };
        }
        openSideConversation(ctx.args.trim() || undefined);
        return { handled: true };
      },
    });
  }

  app.setCommands(commands.list().map((c) => ({ label: c.name, description: c.description })));

  // Layout is intentionally deferred into the renderer's throttled frame.
  // Provider streams often deliver several deltas in one frame interval; an
  // eager app.renderScreen() here would parse and wrap every discarded state.
  const paint = () => renderer.requestRender(() => app.renderFrame());
  const paintInput = () => renderer.renderNow(app.renderFrame());
  const commitLines = (lines: string[], source: ConversationSource = app.activeConversation) => {
    app.appendTranscript(lines, source);
    paint();
  };
  const unsubscribe = agent.subscribe((event) => {
    app.handleEvent(event, "main");
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

  function applyPermissionMode(mode: PermissionMode, source = app.activeConversation): void {
    const target = source === "side" ? sideConversation?.agent : agent;
    if (!target) return;
    target.setPermissions(rulesForPermissionMode(basePermissions, mode));
    if (source === "side") sidePermissionMode = mode;
    else activePermissionMode = mode;
    commitLines([formatPermissionMode(mode, depth)], source);
    paint();
  }

  function cyclePermissionMode(): void {
    const source = app.activeConversation;
    const current = source === "side" ? sidePermissionMode : activePermissionMode;
    const next = nextPermissionMode(profile?.permissionModes ?? [], current);
    if (next) applyPermissionMode(next, source);
  }

  function beginRun(text: string, options?: AgentRunOptions): void {
    const source = app.activeConversation;
    const target = activeAgent();
    if (activeShell) {
      commitLines(["  A shell command is already running; press Esc to cancel it."], source);
      paint();
      return;
    }
    const running = source === "side" ? sideRun : activeRun;
    if (running || target.isRunning) {
      commitLines(["  A run is already active; submit text to steer it."], source);
      paint();
      return;
    }
    const run = startRun(target, source, text, options).finally(() => {
      if (source === "side") sideRun = undefined;
      else activeRun = undefined;
    });
    if (source === "side") sideRun = run;
    else activeRun = run;
  }

  function openSideConversation(question?: string): void {
    try {
      const restrictive = (profile?.permissionModes ?? []).find(
        (mode) => mode.tone === "restrictive",
      );
      const permissions = restrictive
        ? rulesForPermissionMode(basePermissions, restrictive)
        : rulesForPermissionMode(basePermissions, activePermissionMode);
      sidePermissionMode = restrictive ?? activePermissionMode;
      const conversation = startSideConversation(
        {
          ...resolved,
          model: agent.modelRef,
          thinkingLevel: agent.thinking,
          extensions,
          permissions,
          onPermission: (request) =>
            new Promise<"allow" | "deny">((resolve) => {
              sidePermissions.set(request.id, { request, resolve });
            }),
        },
        {
          messages: agent.session.messagesAt(),
          ...(profile?.sideBoundary ? { boundary: profile.sideBoundary() } : {}),
          permissions,
        },
      );
      sideConversation = conversation;
      unsubscribeSide = conversation.agent.subscribe((event) => {
        app.handleEvent(event, "side");
        paint();
      });
      app.openSideConversation(
        conversation.agent.modelRef,
        conversation.agent.contextWindow,
        conversation.agent.thinkingLevels,
      );
      app.setThinking(conversation.agent.thinking, conversation.agent.thinkingLevels, "side");
      paint();
      if (question) beginRun(question);
    } catch (error) {
      sideConversation = undefined;
      sidePermissionMode = undefined;
      commitLines(
        [
          `  Could not start side conversation: ${error instanceof Error ? error.message : String(error)}`,
        ],
        "main",
      );
    }
  }

  async function closeSideConversation(): Promise<void> {
    if (closingSide) return closingSide;
    const conversation = sideConversation;
    if (!conversation) return;
    app.closeSideConversation();
    unsubscribeSide?.();
    unsubscribeSide = undefined;
    for (const [id, item] of sidePermissions) {
      sidePermissions.delete(id);
      item.resolve("deny");
    }
    sideConversation = undefined;
    sidePermissionMode = undefined;
    paint();
    closingSide = conversation.close().finally(() => {
      closingSide = undefined;
      paint();
    });
    return closingSide;
  }

  function beginUserShell(command: string): void {
    const source = app.activeConversation;
    const target = activeAgent();
    const running = source === "side" ? sideRun : activeRun;
    if (running || target.isRunning) {
      commitLines(["  Wait for the agent turn to finish before running a shell command."], source);
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
        app.handleEvent(event, source);
        paint();
      };

      dispatch({ type: "agent_start" });
      try {
        const result = await runUserShellCommand(shellTool, command, controller.signal, dispatch);
        target.session.appendMessage(
          customMessage("user_shell_command", formatUserShellRecord(command, result)),
        );
        try {
          await target.sessionStore.save(target.sessionId, target.session);
          if (source === "main") sessionResumable = true;
        } catch (error) {
          commitLines(
            [
              `  shell result could not be saved to the session: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ],
            source,
          );
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

  async function startRun(
    target: Agent,
    source: ConversationSource,
    text: string,
    options?: AgentRunOptions,
  ): Promise<void> {
    try {
      await target.run(text, options);
      if (source === "main") sessionResumable = true;
    } catch (error) {
      app.discardPendingSubmissions(source);
      commitLines([`  ${error instanceof Error ? error.message : String(error)}`], source);
    }
    paint();
  }

  async function runCommand(text: string): Promise<void> {
    const source = app.activeConversation;
    const target = activeAgent();
    const parsed = commands.parse(text);
    const command = parsed ? commands.get(parsed.name) : undefined;
    if (source === "side" && command?.sessionScoped) {
      commitLines([`  /${parsed?.name} is not available in a side conversation.`], source);
      return;
    }
    const result = await commands.execute(text, {
      inject: (message) => {
        if (message.role === "custom" && message.content[0]?.type === "text") {
          target.followUp(message.content[0].text);
        }
      },
      print: (output) => commitLines([`  ${output}`], source),
      getModel: () => target.modelRef,
      setModel: () => {},
    });
    const data = result.data as
      | CheckpointActionData
      | DiffCommandData
      | UndoPointsCommandData
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
      commitLines(renderCheckpointCommand(data, terminal.columns, depth), source);
    } else if (data?.kind === "undo-points") {
      app.openPicker({
        title: "undo through prompt",
        items: data.points.map((point) => ({
          label: point.prompt.replace(/\s+/g, " ").trim() || "(empty prompt)",
          description: `undo ${point.steps} prompt${point.steps === 1 ? "" : "s"}`,
          value: String(point.steps),
        })),
        onChoose: (steps) => void runCommand(`/undo ${steps}`),
        onBack: () => app.openCommandMenu(),
      });
    } else if (data?.kind === "diff") {
      commitLines(renderDiffCommand(data, terminal.columns, depth), source);
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
      commitLines([`  ${result.message}`], source);
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
  stopGitBranch = await observeGitBranch(process.cwd(), (branch) => {
    app.setFooterStatus(branch);
    paint();
  });
  app.setModel(agent.modelRef, agent.contextWindow);
  app.setThinking(agent.thinking, agent.thinkingLevels);
  if (args.resumeSessionId) {
    app.replaceTranscript(agent.session.messagesAt(), app.banner());
    // Startup resume happens before the event subscription exists, so the
    // restored context has to be handed to the footer directly.
    app.handleEvent({
      type: "usage_updated",
      sessionTotals: agent.usage,
      contextTokens: agent.contextTokens,
      contextPercent: agent.contextPercent,
    });
  } else {
    commitLines(app.banner());
  }
  if (runtime.warnings.length > 0) {
    commitLines(runtime.warnings.map((warning) => `  ${warning}`));
  }
  const stopResize = terminal.onResize(() => {
    app.setSize(terminal.columns, terminal.rows);
    agent.resize(terminal.columns, terminal.rows);
    renderer.renderNow(app.renderFrame());
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
        paintInput();
      }
    }, 30);
  };

  // An idle Ctrl+C arms a "press again to exit" hint; without a follow-up
  // repaint the hint would stay on screen past the window if the user never
  // touches the keyboard again.
  let ctrlCHintTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleCtrlCHintClear = () => {
    if (ctrlCHintTimer) clearTimeout(ctrlCHintTimer);
    ctrlCHintTimer = setTimeout(paint, CTRL_C_EXIT_WINDOW_MS + 10);
  };

  paint();

  try {
    for await (const chunk of process.stdin) {
      for (const event of decoder.push(String(chunk))) app.handleInput(event);
      if (decoder.pending.length > 0) scheduleEscapeFlush();
      if (app.ctrlCPending) scheduleCtrlCHintClear();
      paintInput();
      if (exiting) break;
    }
  } finally {
    exiting = true;
    if (escapeTimer) clearTimeout(escapeTimer);
    if (ctrlCHintTimer) clearTimeout(ctrlCHintTimer);
    shutdown();
    // Let the aborted run unwind before the terminal is handed back, so it
    // cannot repaint over a restored screen.
    await Promise.all([
      activeRun?.catch(() => {}),
      sideRun?.catch(() => {}),
      activeShell?.catch(() => {}),
    ]);
    await closeSideConversation();
    await closingSide;
    await agent.shutdown();
    unsubscribe();
    clearInterval(spinnerTimer);
    stopResize();
    const transcript = app.renderTranscript("main");
    const finalFrame: RenderFrame = {
      transcript,
      managed: sessionResumable
        ? terminalRows(["", formatResumeHint(agent.sessionId, depth), ""], terminal.columns)
        : [],
      dirtyFrom: transcript.length,
    };
    renderer.renderNow(finalFrame);
    renderer.stop();
    terminal.restore();
  }
  return 0;
}
