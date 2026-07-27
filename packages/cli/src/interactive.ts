import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  App,
  codingRenderers,
  detectColorDepth,
  InlineRenderer,
  InputDecoder,
  RendererRegistry,
  Terminal,
} from "@mu/tui";
import {
  Agent,
  type AgentOptions,
  defaultModelRef,
  defaultSkillRoots,
  discoverSkills,
  ExtensionHost,
  listModels,
  loadMarkdownCommands,
  optionsFromProfile,
  registryWithCoreCommands,
  skillsExtension,
  toCommand,
} from "mu";
import type { ParsedArgs } from "./args.ts";
import { DEFAULT_PROFILE, resolveProfile } from "./profiles.ts";

const SPINNER_INTERVAL_MS = 120;

export async function runInteractive(
  args: ParsedArgs,
  options: AgentOptions = {},
): Promise<number> {
  const terminal = new Terminal();
  if (!terminal.isTty) {
    process.stderr.write("mu: not a terminal — use -p for headless mode\n");
    return 2;
  }

  const modelRef = args.model ?? defaultModelRef();
  let resolved = options;
  if (!options.tools) {
    const profile = await resolveProfile(args.profile ?? DEFAULT_PROFILE);
    resolved = await optionsFromProfile(profile, modelRef, options);
  }

  // Skills are a built-in extension: discovered from ~/.mu/skills and the
  // project, then exposed to the model through the public extension API.
  const extensions = new ExtensionHost();
  const skills = await discoverSkills(defaultSkillRoots(process.cwd()));
  if (skills.length > 0) await extensions.register(skillsExtension(skills));

  const pendingPermissions = new Map<string, (outcome: "allow" | "deny") => void>();
  const agent = new Agent({
    extensions,
    ...resolved,
    model: modelRef,
    onPermission: (request) =>
      new Promise<"allow" | "deny">((resolve) => pendingPermissions.set(request.id, resolve)),
  });

  const registry = new RendererRegistry();
  registry.registerAll(codingRenderers);
  const commands = registryWithCoreCommands({
    requestCompaction: () => agent.requestCompaction(),
    usage: () => ({
      costUsd: agent.usage.costUsd ?? 0,
      contextPercent: agent.contextPercent,
    }),
    undo: () => agent.undo(),
    redo: () => agent.redo(),
    diff: async () =>
      (await agent.sessionDiff()).map((file) => ({
        path: file.path,
        added: file.added,
        removed: file.removed,
      })),
  });

  const renderer = new InlineRenderer(terminal);
  let exiting = false;
  let activeRun: Promise<void> | undefined;

  // Leaving must not strand an in-flight run or a permission promise: abort the
  // run and deny anything still waiting, or the process lingers after the UI
  // is gone.
  const shutdown = () => {
    agent.abort();
    for (const [id, resolve] of pendingPermissions) {
      resolve("deny");
      pendingPermissions.delete(id);
    }
  };

  const app = new App({
    width: terminal.columns,
    depth: detectColorDepth(),
    model: modelRef,
    registry,
    callbacks: {
      onSubmit: (text) => {
        // A second concurrent run would share the Agent's abort controller,
        // session and usage totals. Mid-run input is steering, which is what
        // the loop's steering queue exists for.
        if (activeRun) agent.send(text);
        else
          activeRun = startRun(text).finally(() => {
            activeRun = undefined;
          });
      },
      onAbort: () => agent.abort(),
      onExit: () => {
        exiting = true;
        shutdown();
      },
      onCommand: (text) => void runCommand(text),
      onMentionQuery: (query) => mentionCandidates(query),
      onThinkingChange: (level) => agent.setThinking(level as "off" | "low" | "medium" | "high"),
      onPermissionReply: (id, outcome) => {
        pendingPermissions.get(id)?.(outcome);
        pendingPermissions.delete(id);
      },
    },
  });
  // User- and project-authored markdown commands join the built-ins.
  for (const markdown of await loadMarkdownCommands({ projectDir: process.cwd() })) {
    commands.register(toCommand(markdown, (prompt) => void startRun(prompt)));
  }
  // /model and /resume open selection lists rather than needing exact typing.
  commands.register({
    name: "model",
    description: "Switch the active model",
    run: () => {
      app.openPicker({
        title: "select a model",
        items: listModels().map((m) => ({
          label: `${m.provider}/${m.id}`,
          description: m.name ?? "",
        })),
        onChoose: (label) => {
          agent.setModel(label);
          app.setModel(label);
          renderer.commit([`  model set to ${label}`]);
          paint();
        },
      });
      return { handled: true };
    },
  });
  commands.register({
    name: "resume",
    description: "Resume an earlier session",
    run: async () => {
      const sessions = await agent.sessionStore.list();
      if (sessions.length === 0) return { handled: true, message: "No saved sessions." };
      app.openPicker({
        title: "resume a session",
        items: sessions.map((id) => ({ label: id })),
        onChoose: (label) => {
          void (async () => {
            const tree = await agent.sessionStore.load(label);
            if (!tree) {
              renderer.commit([`  no such session: ${label}`]);
              paint();
              return;
            }
            // Replay the transcript into scrollback so the user sees what they
            // are resuming, then continue that session.
            for (const message of tree.messagesAt()) {
              const lines = app.handleEvent({ type: "message_end", message });
              if (lines.length > 0) renderer.commit(lines);
            }
            agent.resume(tree);
            renderer.commit([`  resumed ${label}`]);
            paint();
          })();
        },
      });
      return { handled: true };
    },
  });

  app.setCommands(commands.list().map((c) => ({ label: c.name, description: c.description })));

  const paint = () => renderer.render(app.renderBottom());

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

  async function startRun(text: string): Promise<void> {
    const stream = agent.stream(text);
    for await (const event of stream) {
      const lines = app.handleEvent(event);
      if (lines.length > 0) renderer.commit(lines);
      paint();
    }
    await stream.result().catch(() => {});
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
      getModel: () => modelRef,
      setModel: () => {},
    });
    if (result.message) renderer.commit([`  ${result.message}`]);
    paint();
  }

  terminal.onExit = () => shutdown();
  terminal.start();
  app.setModel(agent.modelRef);
  app.setThinking(agent.thinking);
  renderer.commit(app.banner());
  const stopResize = terminal.onResize(() => {
    app.setWidth(terminal.columns);
    renderer.renderNow(app.renderBottom());
  });

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
    await activeRun?.catch(() => {});
    clearInterval(spinnerTimer);
    stopResize();
    renderer.stop();
    renderer.clear();
    terminal.restore();
  }
  return 0;
}
