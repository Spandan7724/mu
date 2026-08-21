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
import { runBrowserDoctor } from "./doctor.ts";
import { BROWSER_COMMAND, browserProduct, HELP_TEXT } from "./product.ts";

const VERSION = browserProduct.version;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), browserProduct);
  const io = {
    stdout: (chunk: string) => process.stdout.write(chunk),
    stderr: (chunk: string) => process.stderr.write(chunk),
  };

  if (args.errors.length > 0) {
    for (const error of args.errors) io.stderr(`${BROWSER_COMMAND}: ${error}\n`);
    io.stderr(HELP_TEXT);
    return EXIT.usage;
  }

  // `--help`, `--version` and `doctor` never touch the network or a model.
  if (args.mode === "help") {
    io.stdout(HELP_TEXT);
    return 0;
  }
  if (args.mode === "version") {
    io.stdout(`${BROWSER_COMMAND} ${VERSION}\n`);
    return 0;
  }
  if (args.mode === "product" && args.productCommand === "doctor") {
    return runBrowserDoctor(io);
  }

  let modelCatalog: ModelCatalog | undefined;
  try {
    modelCatalog = await initializeModelCatalog({
      cacheFile: browserProduct.data.modelCatalogFile(),
      getCredentials: createCredentialResolver(),
      clientVersion: VERSION,
    });
    const configured = args.model ?? (await loadUserConfig(browserProduct.data.configFile())).model;
    const needsConfiguredModel =
      typeof configured === "string" && configured.length > 0 && !findModel(configured);
    if (args.mode !== "tui" || needsConfiguredModel) {
      const result = await modelCatalog.ensureFresh();
      for (const diagnostic of modelCatalogDiagnostics(result, {
        includePartialWarnings: args.mode !== "headless",
      })) {
        io.stderr(`${BROWSER_COMMAND}: ${diagnostic}\n`);
      }
    }

    switch (args.mode) {
      case "headless":
        return runHeadless(browserProduct, args, {}, io);
      case "rpc": {
        const runtime = await createCliSessionRuntime({
          cwd: process.cwd(),
          product: browserProduct,
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
          onDiagnostic: (message) => io.stderr(`${BROWSER_COMMAND}: ${message}\n`),
        });
        const { agent } = runtime;
        try {
          await runRpc(
            { write: io.stdout, lines: linesFrom(process.stdin) },
            {
              agent,
              runCommand: (text) =>
                runtime.commands.execute(text, {
                  inject: () => {},
                  print: () => {},
                  getModel: () => agent.modelRef,
                  setModel: (ref) => agent.setModel(ref),
                }),
              resolvePermission: runtime.resolvePermission,
              cancelPermissions: runtime.cancelPermissions,
              resumeSession: async (sessionId: string) => {
                const tree = await agent.sessionStore.load(sessionId);
                if (!tree) throw new Error(`Session not found: ${sessionId}`);
                agent.resume(tree);
              },
            },
          );
        } finally {
          runtime.cancelPermissions();
          // Ends the browser connection as well: the profile runtime is awaited
          // by the agent's shutdown, so an owned browser closes before exit.
          await agent.shutdown();
        }
        return 0;
      }
      default:
        return runInteractive(browserProduct, args, {
          ...(modelCatalog ? { modelCatalog } : {}),
        });
    }
  } catch (error) {
    io.stderr(`${BROWSER_COMMAND}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.error;
  } finally {
    modelCatalog?.stop();
  }
}

process.exitCode = await main();
