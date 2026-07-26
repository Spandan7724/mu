import {
  App,
  codingRenderers,
  detectColorDepth,
  InlineRenderer,
  InputDecoder,
  RendererRegistry,
  Terminal,
} from "@mu/tui";
import { Agent, type AgentOptions, optionsFromProfile, registryWithCoreCommands } from "mu";
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

  const modelRef = args.model ?? "anthropic/claude-opus-5";
  let resolved = options;
  if (!options.tools) {
    const profile = await resolveProfile(args.profile ?? DEFAULT_PROFILE);
    resolved = await optionsFromProfile(profile, modelRef, options);
  }

  const pendingPermissions = new Map<string, (outcome: "allow" | "deny") => void>();
  const agent = new Agent({
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

  const app = new App({
    width: terminal.columns,
    depth: detectColorDepth(),
    model: modelRef,
    registry,
    callbacks: {
      onSubmit: (text) => void startRun(text),
      onAbort: () => agent.abort(),
      onExit: () => {
        exiting = true;
      },
      onCommand: (text) => void runCommand(text),
      onPermissionReply: (id, outcome) => {
        pendingPermissions.get(id)?.(outcome);
        pendingPermissions.delete(id);
      },
    },
  });
  app.setCommands(commands.list().map((c) => ({ label: c.name, description: c.description })));

  const paint = () => renderer.render(app.renderBottom());

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

  terminal.start();
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
  paint();

  try {
    for await (const chunk of process.stdin) {
      for (const event of decoder.push(String(chunk))) app.handleInput(event);
      paint();
      if (exiting) break;
    }
  } finally {
    clearInterval(spinnerTimer);
    stopResize();
    renderer.stop();
    renderer.clear();
    terminal.restore();
  }
  return 0;
}
