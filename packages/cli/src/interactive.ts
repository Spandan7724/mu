import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { bashTool } from "@mu/profile-coding";
import {
  App,
  type ColorDepth,
  checkpointCell,
  codingRenderers,
  detectColorDepth,
  diffCell,
  diffLinesFromHunks,
  formatCwdForFooter,
  InlineRenderer,
  InputDecoder,
  RendererRegistry,
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
  registryWithCoreCommands,
  saveApiKey,
  type ToolRenderer,
  toCommand,
} from "mu";
import type { ParsedArgs } from "./args.ts";
import { withStoredCredentials } from "./auth.ts";
import { resolveCliModel, saveDefaultModel } from "./config.ts";
import { loadBuiltInExtensions } from "./extensions.ts";
import {
  type AccountLoginProvider,
  accountLoginProviders,
  apiKeyLoginProviders,
  loginMethods,
} from "./login.ts";
import type { ModelCatalog, ModelCatalogRefreshResult } from "./model-catalog.ts";
import { permissionModeFor, rulesForPermissionMode } from "./permissions.ts";
import { DEFAULT_PROFILE, resolveProfile, sessionStoreForProfile } from "./profiles.ts";
import { formatUserShellRecord, runUserShellCommand } from "./user-shell.ts";

const SPINNER_INTERVAL_MS = 120;

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

