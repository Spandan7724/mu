#!/usr/bin/env bun
import {
  Agent,
  createCredentialResolver,
  findModel,
  loadMarkdownCommands,
  optionsFromProfile,
  registryWithCoreCommands,
  toCommand,
} from "mu";
import cliPackage from "../package.json";
import { HELP_TEXT, parseArgs } from "./args.ts";
import { withStoredCredentials } from "./auth.ts";
import { loadUserConfig, resolveCliModel } from "./config.ts";
import { loadBuiltInExtensions } from "./extensions.ts";
import { EXIT, runHeadless } from "./headless.ts";
import { runInteractive } from "./interactive.ts";
import { initializeModelCatalog, type ModelCatalog } from "./model-catalog.ts";
import { permissionModeFor, rulesForPermissionMode } from "./permissions.ts";
import {
  DEFAULT_PROFILE,
  profileOptionsFromArgs,
  resolveProfile,
  sessionStoreForProfile,
} from "./profiles.ts";
import { linesFrom, runRpc } from "./rpc.ts";
import { runSelfUpdate } from "./self-update.ts";

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

  let modelCatalog: ModelCatalog | undefined;
  if (args.mode === "tui" || args.mode === "headless" || args.mode === "rpc") {
    modelCatalog = await initializeModelCatalog({
      getCredentials: createCredentialResolver(),
      clientVersion: VERSION,
    });
    const configured = args.model ?? (await loadUserConfig()).model;
    const needsConfiguredModel =
      typeof configured === "string" && configured.length > 0 && !findModel(configured);
    if (args.mode !== "tui" || needsConfiguredModel) {
      const result = await modelCatalog.ensureFresh();
      if (!result.ok) {
        io.stderr(
          `mu: model discovery failed; using ${result.fallback} catalog: ${result.error}\n`,
        );
      } else if (result.cacheWarning) {
        io.stderr(`mu: ${result.cacheWarning}\n`);
      }
      if (result.ok) {
        for (const warning of result.warnings ?? []) {
          io.stderr(`mu: model discovery warning: ${warning}\n`);
        }
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
          },
          io,
        );
      case "headless":
        return runHeadless(args, {}, io);
      case "rpc": {
        // Permission asks are forwarded to the embedder, which answers with a
        // permission_reply op; nothing is auto-denied in RPC mode.
        const pending = new Map<string, (outcome: "allow" | "deny") => void>();
        const profile = await resolveProfile(
          args.profile ?? DEFAULT_PROFILE,
          profileOptionsFromArgs(args),
        );
        for (const diagnostic of profile.diagnostics ?? []) {
          io.stderr(`mu: instruction warning: ${diagnostic}\n`);
        }
        let resolved = withStoredCredentials(
          await optionsFromProfile(profile, await resolveCliModel(args.model)),
        );
        if (!resolved.session) {
          resolved = { ...resolved, session: await sessionStoreForProfile(profile) };
        }
        try {
          const mode = args.allowAll
            ? profile.permissionModes?.find((candidate) => candidate.id === "yolo")
            : permissionModeFor(profile, args.permissionMode);
          resolved = {
            ...resolved,
            permissions: args.allowAll
              ? [
                  ...(resolved.permissions ?? []),
                  { permission: "*", pattern: "*", action: "allow" },
                ]
              : rulesForPermissionMode(resolved.permissions, mode),
          };
        } catch (error) {
          io.stderr(`mu: ${error instanceof Error ? error.message : String(error)}\n`);
          return EXIT.usage;
        }
        const builtIns = await loadBuiltInExtensions(process.cwd(), resolved.extensions);
        for (const warning of builtIns.warnings) io.stderr(`mu: ${warning}\n`);
        const agent = new Agent({
          ...resolved,
          extensions: builtIns.host,
          onPermission: (request) =>
            new Promise<"allow" | "deny">((resolve) => pending.set(request.id, resolve)),
        });
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
        for (const command of profile.commands ?? []) commands.register(command);
        for (const command of builtIns.host.commands.list()) commands.register(command);
        for (const markdown of await loadMarkdownCommands({ projectDir: process.cwd() })) {
          commands.register(toCommand(markdown));
        }

        try {
          await runRpc(
            { write: io.stdout, lines: linesFrom(process.stdin) },
            {
              agent,
              runCommand: async (text) => {
                const result = await commands.execute(text, {
                  inject: () => {},
                  print: () => {},
                  getModel: () => agent.modelRef,
                  setModel: (ref) => agent.setModel(ref),
                });
                return result;
              },
              resolvePermission: (requestId, outcome) => {
                const resolve = pending.get(requestId);
                if (!resolve) return false;
                pending.delete(requestId);
                resolve(outcome);
                return true;
              },
            },
          );
        } finally {
          for (const [id, resolve] of pending) {
            resolve("deny");
            pending.delete(id);
          }
          await agent.shutdown();
        }
        return 0;
      }
      default:
        return runInteractive(args, {}, modelCatalog);
    }
  } finally {
    modelCatalog?.stop();
  }
}

process.exitCode = await main();
