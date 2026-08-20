import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentMessage,
  type AnyTool,
  exitNotification,
  ProcessManager,
  type Profile,
  type ProfileRuntime,
} from "@mu/core";
import { ShadowCheckpointProvider } from "./checkpoint.ts";
import {
  codingEnvironment,
  environmentMessage,
  InstructionLoader,
  type InstructionSettings,
} from "./context.ts";
import {
  CODING_PERMISSION_DEFAULTS,
  CODING_PERMISSION_MODES,
  instructionSettingsSchema,
  layerPermissions,
  loadProjectConfig,
  rememberAllow,
} from "./permissions.ts";
import { codingPrompt } from "./prompts.ts";
import { FileState } from "./state.ts";
import { bashTool } from "./tools/bash.ts";
import { editTool, lsTool, readTool, writeTool } from "./tools/files.ts";
import { shellSpawner, taskTools } from "./tools/tasks.ts";
import { TodoStore, todoTool } from "./tools/todo.ts";

export interface CodingProfileOptions {
  // Directory the session operates in. Defaults to the process's directory.
  root?: string;
  // Injected in tests so no real process is ever spawned.
  spawn?: Parameters<typeof bashTool>[0]["spawn"];
  spawner?: ConstructorParameters<typeof ProcessManager>[0];
  processEvents?: ConstructorParameters<typeof ProcessManager>[1];
  home?: string;
  instructions?: InstructionSettings;
  managedInstructionPaths?: string[];
}

export interface CodingProfile extends Profile {
  fileState: FileState;
  todos: TodoStore;
  processes: ProcessManager;
  instructions: InstructionLoader;
}