export function availableModels(extensions: ExtensionHost): ModelInfo[] {
  const models = new Map<string, ModelInfo>(
    listModels().map((model) => [`${model.provider}/${model.id}`, model] as const),
  );
  for (const [ref, model] of extensions.models) models.set(ref, model);
  return [...models.values()];
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
    profile = await resolveProfile(args.profile ?? DEFAULT_PROFILE);
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

  const registry = new RendererRegistry();
  registry.registerAll(codingRenderers);
  registerDeclaredRenderers(registry, Object.entries(profileRenderers));
  registerDeclaredRenderers(registry, extensions.renderers);
  const depth = detectColorDepth();
  let app: App;
  const commands = registryWithCoreCommands({
    requestCompaction: () => agent.requestCompaction(),
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

  const renderer = new InlineRenderer(terminal);
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
    registry,
    callbacks: {
      onSubmit: (text) => {
        // A second concurrent run would share the Agent's abort controller,
        // session and usage totals. Mid-run input is steering, which is what
        // the loop's steering queue exists for.
        if (activeShell) {
          renderer.commit(["  A shell command is already running; press Esc to cancel it."]);
          paint();
        } else if (activeRun || agent.isRunning) agent.send(text);
        else beginRun(text);
      },
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
          renderer.commit(["  Wait for the shell command to finish, or press Esc to cancel it."]);
          paint();
          return;
        }
        void runCommand(text);
      },
      onMentionQuery: (query) => mentionCandidates(query),
      onThinkingChange: (level) => agent.setThinking(level as "off" | "low" | "medium" | "high"),
      onPermissionReply: (id, outcome, remember) => {
        const pending = pendingPermissions.get(id);
        if (!pending) return;
        if (outcome === "allow" && remember) {
          const rule: PermissionRule = {
            permission: pending.request.toolName,
            pattern: pending.request.pattern,
            action: "allow",
          };
          basePermissions.push(rule);
          agent.addPermissionRule(rule);
          void Promise.resolve(profile?.rememberPermission?.(rule.permission, rule.pattern)).catch(
            (error) => {
              renderer.commit([
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
        renderer.commit(["  refreshing model catalog…"]);
        paint();
        refresh = await modelCatalog.ensureFresh();
        if (!refresh.ok) {
          renderer.commit([
            `  model discovery failed · showing ${refresh.fallback} catalog`,
            `  ${refresh.error}`,
          ]);
        } else if (refresh.cacheWarning) {
          renderer.commit([`  ${refresh.cacheWarning}`]);
        }
      }
      const models = availableModels(extensions);
      const source = refresh && !refresh.ok ? ` · ${refresh.fallback}` : "";
      app.openPicker({
        title: `select a model · ${models.length} available${source}`,
        filterable: true,
        items: models.map((m) => ({
          label: `${m.provider}/${m.id}`,
          description: m.name ?? "",
        })),
        onChoose: async (label) => {
          agent.setModel(label);
          app.setModel(label, agent.contextWindow);
          try {
            await saveDefaultModel(label);
            renderer.commit([`  model set to ${label} · saved as default`]);
          } catch (error) {
            renderer.commit([
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
    name: "permissions",
    description: "Choose what mu is allowed to do",
    run: () => {
      if (activeRun || agent.isRunning) {
        return { handled: true, message: "Cannot change permissions during a run." };
      }
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
          renderer.commit([`  permissions set to ${mode.label} · this session`]);
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
      const sessions = await agent.sessionStore.list();
      if (sessions.length === 0) return { handled: true, message: "No saved sessions." };
      app.openPicker({
        title: "resume a session",
        items: sessions.map((id) => ({ label: id })),
        onChoose: (label) => {
          void (async () => {
            try {
              if (activeRun || agent.isRunning) {
                renderer.commit(["  Cannot resume during a run."]);
                paint();
                return;
              }
              const tree = await agent.sessionStore.load(label);
              if (!tree) {
                renderer.commit([`  no such session: ${label}`]);
                paint();
                return;
              }
              if (activeRun || agent.isRunning) {
                renderer.commit(["  Cannot resume during a run."]);
                paint();
                return;
              }
              agent.resume(tree);
              // Replay the transcript into scrollback so the user sees what
              // became the active session.
              for (const message of tree.messagesAt()) {
                const lines = app.handleEvent({ type: "message_end", message });
                if (lines.length > 0) renderer.commit(lines);
              }
              app.setModel(agent.modelRef, agent.contextWindow);
              app.setThinking(agent.thinking);
              renderer.commit([`  resumed ${label}`]);
            } catch (error) {
              renderer.commit([
                `  Could not resume ${label}: ${error instanceof Error ? error.message : String(error)}`,
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

  app.setCommands(commands.list().map((c) => ({ label: c.name, description: c.description })));

  const paint = () => renderer.render(app.renderBottom());
  const unsubscribe = agent.subscribe((event) => {
    const lines = app.handleEvent(event);
    if (lines.length > 0) renderer.commit(lines);
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
      renderer.commit(["  A shell command is already running; press Esc to cancel it."]);
      paint();
      return;
    }
    if (activeRun || agent.isRunning) {
      renderer.commit(["  A run is already active; submit text to steer it."]);
      paint();
      return;
    }
    activeRun = startRun(text, options).finally(() => {
      activeRun = undefined;
    });
  }

  function beginUserShell(command: string): void {
    if (activeRun || agent.isRunning) {
      renderer.commit(["  Wait for the agent turn to finish before running a shell command."]);
      paint();
      return;
    }
    if (activeShell) {
      renderer.commit(["  A shell command is already running; press Esc to cancel it."]);
      paint();
      return;
    }

    const controller = new AbortController();
    shellController = controller;
    activeShell = (async () => {
      const dispatch = (event: Parameters<App["handleEvent"]>[0]) => {
        const lines = app.handleEvent(event);
        if (lines.length > 0) renderer.commit(lines);
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
        } catch (error) {
          renderer.commit([
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
    const model = availableModels(extensions).find((candidate) => candidate.provider === provider);
    if (!model) return;
    const ref = `${model.provider}/${model.id}`;
    agent.setModel(ref);
    app.setModel(ref, agent.contextWindow);
    try {
      await saveDefaultModel(ref);
    } catch (error) {
      renderer.commit([
        `  could not save ${ref} as the default model: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ]);
    }
  }

  async function storeApiKey(provider: string, label: string, apiKey: string): Promise<void> {
    try {
      await saveApiKey(provider, apiKey);
      await selectProviderModel(provider);
      renderer.commit([`  Saved API key for ${label}.`, `  model set to ${agent.modelRef}`]);
    } catch (error) {
      renderer.commit([
        `  Could not save API key for ${label}: ${
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
  async function signInWithAccount(provider: AccountLoginProvider): Promise<void> {
    if (loginInProgress) {
      renderer.commit(["  A login is already in progress."]);
      paint();
      return;
    }
    loginInProgress = true;
    const controller = new AbortController();
    loginController = controller;
    try {
      await provider.login({
        signal: controller.signal,
        onAuthUrl: (url) => {
          const opened = openBrowser(url);
          renderer.commit([
            opened
              ? "  Complete the OpenAI sign-in in your browser."
              : "  Could not open a browser. Open this URL to continue:",
            `  ${url}`,
          ]);
          paint();
        },
      });
      await selectProviderModel(provider.id);
      renderer.commit([`  ${provider.successMessage}`, `  model set to ${agent.modelRef}`]);
    } catch (error) {
      renderer.commit([
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
    await agent.run(text, options).catch((error) => {
      renderer.commit([`  ${error instanceof Error ? error.message : String(error)}`]);
    });
    paint();
  }

  async function runCommand(text: string): Promise<void> {
    const result = await commands.execute(text, {
      inject: (message) => {
        if (message.role === "custom" && message.content[0]?.type === "text") {
          agent.followUp(message.content[0].text);
        }
      },
      print: (output) => renderer.commit([`  ${output}`]),
      getModel: () => agent.modelRef,
      setModel: () => {},
    });
    const data = result.data as
      | CheckpointActionData
      | DiffCommandData
      | { kind: "fork-points"; points: { id: string; description: string }[] }
      | MarkdownCommandRun
      | undefined;
    if (data?.kind === "checkpoint") {
      if (data.action === "undo" && data.prompt !== undefined) {
        app.editor.setText(data.prompt);
      } else if (data.action === "redo") {
        app.editor.setText("");
      }
      renderer.commit(renderCheckpointCommand(data, terminal.columns, depth));
    } else if (data?.kind === "diff") {
      renderer.commit(renderDiffCommand(data, terminal.columns, depth));
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
            renderer.commit([`  ${forked.message}`]);
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
    } else if (result.message) {
      renderer.commit([`  ${result.message}`]);
    }
    paint();
  }

  terminal.onExit = () => shutdown();
  terminal.start();
  app.setModel(agent.modelRef, agent.contextWindow);
  app.setThinking(agent.thinking);
  renderer.commit(app.banner());
  if (builtIns.warnings.length > 0) {
    renderer.commit(builtIns.warnings.map((warning) => `  ${warning}`));
  }
  const stopResize = terminal.onResize(() => {
    app.setSize(terminal.columns, terminal.rows);
    agent.resize(terminal.columns, terminal.rows);
    renderer.renderNow(app.renderBottom());
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
    renderer.stop();
    renderer.clear();
    terminal.restore();
  }
  return 0;
}
