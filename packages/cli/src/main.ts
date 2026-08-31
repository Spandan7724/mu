#!/usr/bin/env bun
import { createCredentialResolver, findModel } from "mu";
import cliPackage from "../package.json";
import { runAgentSupervisor } from "./agent-supervisor.ts";
import { AgentViewClient } from "./agent-view-client.ts";
import { agentViewPaths, isProcessAlive, readSessionOwnership } from "./agent-view-store.ts";
import { runAgentWorker } from "./agent-worker.ts";
import { runAgentView } from "./agents-app.ts";
import { HELP_TEXT, parseArgs } from "./args.ts";
import { loadUserConfig } from "./config.ts";
import { EXIT, runHeadless } from "./headless.ts";
import { runInteractive } from "./interactive.ts";
import {
  initializeModelCatalog,
  type ModelCatalog,
  modelCatalogDiagnostics,
} from "./model-catalog.ts";
import { linesFrom, runRpc } from "./rpc.ts";
import { runSelfUninstall, runSelfUpdate } from "./self-update.ts";
import { createCliSessionRuntime } from "./session-runtime.ts";

const VERSION = cliPackage.version;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const io = {
    stdout: (chunk: string) => process.stdout.write(chunk),
    stderr: (chunk: string) => process.stderr.write(chunk),
  };

  if (args.errors.length > 0) {
    for (const error of args.errors) io.stderr(`mu: ${error}\n`);
    io.stderr(HELP_TEXT);
    return EXIT.usage;
  }

  if (
    args.resumeSessionId &&
    (args.mode === "tui" || args.mode === "headless" || args.mode === "rpc")
  ) {
    const ownership = await readSessionOwnership(agentViewPaths(), args.resumeSessionId).catch(
      (error) => {
        io.stderr(
          `mu: could not validate session ownership: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return "invalid" as const;
      },
    );
    if (ownership === "invalid") return EXIT.usage;
    if (ownership) {
      if (!isProcessAlive(ownership.supervisorPid)) {
        io.stderr(
          `mu: session ${args.resumeSessionId} has a stale runtime owner; open "mu agents" to recover it safely\n`,
        );
        return EXIT.usage;
      }
      if (args.mode === "tui") {
        return runAgentView(args, {
          initialSessionId: args.resumeSessionId,
          exitAfterDetach: true,
        });
      }
      io.stderr(
        `mu: session ${args.resumeSessionId} is live in agent view; attach interactively with "mu --resume ${args.resumeSessionId}"\n`,
      );
      return EXIT.usage;
    }
  }

  let modelCatalog: ModelCatalog | undefined;
  if (
    args.mode === "tui" ||
    args.mode === "headless" ||
    args.mode === "rpc" ||
    args.mode === "agents" ||
    args.mode === "agents-worker"
  ) {
    modelCatalog = await initializeModelCatalog({
      getCredentials: createCredentialResolver(),
      clientVersion: VERSION,
    });
    const configured = args.model ?? (await loadUserConfig()).model;
    const needsConfiguredModel =
      typeof configured === "string" && configured.length > 0 && !findModel(configured);
    // Interactive surfaces can render from the cache/bundled catalog while the
    // refresh started by initializeModelCatalog continues in the background.
    // Managed workers receive an explicit model and must become ready before
    // the supervisor's startup deadline, so they must not wait on discovery.
    if (
      !["tui", "agents", "agents-worker"].includes(args.mode) ||
      (args.mode !== "agents-worker" && needsConfiguredModel)
    ) {
      const result = await modelCatalog.ensureFresh();
      for (const diagnostic of modelCatalogDiagnostics(result, {
        includePartialWarnings: args.mode !== "headless",
      })) {
        io.stderr(`mu: ${diagnostic}\n`);
      }
    }
  }

  try {
    switch (args.mode) {
      case "help":
        io.stdout(HELP_TEXT);
        return 0;
      case "version":
        io.stdout(`mu ${VERSION}\n`);
        return 0;
      case "self-update":
        return runSelfUpdate(
          {
            currentVersion: VERSION,
            packageName: cliPackage.name,
            entryPath: process.argv[1],
            execPath: process.execPath,
          },
          io,
        );
      case "self-uninstall":
        return runSelfUninstall(
          {
            packageName: cliPackage.name,
            entryPath: process.argv[1],
            execPath: process.execPath,
            purgeData: args.purgeData,
          },
          io,
        );
      case "headless":
        return runHeadless(args, {}, io);
      case "agents":
        return runAgentView(args);
      case "agents-stop": {
        const client = new AgentViewClient({
          scope: "supervisor-control",
          cwd: process.cwd(),
        });
        try {
          await client.connect(false);
        } catch (error) {
          if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            io.stdout("agent supervisor is not running\n");
            return 0;
          }
          throw error;
        }
        try {
          await client.shutdownSupervisor();
          io.stdout("agent supervisor stopping\n");
        } finally {
          client.close();
        }
        return 0;
      }
      case "agents-supervisor":
        return runAgentSupervisor(args);
      case "agents-worker":
        return runAgentWorker(args);
      case "rpc": {
        const runtime = await createCliSessionRuntime({
          cwd: process.cwd(),
          profile: args.profile,
          model: args.model,
          permissionMode: args.permissionMode,
          allowAll: args.allowAll,
          noInstructions: args.noInstructions,
          resumeSessionId: args.resumeSessionId,
          maxTurns: args.maxTurns,
          maxCostUsd: args.maxCostUsd,
          permissions: "forward",
          onDiagnostic: (message) => io.stderr(`mu: ${message}\n`),
        });
        const { agent } = runtime;
        const resumeSession = async (sessionId: string) => {
          const tree = await agent.sessionStore.load(sessionId);
          if (!tree) throw new Error(`Session not found: ${sessionId}`);
          agent.resume(tree);
        };

        try {
          await runRpc(
            { write: io.stdout, lines: linesFrom(process.stdin) },
            {
              agent,
              runCommand: async (text) => {
                const result = await runtime.commands.execute(text, {
                  inject: () => {},
                  print: () => {},
                  getModel: () => agent.modelRef,
                  setModel: (ref) => agent.setModel(ref),
                });
                return result;
              },
              resolvePermission: runtime.resolvePermission,
              cancelPermissions: runtime.cancelPermissions,
              resumeSession,
            },
          );
        } finally {
          runtime.cancelPermissions();
          await agent.shutdown();
        }
        return 0;
      }
      default:
        return runInteractive(args, {}, modelCatalog);
    }
  } catch (error) {
    io.stderr(`mu: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.error;
  } finally {
    modelCatalog?.stop();
  }
}

process.exitCode = await main();