async function userInstructionSettings(
  home: string,
  onWarning: (message: string) => void,
): Promise<InstructionSettings> {
  const path = join(home, ".mu", "config.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      onWarning(`Invalid user config at ${path}: config must be an object`);
      return {};
    }
    const instructions = (parsed as Record<string, unknown>).instructions;
    if (instructions === undefined) return {};
    const result = instructionSettingsSchema.safeParse(instructions);
    if (!result.success) {
      onWarning(
        `Invalid user config at ${path}: ${result.error.issues
          .map((issue) => `instructions.${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
      return {};
    }
    const { enabled, fallbackFilenames, projectRootMarkers, imports, claudeRules } = result.data;
    return {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(fallbackFilenames !== undefined ? { fallbackFilenames } : {}),
      ...(projectRootMarkers !== undefined ? { projectRootMarkers } : {}),
      ...(imports !== undefined ? { imports } : {}),
      ...(claudeRules !== undefined ? { claudeRules } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      onWarning(
        `Invalid user config at ${path}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return {};
  }
}

export async function codingProfile(options: CodingProfileOptions = {}): Promise<CodingProfile> {
  const root = resolve(options.root ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const fileState = new FileState();
  const todos = new TodoStore();
  const configDiagnostics: string[] = [];
  const projectConfig = await loadProjectConfig(root, (message) => configDiagnostics.push(message));
  const instructionLoader = new InstructionLoader({
    root,
    home,
    ...(await userInstructionSettings(home, (message) => configDiagnostics.push(message))),
    ...(projectConfig.instructions ?? {}),
    ...(options.instructions ?? {}),
    ...(options.managedInstructionPaths ? { managedPaths: options.managedInstructionPaths } : {}),
  });
  await instructionLoader.reload();
  const deps = { root, state: fileState, instructions: instructionLoader };
  const processes = new ProcessManager(
    options.spawner ?? shellSpawner(root),
    options.processEvents ?? {},
  );

  const toolset: AnyTool[] = [
    readTool(deps),
    writeTool(deps),
    editTool(deps),
    lsTool(deps),
    bashTool({ root, processes, ...(options.spawn ? { spawn: options.spawn } : {}) }),
    todoTool(todos),
    ...taskTools(processes),
  ] as AnyTool[];

  const runtime: ProfileRuntime = {
    attach: (host) => {
      processes.setEvents({
        onStarted: (task) => {
          options.processEvents?.onStarted?.(task);
          host.emit({
            type: "task_started",
            taskId: task.id,
            command: task.command,
            background: true,
          });
        },
        onOutput: (taskId, chunk) => {
          options.processEvents?.onOutput?.(taskId, chunk);
          host.emit({ type: "task_output", taskId, chunk });
        },
        onExited: (task) => {
          options.processEvents?.onExited?.(task);
          host.emit({
            type: "task_exited",
            taskId: task.id,
            exitCode: task.exitCode,
            status: task.status === "killed" ? "killed" : "exited",
          });
          if (!task.detached) host.followUp(exitNotification(task));
        },
      });
    },
    resize: (cols, rows) => processes.resizeAll(cols, rows),
    stop: () => processes.stopAll(),
    shutdown: () => processes.killAll(),
  };
  let environmentPromise: Promise<Record<string, string>> | undefined;
  const environment = () => {
    if (!environmentPromise) environmentPromise = codingEnvironment(root);
    return environmentPromise;
  };

  return {
    name: "coding",
    toolset,
    promptFor: codingPrompt,
    permissionDefaults: layerPermissions(CODING_PERMISSION_DEFAULTS, projectConfig.permissions),
    permissionModes: CODING_PERMISSION_MODES,
    defaultPermissionMode: "default",
    rememberPermission: (permission, pattern) => rememberAllow(root, permission, pattern),
    environment,
    contextMessages: async (): Promise<AgentMessage[]> => [environmentMessage(await environment())],
    refreshContext: (messages, context) =>
      instructionLoader.refreshedMessages(messages, context.sessionId),
    diagnostics: [
      ...configDiagnostics,
      ...instructionLoader.snapshot.diagnostics.map((diagnostic) =>
        diagnostic.path ? `${diagnostic.path}: ${diagnostic.message}` : diagnostic.message,
      ),
    ],
    commands: [
      {
        name: "instructions",
        description: "Show or reload instruction files",
        run: async (ctx) => {
          const action = ctx.args.trim();
          if (action && action !== "reload") {
            return { handled: true, message: "Usage: /instructions [reload]" };
          }
          if (action === "reload") await instructionLoader.reload({ resetNested: true });
          return {
            handled: true,
            message: instructionLoader.formatStatus(
              action === "reload" ? "instructions reloaded" : "instructions",
            ),
          };
        },
      },
      {
        name: "reload",
        description: "Reload instruction files",
        run: async () => {
          await instructionLoader.reload({ resetNested: true });
          return {
            handled: true,
            message: instructionLoader.formatStatus("instructions reloaded"),
          };
        },
      },
    ],
    // What compaction must not lose: which files this session touched.
    carryoverExtractor: () => ({
      readFiles: fileState.readFiles(),
      modifiedFiles: fileState.modifiedFiles(),
      todos: todos.all(),
    }),
    scope: () => root.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    checkpointProvider: new ShadowCheckpointProvider({ root }),
    runtime,
    fileState,
    todos,
    processes,
    instructions: instructionLoader,
  };
}

export type { GitRunner, ShadowCheckpointOptions } from "./checkpoint.ts";
export { gitConfigNullDevice, ShadowCheckpointProvider } from "./checkpoint.ts";
export {
  codingEnvironment,
  contextMessages,
  DEFAULT_INSTRUCTION_FALLBACKS,
  DEFAULT_PROJECT_ROOT_MARKERS,
  discoverContextFiles,
  environmentMessage,
  type InstructionDiagnostic,
  InstructionLoader,
  type InstructionLoaderOptions,
  type InstructionSettings,
  type InstructionSnapshot,
  type InstructionSource,
} from "./context.ts";
export {
  CODING_PERMISSION_DEFAULTS,
  CODING_PERMISSION_MODES,
  layerPermissions,
  loadProjectConfig,
  rememberAllow,
} from "./permissions.ts";
export { codingPrompt } from "./prompts.ts";
export { shellCommand, terminateProcessTree, windowsTaskkillCommand } from "./shell.ts";
export {
  classifyShellCommand,
  isInspectionShellCommand,
  parseInspectionCommands,
  type ShellCommandClassification,
} from "./shell-inspection.ts";
export { FileState } from "./state.ts";
export { bashTool } from "./tools/bash.ts";
export { editTool, lsTool, readTool, resolveInRoot, writeTool } from "./tools/files.ts";
export { shellSpawner, taskTools } from "./tools/tasks.ts";
export type { TodoItem } from "./tools/todo.ts";
export { renderTodos, TodoStore, todoTool } from "./tools/todo.ts";
export { MAX_OUTPUT_CHARS, truncateOutput, withNotice } from "./truncate.ts";
