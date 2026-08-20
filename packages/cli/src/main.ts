#!/usr/bin/env bun
import {
  createCliSessionRuntime,
  EXIT,
  initializeModelCatalog,
  linesFrom,
  loadUserConfig,
  type ModelCatalog,
  modelCatalogDiagnostics,
  parseArgs,
  runHeadless,
  runInteractive,
  runRpc,
} from "@mu/cli-runtime";
import { createCredentialResolver, findModel } from "mu";
import cliPackage from "../package.json";
import { runAgentSupervisor } from "./agent-supervisor.ts";
import { agentViewPaths, isProcessAlive, readSessionOwnership } from "./agent-view-store.ts";
import { runAgentWorker } from "./agent-worker.ts";
import { runAgentView } from "./agents-app.ts";
import { userConfigPath } from "./data.ts";
import { codingProduct, HELP_TEXT } from "./product.ts";
import { runSelfUninstall, runSelfUpdate } from "./self-update.ts";

const VERSION = codingProduct.version;
const PACKAGE_NAME = cliPackage.name;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), codingProduct);
  const io = {
    stdout: (chunk: string) => process.stdout.write(chunk),
    stderr: (chunk: string) => process.stderr.write(chunk),
  };

  if (args.errors.length > 0) {
    for (const error of args.errors) io.stderr(`mu: ${error}\n`);
    io.stderr(HELP_TEXT);
    return EXIT.usage;
  }

  const surface = args.mode === "tui" || args.mode === "headless" || args.mode === "rpc";
  if (args.resumeSessionId && surface) {
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

  const needsCatalog =
    surface || args.productCommand === "agents" || args.productCommand === "agents-worker";
  let modelCatalog: ModelCatalog | undefined;
  if (needsCatalog) {
    modelCatalog = await initializeModelCatalog({
      cacheFile: codingProduct.data.modelCatalogFile(),
      getCredentials: createCredentialResolver(),
      clientVersion: VERSION,
    });
    const configured = args.model ?? (await loadUserConfig(userConfigPath())).model;
    const needsConfiguredModel =
      typeof configured === "string" && configured.length > 0 && !findModel(configured);
    if (args.mode !== "tui" || needsConfiguredModel) {
      const result = await modelCatalog.ensureFresh();
      for (const diagnostic of modelCatalogDiagnostics(result, {
        includePartialWarnings: args.mode !== "headless",
      })) {
        io.stderr(`mu: ${diagnostic}\n`);
      }
    }
  }

  try {
    switch (args.productCommand) {
      case "self-update":
        return runSelfUpdate(
          {
            currentVersion: VERSION,
            packageName: PACKAGE_NAME,
            entryPath: process.argv[1],
            execPath: process.execPath,
          },
          io,
        );
      case "self-uninstall":
        return runSelfUninstall(
          {
            packageName: PACKAGE_NAME,
            entryPath: process.argv[1],
            execPath: process.execPath,
            purgeData: args.product.purgeData,
          },
          io,
        );
      case "agents":
        return runAgentView(args);
      case "agents-supervisor":
        return runAgentSupervisor(args);
      case "agents-worker":
        return runAgentWorker(args);
      default:
        break;
    }

    switch (args.mode) {
      case "help":
        io.stdout(HELP_TEXT);
        return 0;
      case "version":
        io.stdout(`mu ${VERSION}\n`);
        return 0;
      case "headless":
        return runHeadless(codingProduct, args, {}, io);
      case "rpc": {
        const runtime = await createCliSessionRuntime({
          cwd: process.cwd(),
          product: codingProduct,
          productOptions: args.product,
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
        return runInteractive(codingProduct, args, {
          ...(modelCatalog ? { modelCatalog } : {}),
          ownership: { check: describeSessionOwner },
        });
    }
  } catch (error) {
    io.stderr(`mu: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.error;
  } finally {
    modelCatalog?.stop();
  }
}

// Interactive /resume must not open a session the agent-view supervisor owns.
async function describeSessionOwner(sessionId: string): Promise<string | undefined> {
  const ownership = await readSessionOwnership(agentViewPaths(), sessionId);
  if (!ownership) return undefined;
  return isProcessAlive(ownership.supervisorPid)
    ? `${sessionId} is live in agent view · exit and run mu --resume ${sessionId}`
    : `${sessionId} has a stale runtime owner · open mu agents to recover it safely`;
}

process.exitCode = await main();
